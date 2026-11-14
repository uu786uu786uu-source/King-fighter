import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import {
  ActivityIndicator, Alert, Animated, AppState, BackHandler, FlatList, Image, KeyboardAvoidingView, Modal,
  Platform, RefreshControl, ScrollView, Share, StatusBar, Switch, Text, TextInput, ToastAndroid,
  TouchableOpacity, View, useWindowDimensions
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from './src/lib/supabase';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import RNCallKeep from 'react-native-callkeep';
import mobileAds, { BannerAd, BannerAdSize, MaxAdContentRating, TestIds } from 'react-native-google-mobile-ads';
import { File, Paths } from 'expo-file-system';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as ExpoCrypto from 'expo-crypto';
import { DeviceIdentity, E2EE_MEDIA_PREFIX, E2EE_PREFIX, decryptCallKeyForDevice, decryptMediaForDevice, decryptMessageForDevice, encryptCallKeyForDevices, encryptMediaForDevices, encryptMessageForDevices, loadOrCreateDeviceIdentity } from './src/lib/e2ee';
import { AudioSession, AndroidAudioTypePresets, LiveKitRoom, VideoTrack, isTrackReference, registerGlobals, useLocalParticipant, useParticipants, useRoomContext, useRNE2EEManager, useTracks } from '@livekit/react-native';
import { Track } from 'livekit-client';

WebBrowser.maybeCompleteAuthSession();
registerGlobals();
Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowAlert:true,shouldPlaySound:true,shouldSetBadge:true,shouldShowBanner:true,shouldShowList:true})});

const CALL_BACKGROUND_TASK = 'guftin-incoming-call-v1';
const CALL_NOTIFICATION_CHANNEL_ID = 'guftin_call_ringtone_v1';
const CALL_RINGTONE_SOUND = 'guftin_call_ringtone.wav';

// LiveKit owns Android's process-wide communication audio mode during calls.
// Serialize start/stop operations and explicitly restore media playback mode
// after every disconnect so video/music apps are not left in call audio mode.
let guftinCallAudioStartPromise: Promise<void> | null = null;
let guftinCallAudioStopPromise: Promise<void> | null = null;
let guftinCallAudioSessionActive = false;
let activeGuftinCallRoom: { callId: string; disconnect: () => Promise<void>; disconnected: boolean } | null = null;
let activeGuftinCallRecordingController: { callId: string; stopAndSave: () => Promise<void> } | null = null;

const startGuftinCallAudioSession = async (): Promise<void> => {
  if (guftinCallAudioStopPromise) await guftinCallAudioStopPromise;
  if (guftinCallAudioStartPromise) return guftinCallAudioStartPromise;
  guftinCallAudioStartPromise = (async () => {
    if (Platform.OS === 'android') {
      await AudioSession.configureAudio({
        android: { audioTypeOptions: AndroidAudioTypePresets.communication }
      });
    }
    await AudioSession.startAudioSession();
    guftinCallAudioSessionActive = true;
  })().finally(() => {
    guftinCallAudioStartPromise = null;
  });
  return guftinCallAudioStartPromise;
};

const stopGuftinCallAudioSession = async (): Promise<void> => {
  if (guftinCallAudioStopPromise) return guftinCallAudioStopPromise;
  guftinCallAudioStopPromise = (async () => {
    if (guftinCallAudioStartPromise) {
      try { await guftinCallAudioStartPromise; } catch { /* start failure is handled by caller */ }
    }
    if (guftinCallAudioSessionActive) {
      try {
        await AudioSession.stopAudioSession();
      } catch (error: any) {
        console.warn('Guftin could not release call audio focus:', error?.message || error);
      } finally {
        guftinCallAudioSessionActive = false;
      }
    }
    if (Platform.OS === 'android') {
      try {
        await AudioSession.configureAudio({
          android: { audioTypeOptions: AndroidAudioTypePresets.media }
        });
      } catch (error: any) {
        console.warn('Guftin could not restore Android media audio mode:', error?.message || error);
      }
    }
  })().finally(() => {
    guftinCallAudioStopPromise = null;
  });
  return guftinCallAudioStopPromise;
};
const incomingCallNotificationId = (callId:string) => 'guftin-incoming-call-'+callId;
const dismissIncomingCallNotification = async (callId:string) => {
  const identifier=incomingCallNotificationId(callId);
  try{await Notifications.cancelScheduledNotificationAsync(identifier);}catch{}
  try{await Notifications.dismissNotificationAsync(identifier);}catch{}
};
let callKeepSetupPromise:Promise<void>|null=null;
const ensureCallKeepReady=()=>{
  if(Platform.OS!=='android')return Promise.resolve();
  if(!callKeepSetupPromise){
    callKeepSetupPromise=(async()=>{
      await RNCallKeep.setup({
        ios:{appName:'Guftin'},
        android:{
          alertTitle:'Enable Guftin call screen',
          alertDescription:'Allow Guftin to manage its own secure voice and video calls.',
          cancelButton:'Later',
          okButton:'Continue',
          additionalPermissions:[],
          // Self-managed CallKeep requires Guftin to display its own incoming-call
          // notification. The notification channel below carries the call ringtone.
          selfManaged:true,
          foregroundService:{
            channelId:'guftin-call-service',
            channelName:'Guftin active calls',
            notificationTitle:'Guftin call in progress'
          }
        }
      });
      await RNCallKeep.setAvailable(true);
    })().catch(error=>{
      callKeepSetupPromise=null;
      throw error;
    });
  }
  return callKeepSetupPromise;
};
const presentNativeIncomingCall = async (payload:any) => {
  const callId = typeof payload?.call_id === 'string' ? payload.call_id :
    typeof payload?.id === 'string' ? payload.id : '';
  if (!callId || Platform.OS !== 'android') return;
  const callerName = typeof payload?.caller_name === 'string' && payload.caller_name.trim()
    ? payload.caller_name.trim() : 'Guftin contact';
  const callType = payload?.call_type === 'video' ? 'video' : 'voice';
  const isGroupCall = payload?.call_scope === 'group';

  // Register with Telecom. In self-managed mode CallKeep signals
  // showIncomingCallUi and Guftin displays its own full-screen call surface.
  try {
    await ensureCallKeepReady();
    await RNCallKeep.displayIncomingCall(
      callId,
      String(payload?.caller_id || callerName),
      isGroupCall ? 'Group · '+callerName : callerName,
      'generic',
      callType === 'video'
    );
  } catch (error:any) {
    console.warn('Guftin Android self-managed call registration failed:', error?.message || error);
  }

  // Android 8+ takes sound and vibration from this dedicated channel.
  // The bundled sound is a ring cycle, routed through the ringtone audio usage.
  try {
    await configureGuftinNotificationChannels();
    const identifier=incomingCallNotificationId(callId);
    await dismissIncomingCallNotification(callId);
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: isGroupCall
          ? (callType === 'video' ? 'Incoming group video call' : 'Incoming group voice call')
          : (callType === 'video' ? 'Incoming video call' : 'Incoming voice call'),
        body: callerName + (isGroupCall ? ' started a group call. Tap Accept to join.' : ' is calling you.'),
        sound: CALL_RINGTONE_SOUND,
        priority: Notifications.AndroidNotificationPriority.MAX,
        sticky: true,
        autoDismiss: false,
        vibrate: [0,500,250,500,250,700],
        categoryIdentifier: 'guftin_incoming_call',
        data: {
          type: 'incoming_call',
          call_id: callId,
          caller_id: String(payload?.caller_id || ''),
          caller_name: callerName,
          call_type: callType,
          call_scope: isGroupCall ? 'group' : 'direct'
        }
      },
      trigger: { channelId: CALL_NOTIFICATION_CHANNEL_ID }
    });
  } catch (notificationError:any) {
    console.warn('Guftin ringtone notification failed:', notificationError?.message || notificationError);
  }
};

TaskManager.defineTask(CALL_BACKGROUND_TASK, async ({data,error}:any) => {
  if (error) {
    console.warn('Incoming-call background task failed:', error.message || error);
    return;
  }
  try {
    // Expo's NotificationTaskPayload wraps the remote JSON under "data".
    // Also support Notification objects and older dataString payloads.
    const taskData:any = data || {};
    const candidates = [
      taskData?.data?.dataString,
      taskData?.data,
      taskData?.data?.data,
      taskData?.data?.notification?.request?.content?.data,
      taskData?.notification?.request?.content?.data,
      taskData?.request?.content?.data,
      taskData?.dataString
    ];
    let payload:any = null;
    for (const candidate of candidates) {
      if (candidate == null) continue;
      try {
        const decoded = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
        const possible = decoded?.data && typeof decoded.data === 'object' ? decoded.data : decoded;
        if (possible?.type === 'incoming_call' && typeof possible.call_id === 'string') {
          payload = possible;
          break;
        }
      } catch {}
    }
    if (payload) {
      console.log('Guftin background incoming-call payload received.');
      await presentNativeIncomingCall(payload);
    } else {
      console.warn('Incoming-call task ran without a usable call payload. Keys:', Object.keys(taskData || {}));
    }
  } catch (taskError:any) {
    console.warn('Could not process incoming-call background payload:', taskError?.message || taskError);
  }
});
let callBackgroundTaskRegistration:Promise<void>|null=null;
const registerIncomingCallBackgroundTask=()=>{
  if(Platform.OS!=='android')return Promise.resolve();
  if(!callBackgroundTaskRegistration){
    callBackgroundTaskRegistration=(async()=>{
      try{
        const registered=await TaskManager.isTaskRegisteredAsync(CALL_BACKGROUND_TASK);
        if(!registered)await Notifications.registerTaskAsync(CALL_BACKGROUND_TASK);
      }catch(error:any){
        callBackgroundTaskRegistration=null;
        console.warn('Could not register incoming-call background task:',error?.message||error);
      }
    })();
  }
  return callBackgroundTaskRegistration;
};


let C:any = { ink:'#102b27', muted:'#82938e', green:'#087e6c', mint:'#e5f5ee', paper:'#f5f8f6', white:'#fff', line:'#e9efec', red:'#b94e48' };
const THEMES:any = {
  emerald:{ink:'#102b27',muted:'#82938e',green:'#087e6c',mint:'#e5f5ee',paper:'#f5f8f6',white:'#fff',line:'#e9efec',red:'#b94e48'},
  ocean:{ink:'#112b46',muted:'#71869e',green:'#2476d2',mint:'#e5f0ff',paper:'#f4f8ff',white:'#fff',line:'#e0e9f5',red:'#c94f68'},
  violet:{ink:'#2d2145',muted:'#8b7c9f',green:'#7950c8',mint:'#efe8ff',paper:'#f8f5ff',white:'#fff',line:'#ece4f7',red:'#c45073'},
  sunset:{ink:'#472b2b',muted:'#987c73',green:'#d45b42',mint:'#ffede4',paper:'#fff7f2',white:'#fff',line:'#f3e4dc',red:'#b63f4b'},
  night:{ink:'#edf3ff',muted:'#9baac0',green:'#77b9ff',mint:'#223d5d',paper:'#101a2b',white:'#1a2940',line:'#2a3b54',red:'#ff8894'}
};
type Chat = { id:string; name:string; avatar:string; avatarUrl?:string; color:string; last:string; time:string; unread:number; online:boolean; kind:string; lastAt:number; isOfficial?:boolean; isVerified?:boolean; isChannelOwner?:boolean; inviteCode?:string; isPublic?:boolean; ownerId?:string; description?:string; hasConversationActivity?:boolean; hasCallActivity?:boolean; pendingContactId?:string; hasPendingActivity?:boolean };
type Message = { id:string; conversation_id:string; sender_id:string|null; body:string|null; message_type:string; attachment_url?:string|null; created_at:string; mine:boolean; deleted_at?:string|null; pending?:boolean };
const sortInboxChats=(items:Chat[])=>items.slice().sort((a,b)=>(Number(!!b.isOfficial)-Number(!!a.isOfficial))||((Number(b.lastAt)||0)-(Number(a.lastAt)||0)));
const AUTH_REDIRECT_URL = 'kingchat://auth/callback';
const palette = ['#d49a91','#8796c7','#81ad98','#bd8aa8','#c4a47c','#9a91bd'];
// Supabase chat-media is currently configured for 50 MB per object. Keep encrypted
// uploads below that ceiling because authenticated encryption adds a small overhead.
const MAX_MEDIA_BYTES = 45 * 1024 * 1024;
const getDocumentMimeType=(name:string)=>{
  const ext=(name.split('.').pop()||'').toLowerCase();
  const map:Record<string,string>={
    pdf:'application/pdf',doc:'application/msword',
    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls:'application/vnd.ms-excel',
    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt:'application/vnd.ms-powerpoint',
    pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt:'text/plain',csv:'text/csv'
  };
  return map[ext]||'application/octet-stream';
};
const PERMISSION_SETUP_STEPS = [
  {key:'notifications',icon:'🔔',title:'Notifications',description:'Allow message alerts, status likes and views, and incoming voice/video call alerts while Guftin is in the background.'},
  {key:'microphone',icon:'🎙️',title:'Microphone',description:'Allow the microphone for voice messages and voice/video calls.'},
  {key:'camera',icon:'📷',title:'Camera',description:'Allow the camera so you can join video calls and share camera video.'},
  {key:'photos',icon:'🖼️',title:'Photos and videos',description:'Allow photo and video access when you choose a profile picture, share media, or post a status.'},
  {key:'autoSave',icon:'💾',title:'Save received media to Gallery',description:'Choose whether new photos and videos you receive should be saved automatically to your phone gallery.'}
] as const;
const getExpoProjectId=()=>(
  (Constants as any).easConfig?.projectId||
  (Constants.expoConfig as any)?.extra?.eas?.projectId||
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID
);
const configureGuftinNotificationChannels=async()=>{
  if(Platform.OS==='android'){
    await Notifications.setNotificationChannelAsync('messages',{
      name:'Messages',
      importance:Notifications.AndroidImportance.HIGH,
      vibrationPattern:[0,250,250,250],
      sound:'default',
      enableVibrate:true,
      showBadge:true
    });
    // Use a new ID so Android does not keep the old one-shot notification
    // sound settings from earlier Guftin builds.
    await Notifications.setNotificationChannelAsync(CALL_NOTIFICATION_CHANNEL_ID,{
      name:'Incoming calls',
      description:'Guftin voice and video calls with a dedicated ringtone',
      importance:Notifications.AndroidImportance.MAX,
      vibrationPattern:[0,500,250,500,250,700],
      sound:CALL_RINGTONE_SOUND,
      audioAttributes:{
        usage:Notifications.AndroidAudioUsage.NOTIFICATION_RINGTONE,
        contentType:Notifications.AndroidAudioContentType.SONIFICATION
      },
      enableVibrate:true,
      enableLights:true,
      lightColor:'#087e6c',
      showBadge:true
    });
  }
  await Notifications.setNotificationCategoryAsync('guftin_incoming_call',[
    {identifier:'accept_call',buttonTitle:'Accept',options:{opensAppToForeground:true}},
    {identifier:'decline_call',buttonTitle:'Decline',options:{opensAppToForeground:true,isDestructive:true}}
  ]);
};
const registerExpoPushToken = async (userId:string):Promise<string> => {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) throw new Error("Allow Guftin notifications in Android settings first.");
  const projectId = getExpoProjectId();
  if (!projectId) throw new Error("This build is not linked to an Expo project. Rebuild after setting EXPO_PUBLIC_EAS_PROJECT_ID.");
  await configureGuftinNotificationChannels();
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (!token.startsWith("ExponentPushToken[") || !token.endsWith("]")) {
    throw new Error("Expo returned an invalid push token. Check this app's Firebase FCM V1 credentials in EAS.");
  }
  const { error } = await supabase.from("kc_device_tokens").upsert({
    user_id: userId, token, platform: Platform.OS
  }, { onConflict: "token" });
  if (error) throw error;
  const { data: saved, error: verifyError } = await supabase.from("kc_device_tokens")
    .select("token").eq("user_id", userId).eq("token", token).maybeSingle();
  if (verifyError) throw verifyError;
  if (!saved?.token) throw new Error("Push token registration could not be confirmed in the server database.");
  return token;
};
const initials = (s:string) => s.trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || 'KC';
const colorFor = (s:string) => { let n=0; for(let i=0;i<s.length;i++) n=(n*31+s.charCodeAt(i))>>>0; return palette[n%palette.length]; };
const timeLabel = (value:string) => {
  if(!value) return '';
  const d=new Date(value), now=new Date();
  if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const yesterday=new Date(now); yesterday.setDate(now.getDate()-1);
  return d.toDateString()===yesterday.toDateString()?'Yesterday':d.toLocaleDateString([], {day:'numeric',month:'short'});
};
const isConnectivityFailure=(error:any)=>{
  const message=String(error?.message||error||'').toLowerCase();
  return error?.name==='TypeError'||/network request failed|failed to fetch|network is unreachable|connection refused|connection reset|timed out|timeout|offline|internet disconnected/.test(message);
};
function Btn({children,onPress,onLongPress,style,disabled}:any) {
  return <TouchableOpacity disabled={disabled} onPress={onPress} onLongPress={onLongPress} delayLongPress={420} activeOpacity={.75} style={[style,disabled?{opacity:.55}:null]}>{children}</TouchableOpacity>;
}
function Avatar({label,color,size=52,online=false,uri}:any) {
  return <View style={{width:size,height:size,borderRadius:size*.34,backgroundColor:color,alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
    {uri?<Image source={{uri}} style={{width:size,height:size,borderRadius:size*.34}}/>:<Text style={{color:'#fff',fontWeight:'900',fontSize:size*.25}}>{label}</Text>}
    {online?<View style={{position:'absolute',right:-1,bottom:-1,width:13,height:13,borderRadius:8,backgroundColor:'#29b77e',borderWidth:2,borderColor:C.white}}/>:null}
  </View>;
}
function Heading({children}:any) { return <Text style={{fontSize:25,fontWeight:'900',color:C.ink,letterSpacing:-.6}}>{children}</Text>; }

function CallControlButton({label,onPress,active=false,danger=false,disabled=false}:any) {
  return <Btn disabled={disabled} onPress={onPress} style={{
    flexGrow:1,flexBasis:'22%',minWidth:70,minHeight:54,paddingHorizontal:8,paddingVertical:9,
    alignItems:'center',justifyContent:'center',borderRadius:18,
    backgroundColor:danger?'#c43e48':active?'#e8c75c':'#244b45',
    borderWidth:1,borderColor:danger?'#f17a82':active?'#f4d782':'#47766c',
    opacity:disabled?0.45:1
  }}>
    <Text numberOfLines={2} style={{color:danger?'#fff':active?'#23362f':'#fff',fontSize:11,fontWeight:'900',textAlign:'center'}}>{label}</Text>
  </Btn>;
}

function CallRoomScreen({callId,callType,onHangUp,callScope,sessionUserId}:any) {
  const tracks=useTracks([Track.Source.Camera]);
  const participants=useParticipants();
  const {localParticipant,isMicrophoneEnabled,isCameraEnabled}=useLocalParticipant();
  const room=useRoomContext();
  const insets=useSafeAreaInsets();
  const {height:windowHeight}=useWindowDimensions();
  const [speakerOn,setSpeakerOn]=useState(false);
  const [controlBusy,setControlBusy]=useState(false);
  const [recordingBusy,setRecordingBusy]=useState(false);
  const [recording,setRecording]=useState<any>(null);
  const [consentPrompt,setConsentPrompt]=useState<any>(null);
  const roomHangUpInProgress=useRef(false);
  const recordingPollInProgress=useRef(false);
  const e2eeDisabledForRecording=useRef(false);
  const readyRecordingId=useRef('');
  const savedRecordingIds=useRef(new Set<string>());
  const recordingRef=useRef<any>(null);

  useEffect(()=>{
    const controller={callId,disconnect:()=>room.disconnect(),disconnected:false};
    activeGuftinCallRoom=controller;
    return ()=>{if(activeGuftinCallRoom===controller)activeGuftinCallRoom=null;};
  },[callId,room]);

  const setCallRecording=(value:any)=>{
    const next=value?.recording||null;
    recordingRef.current=next;
    setRecording(next);
  };
  const invokeRecording=useCallback(async(action:string,extra:any={})=>{
    const {data,error}=await supabase.functions.invoke('guftin-call-recording',{body:{action,call_id:callId,...extra}});
    if(error)throw error;
    if(data?.error)throw new Error(data.error);
    return data;
  },[callId]);

  const saveRecordingToPhone=useCallback(async(record:any)=>{
    if(!record?.storage_path||savedRecordingIds.current.has(record.id))return;
    savedRecordingIds.current.add(record.id);
    try{
      const {data,error}=await supabase.storage.from('call-recordings').download(record.storage_path);
      if(error||!data)throw error||new Error('The recording file was not returned by secure storage.');
      const bytes=new Uint8Array(await data.arrayBuffer());
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      const fileName='Guftin-'+(record.media_type==='video'?'Video':'Voice')+'-Call-'+stamp+'.mp4';
      const localFile=new File(Paths.document,fileName);
      if(localFile.exists)localFile.delete();
      localFile.create();
      await localFile.write(bytes);
      bytes.fill(0);
      await AsyncStorage.setItem('guftin-call-recording:'+sessionUserId+':'+record.id,localFile.uri);
      let savedToGallery=false;
      try{
        let permission=await MediaLibrary.getPermissionsAsync(false,['video']);
        if(!permission.granted)permission=await MediaLibrary.requestPermissionsAsync(false,['video']);
        if(permission.granted){await MediaLibrary.createAssetAsync(localFile.uri);savedToGallery=true;}
      }catch(mediaError:any){console.warn('Guftin recording gallery copy failed:',mediaError?.message||mediaError);}
      Alert.alert('Recording saved',savedToGallery
        ?'The call recording was saved to your phone gallery and Guftin storage.'
        :'The call recording was saved in Guftin storage on this phone. Allow video-library access to copy it to Gallery.');
    }catch(error:any){
      savedRecordingIds.current.delete(record.id);
      Alert.alert('Recording download failed',error?.message||'The recording remains in secure Guftin storage. Try again when internet is available.');
    }
  },[sessionUserId]);

  const setRecordingEncryption=useCallback(async(enabled:boolean)=>{
    const roomApi=room as any;
    if(typeof roomApi.setE2EEEnabled!=='function')throw new Error('This LiveKit build cannot change media encryption safely for recording.');
    await roomApi.setE2EEEnabled(enabled);
    e2eeDisabledForRecording.current=!enabled;
  },[room]);

  const refreshRecording=useCallback(async()=>{
    if(recordingPollInProgress.current)return;
    recordingPollInProgress.current=true;
    try{
      const data=await invokeRecording('status');
      const next=data?.recording||null;
      if(!next){setCallRecording(null);return;}
      recordingRef.current=next;
      setRecording(next);
      if(next.status==='awaiting_consent'&&data.own_decision==='pending')setConsentPrompt(next);
      else if(next.status!=='awaiting_consent')setConsentPrompt(null);

      if(next.status==='switching_to_recording'&&data.own_decision==='accepted'&&readyRecordingId.current!==next.id){
        readyRecordingId.current=next.id;
        try{
          await setRecordingEncryption(false);
          const readyData=await invokeRecording('ready',{recording_id:next.id});
          setCallRecording(readyData);
        }catch(error:any){
          readyRecordingId.current='';
          try{await setRecordingEncryption(true);}catch{}
          Alert.alert('Recording could not start',error?.message||'Encryption was not changed. The call remains private.');
          try{await invokeRecording('stop',{recording_id:next.id});}catch{}
        }
      }
      if(['complete','declined','cancelled','failed'].includes(next.status)){
        if(e2eeDisabledForRecording.current){
          try{await setRecordingEncryption(true);}
          catch(error:any){console.warn('Could not restore call encryption:',error?.message||error);}
        }
        setConsentPrompt(null);
        if(next.status==='complete')await saveRecordingToPhone(next);
      }
    }catch(error:any){console.warn('Guftin call recording status:',error?.message||error);}
    finally{recordingPollInProgress.current=false;}
  },[invokeRecording,setRecordingEncryption,saveRecordingToPhone]);

  const stopAndSaveRecording=useCallback(async()=>{
    const current=recordingRef.current;
    if(!current)return;
    if(['awaiting_consent','switching_to_recording','starting','recording'].includes(current.status)){
      const stopped=await invokeRecording('stop',{recording_id:current.id});
      setCallRecording(stopped);
    }
    if(e2eeDisabledForRecording.current){
      try{await setRecordingEncryption(true);}
      catch(error:any){console.warn('Could not restore E2EE before call exit:',error?.message||error);}
    }
    for(let attempt=0;attempt<18;attempt++){
      const data=await invokeRecording('status',{recording_id:current.id});
      const latest=data?.recording;
      if(latest){
        recordingRef.current=latest;setRecording(latest);
        if(latest.status==='complete'){await saveRecordingToPhone(latest);break;}
        if(['failed','cancelled','declined'].includes(latest.status))break;
      }
      await new Promise<void>(resolve=>setTimeout(resolve,1000));
    }
  },[invokeRecording,setRecordingEncryption,saveRecordingToPhone]);

  useEffect(()=>{
    const controller={callId,stopAndSave:stopAndSaveRecording};
    activeGuftinCallRecordingController=controller;
    return ()=>{if(activeGuftinCallRecordingController===controller)activeGuftinCallRecordingController=null;};
  },[callId,stopAndSaveRecording]);

  useEffect(()=>{
    void refreshRecording();
    const timer=setInterval(()=>void refreshRecording(),1800);
    return ()=>clearInterval(timer);
  },[refreshRecording]);

  const requestRecording=()=>{
    Alert.alert('Request call recording?',
      'Everyone in this call must agree. If all participants accept, end-to-end encryption will be temporarily turned off while LiveKit processes the recording. A red recording notice remains visible, and any participant can stop recording.',
      [{text:'Cancel',style:'cancel'},{text:'Request consent',onPress:()=>void (async()=>{
        setRecordingBusy(true);
        try{const data=await invokeRecording('request');setCallRecording(data);await refreshRecording();}
        catch(error:any){Alert.alert('Recording request failed',error?.message||'Please try again.');}
        finally{setRecordingBusy(false);}
      })()}]);
  };
  const answerRecordingConsent=async(decision:'accepted'|'declined')=>{
    if(!consentPrompt||recordingBusy)return;
    setRecordingBusy(true);
    try{
      const data=await invokeRecording('consent',{recording_id:consentPrompt.id,decision});
      setCallRecording(data);setConsentPrompt(null);
      if(decision==='declined')Alert.alert('Recording declined','No call recording will be created. End-to-end encryption remains on.');
    }catch(error:any){Alert.alert('Could not send your decision',error?.message||'Please try again.');}
    finally{setRecordingBusy(false);}
  };
  const openCallMenu=()=>{
    const state=recordingRef.current?.status;
    const activeRecording=!!state&&['awaiting_consent','switching_to_recording','starting','recording','stopping'].includes(state);
    Alert.alert('Call options','Recording always requires consent from every participant.',[
      ...(!activeRecording?[{text:'Start call recording',onPress:requestRecording}]:[]),
      ...(activeRecording?[{text:state==='recording'?'Stop recording':'Cancel recording request',style:'destructive' as const,onPress:()=>void (async()=>{
        setRecordingBusy(true);
        try{await stopAndSaveRecording();await refreshRecording();}
        catch(error:any){Alert.alert('Could not stop recording',error?.message||'Please try again.');}
        finally{setRecordingBusy(false);}
      })()}]:[]),
      {text:'Close',style:'cancel'}
    ]);
  };

  const handleHangUp=async()=>{
    if(roomHangUpInProgress.current)return;
    roomHangUpInProgress.current=true;
    await onHangUp?.();
  };
  const toggleMicrophone=async()=>{
    if(controlBusy)return;setControlBusy(true);
    try{await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);}
    catch(error:any){Alert.alert('Microphone control failed',error?.message||'Check microphone permission.');}
    finally{setControlBusy(false);}
  };
  const toggleCamera=async()=>{
    if(controlBusy)return;setControlBusy(true);
    try{await localParticipant.setCameraEnabled(!isCameraEnabled);}
    catch(error:any){Alert.alert('Camera control failed',error?.message||'Check camera permission.');}
    finally{setControlBusy(false);}
  };
  const toggleSpeaker=async()=>{
    if(controlBusy)return;setControlBusy(true);
    try{
      const outputs=await AudioSession.getAudioOutputs();
      const target=speakerOn?(outputs.includes('earpiece')?'earpiece':outputs.includes('default')?'default':null)
        :(outputs.includes('speaker')?'speaker':outputs.includes('force_speaker')?'force_speaker':null);
      if(!target){Alert.alert('Audio output unavailable','No compatible speaker or earpiece route was reported.');return;}
      await AudioSession.selectAudioOutput(target);setSpeakerOn(!speakerOn);
    }catch(error:any){Alert.alert('Speaker control failed',error?.message||'Could not change audio output.');}
    finally{setControlBusy(false);}
  };
  const flipCamera=async()=>{
    if(!isCameraEnabled){Alert.alert('Camera is off','Turn on the camera before switching lenses.');return;}
    try{
      const publication=localParticipant.getTrackPublication(Track.Source.Camera);
      const cameraTrack:any=publication?.track;
      const mediaTrack:any=cameraTrack?.mediaStreamTrack;
      if(typeof mediaTrack?._switchCamera==='function')await mediaTrack._switchCamera();
      else if(typeof cameraTrack?.switchCamera==='function')await cameraTrack.switchCamera();
      else Alert.alert('Camera switch unavailable','This device does not expose a camera-switch method.');
    }catch(error:any){Alert.alert('Could not switch camera',error?.message||'Please try again.');}
  };

  const recordingActive=!!recording&&['starting','recording','stopping','switching_to_recording'].includes(recording.status);
  const recordingLabel=recording?.status==='recording'?'RECORDING · ENCRYPTION TEMPORARILY OFF'
    :recording?.status==='awaiting_consent'?'WAITING FOR EVERYONE TO AGREE'
    :recording?.status==='switching_to_recording'?'PREPARING CONSENTED RECORDING':'SAVING RECORDING…';
  const videoTileHeight=Math.max(112,Math.min(220,Math.floor((windowHeight-insets.top-insets.bottom-330-(recordingActive?46:0))/Math.max(1,Math.ceil(tracks.length/2)))));

  return <View style={{flex:1,backgroundColor:'#081d1b'}}>
    <SafeAreaView edges={['top','left','right']} style={{flex:1,backgroundColor:'#102b27'}}>
      <StatusBar barStyle="light-content" backgroundColor="#102b27"/>
      <View style={{height:62,paddingHorizontal:15,flexDirection:'row',alignItems:'center',justifyContent:'space-between',borderBottomWidth:1,borderColor:'#2c5148'}}>
        <View style={{flex:1}}>
          <Text style={{fontSize:19,fontWeight:'900',color:'#fff',letterSpacing:-0.3}}>
            {callType==='video'?(callScope==='group'?'Group video call':'Video call'):(callScope==='group'?'Group voice call':'Voice call')}
          </Text>
          <Text style={{fontSize:11,color:'#b8d2c8',marginTop:3}}>{participants.length} participant{participants.length===1?'':'s'} connected</Text>
        </View>
        <Btn onPress={openCallMenu} style={{width:46,height:46,borderRadius:15,backgroundColor:'#1b4038',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#47766c'}}>
          <Text style={{fontSize:26,fontWeight:'900',color:'#fff'}}>⋮</Text>
        </Btn>
      </View>
      {recordingActive?<View style={{marginHorizontal:14,marginTop:10,paddingHorizontal:12,paddingVertical:9,borderRadius:12,backgroundColor:'#7a242b',borderWidth:1,borderColor:'#ec6a72',flexDirection:'row',alignItems:'center',gap:8}}>
        <View style={{width:8,height:8,borderRadius:4,backgroundColor:'#fff'}}/>
        <Text style={{fontSize:10,fontWeight:'900',color:'#fff',letterSpacing:0.5,flex:1}}>{recordingLabel}</Text>
      </View>:null}
      <View style={{flex:1,minHeight:0,paddingHorizontal:12,paddingTop:10}}>
        {callType==='video'?<FlatList
          data={tracks} keyExtractor={(item:any)=>item.publication?.trackSid||item.participant.identity}
          numColumns={2} columnWrapperStyle={{gap:9}} style={{flex:1}}
          contentContainerStyle={{gap:9,paddingBottom:12,flexGrow:1}}
          renderItem={({item}:any)=>isTrackReference(item)
            ?<View style={{flex:1,height:videoTileHeight,borderRadius:16,overflow:'hidden',backgroundColor:'#1b3832',borderWidth:1,borderColor:'#47766c'}}>
              <VideoTrack trackRef={item} style={{width:'100%',height:'100%'}}/>
              <View style={{position:'absolute',left:8,bottom:8,paddingHorizontal:8,paddingVertical:4,backgroundColor:'#061b18cc',borderRadius:8}}>
                <Text style={{fontSize:10,color:'#fff',fontWeight:'800'}} numberOfLines={1}>{item.participant?.name||item.participant?.identity||'Participant'}</Text>
              </View>
            </View>
            :<View style={{width:'48%',height:videoTileHeight,alignItems:'center',justifyContent:'center',backgroundColor:'#1b3832',borderRadius:16,borderWidth:1,borderColor:'#47766c'}}><Text style={{color:'#fff'}}>Camera is off</Text></View>}
          ListEmptyComponent={<View style={{flex:1,minHeight:160,alignItems:'center',justifyContent:'center',padding:26}}>
            <Text style={{fontSize:40,color:'#d4f1e5'}}>▣</Text>
            <Text style={{fontSize:13,fontWeight:'800',color:'#fff',marginTop:12}}>Waiting for video participants…</Text>
          </View>}
        />:<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:24}}>
          <View style={{width:154,height:154,borderRadius:77,backgroundColor:'#174438',borderWidth:2,borderColor:'#49b58b',alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:66,color:'#fff'}}>☎</Text></View>
          <Text style={{color:'#f3fff8',marginTop:18,fontSize:20,fontWeight:'900'}}>Secure voice connection</Text>
          <Text style={{color:'#a9c8ba',marginTop:7,fontSize:12,textAlign:'center',lineHeight:18}}>Your microphone, speaker and recording controls stay available below.</Text>
        </View>}
      </View>
    </SafeAreaView>
    <SafeAreaView edges={['bottom']} style={{backgroundColor:'#0c211e',borderTopWidth:1,borderColor:'#2b5348',paddingHorizontal:12,paddingTop:10,paddingBottom:10}}>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8,justifyContent:'space-between'}}>
        <CallControlButton label={isMicrophoneEnabled?'🎙  Mic on':'🎙  Mic muted'} active={!isMicrophoneEnabled} disabled={controlBusy} onPress={()=>void toggleMicrophone()}/>
        <CallControlButton label={speakerOn?'🔊  Speaker on':'🔊  Speaker'} active={speakerOn} disabled={controlBusy} onPress={()=>void toggleSpeaker()}/>
        {callType==='video'?<>
          <CallControlButton label={isCameraEnabled?'▣  Camera on':'▣  Camera off'} active={!isCameraEnabled} disabled={controlBusy} onPress={()=>void toggleCamera()}/>
          <CallControlButton label="↻  Flip camera" disabled={controlBusy||!isCameraEnabled} onPress={()=>void flipCamera()}/>
        </>:null}
        <CallControlButton label={recordingBusy?'Recording…':'⋮  Call options'} active={recordingActive} disabled={recordingBusy} onPress={openCallMenu}/>
      </View>
      <Btn onPress={()=>void handleHangUp()} style={{marginTop:9,minHeight:56,borderRadius:17,backgroundColor:'#d94350',borderWidth:1,borderColor:'#fa7b83',alignItems:'center',justifyContent:'center',elevation:5}}>
        <Text style={{fontSize:16,color:'#fff',fontWeight:'900'}}>End call</Text>
      </Btn>
    </SafeAreaView>
    <Modal visible={!!consentPrompt} transparent animationType="fade" onRequestClose={()=>{}}>
      <View style={{flex:1,backgroundColor:'#000b',justifyContent:'center',padding:22}}>
        <View style={{backgroundColor:'#f6fbf8',borderRadius:24,padding:22,borderWidth:1,borderColor:'#82cfb3'}}>
          <Text style={{fontSize:22,fontWeight:'900',color:'#143c31'}}>Call recording request</Text>
          <Text style={{fontSize:13,color:'#36584d',lineHeight:20,marginTop:12}}>
            Another participant wants to record this {callType==='video'?'video':'voice'} call. If you accept, end-to-end encryption will be temporarily turned off for everyone while LiveKit processes the recording. The recording will be saved on each participant's phone.
          </Text>
          <Text style={{fontSize:12,color:'#9a3138',fontWeight:'900',marginTop:12}}>Recording cannot start unless every participant accepts.</Text>
          <View style={{flexDirection:'row',gap:10,marginTop:22}}>
            <Btn disabled={recordingBusy} onPress={()=>void answerRecordingConsent('declined')} style={{flex:1,paddingVertical:14,borderRadius:13,backgroundColor:'#fbe7e8',alignItems:'center'}}><Text style={{color:'#a42f39',fontWeight:'900'}}>Decline</Text></Btn>
            <Btn disabled={recordingBusy} onPress={()=>void answerRecordingConsent('accepted')} style={{flex:1,paddingVertical:14,borderRadius:13,backgroundColor:'#16845f',alignItems:'center'}}>
              {recordingBusy?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>Accept</Text>}
            </Btn>
          </View>
        </View>
      </View>
    </Modal>
  </View>;
}

function CallLobbyScreen({call,mode,onAccept,onDecline,onCancel,busy}:any) {
  const incoming=mode==='incoming';
  const callType=call?.call_type||call?.callType||'voice';
  const insets=useSafeAreaInsets();
  const ringPulse=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    const animation=Animated.loop(Animated.sequence([
      Animated.timing(ringPulse,{toValue:1,duration:1450,useNativeDriver:true}),
      Animated.timing(ringPulse,{toValue:0,duration:0,useNativeDriver:true})
    ]));
    animation.start();return ()=>animation.stop();
  },[ringPulse]);
  const pulseScale=ringPulse.interpolate({inputRange:[0,1],outputRange:[1,1.48]});
  const pulseOpacity=ringPulse.interpolate({inputRange:[0,1],outputRange:[0.48,0]});
  const isVideo=callType==='video';
  const isGroup=(call?.call_scope||call?.callScope)==='group';
  const displayName=incoming?(call?.caller_name||'Guftin contact'):(call?.contact_name||call?.caller_name||'Guftin contact');
  const statusLabel=busy?'Preparing secure connection…':incoming?(isVideo?'Incoming video call':'Incoming voice call'):(isVideo?'Calling by video…':'Calling…');
  return <SafeAreaView edges={['top','left','right','bottom']} style={{flex:1,backgroundColor:'#071b18'}}>
    <StatusBar barStyle="light-content" backgroundColor="#071b18"/>
    <View style={{flex:1,paddingHorizontal:22,paddingTop:16,paddingBottom:Math.max(insets.bottom,18)+8}}>
      <View style={{alignItems:'center'}}>
        <Text style={{fontSize:18,fontWeight:'900',letterSpacing:4,color:'#f4fff9'}}>GUFTIN</Text>
        <View style={{marginTop:8,paddingHorizontal:13,paddingVertical:6,borderRadius:20,backgroundColor:'#123d32',borderWidth:1,borderColor:'#236451'}}>
          <Text style={{fontSize:9,fontWeight:'900',letterSpacing:2,color:'#9de5c5'}}>PRIVATE {isVideo?'VIDEO':'VOICE'} CALL</Text>
        </View>
      </View>
      <View style={{alignItems:'center',justifyContent:'center',flex:1,paddingVertical:12}}>
        <View style={{width:190,height:190,alignItems:'center',justifyContent:'center'}}>
          <Animated.View style={{position:'absolute',width:164,height:164,borderRadius:82,borderWidth:2,borderColor:'#49d7a0',opacity:pulseOpacity,transform:[{scale:pulseScale}]}}/>
          <View style={{width:148,height:148,borderRadius:74,borderWidth:2,backgroundColor:'#0b2a23',borderColor:'#286a55',alignItems:'center',justifyContent:'center',shadowColor:'#31c48d',shadowOpacity:0.28,shadowRadius:25,elevation:14,overflow:'hidden'}}>
            {call?.contact_avatar_url||call?.avatar_url?<Image source={{uri:call.contact_avatar_url||call.avatar_url}} style={{width:138,height:138,borderRadius:69}}/>
              :<View style={{width:138,height:138,borderRadius:69,borderWidth:2,borderColor:'#3a9c79',backgroundColor:'#164638',alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:49,fontWeight:'900',color:'#f5fff9'}}>{initials(displayName)}</Text></View>}
          </View>
        </View>
        <Text numberOfLines={2} style={{fontSize:28,fontWeight:'900',color:'#fff',textAlign:'center',marginTop:18,letterSpacing:-0.6}}>{displayName}</Text>
        <Text style={{fontSize:13,color:'#a8cfc0',marginTop:8,fontWeight:'700'}}>{isGroup?'Group conversation':isVideo?'Guftin video call':'Guftin voice call'}</Text>
        <Text style={{fontSize:10,color:'#78bba0',marginTop:7,letterSpacing:1.2,fontWeight:'800'}}>END-TO-END ENCRYPTED</Text>
        <View style={{marginTop:18,paddingHorizontal:17,paddingVertical:10,borderRadius:18,backgroundColor:'#10382d',borderWidth:1,borderColor:'#245c49',flexDirection:'row',alignItems:'center',gap:9}}>
          <View style={{width:7,height:7,borderRadius:4,backgroundColor:busy?'#e8c46a':'#52dda2'}}/>
          <Text style={{fontSize:12,color:'#d9f3e7',fontWeight:'800'}}>{statusLabel}</Text>
        </View>
        <Text style={{fontSize:11,color:'#789f90',marginTop:13,textAlign:'center',lineHeight:17}}>{incoming?'Answer to connect, or decline this call.':'Waiting for the other person to answer.'}</Text>
      </View>
      {incoming?<View style={{flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingTop:10}}>
        <View style={{alignItems:'center',gap:9}}>
          <Btn disabled={busy} onPress={onDecline} style={{width:72,height:72,borderRadius:36,backgroundColor:'#d94350',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#fa7b83',opacity:busy?0.5:1}}><Text style={{fontSize:34,color:'#fff',fontWeight:'500'}}>×</Text></Btn>
          <Text style={{fontSize:12,color:'#ffd9dc',fontWeight:'800'}}>Decline</Text>
        </View>
        <View style={{alignItems:'center',gap:9}}>
          <Btn disabled={busy} onPress={onAccept} style={{width:78,height:78,borderRadius:39,backgroundColor:'#18a96f',alignItems:'center',justifyContent:'center',borderWidth:2,borderColor:'#82edbd',elevation:10,opacity:busy?0.5:1}}><Text style={{fontSize:31,color:'#fff'}}>{isVideo?'▣':'☎'}</Text></Btn>
          <Text style={{fontSize:12,color:'#bff7d9',fontWeight:'900'}}>Answer</Text>
        </View>
      </View>:<View style={{alignItems:'center',paddingTop:10}}>
        <Btn onPress={onCancel} style={{width:78,height:78,borderRadius:39,backgroundColor:'#d94350',alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#fa7b83',elevation:7}}><Text style={{fontSize:34,color:'#fff',fontWeight:'500'}}>×</Text></Btn>
        <Text style={{fontSize:12,color:'#ffd9dc',fontWeight:'800',marginTop:9}}>Cancel call</Text>
      </View>}
    </View>
  </SafeAreaView>;
}

function SecureLiveKitRoom({liveCall,onDisconnected,onHangUp,onConnected,sessionUserId}:any) {
  // One group-call key is wrapped separately to every registered participant device.
  const {e2eeManager}=useRNE2EEManager({sharedKey:liveCall.e2eeKey});
  const [audioReady,setAudioReady]=useState(false);

  useEffect(()=>{
    let mounted=true;
    void startGuftinCallAudioSession().then(()=>{
      if(mounted)setAudioReady(true);
      else void stopGuftinCallAudioSession();
    }).catch((error:any)=>{
      console.warn('Guftin call audio session could not start:',error?.message||error);
      if(mounted){
        Alert.alert('Call audio unavailable','Guftin could not initialize the phone audio session. The call will be closed safely.');
        void stopGuftinCallAudioSession().finally(()=>onHangUp?.());
      }
    });
    return ()=>{
      mounted=false;
      void stopGuftinCallAudioSession();
    };
  },[]);

  if(!audioReady){
    return <View style={{flex:1,alignItems:'center',justifyContent:'center',backgroundColor:'#071c1b',padding:24}}>
      <ActivityIndicator color="#65d6b2" size="large"/>
      <Text style={{color:'#fff',fontWeight:'700',marginTop:14}}>Preparing secure call audio…</Text>
    </View>;
  }

  return <LiveKitRoom
    serverUrl={liveCall.serverUrl}
    token={liveCall.token}
    connect={true}
    audio={true}
    video={liveCall.callType==='video'}
    options={{e2ee:{e2eeManager}}}
    onConnected={onConnected}
    onDisconnected={async()=>{
      const roomController=activeGuftinCallRoom;
      if(roomController && roomController.callId===liveCall.id){roomController.disconnected=true;}
      await stopGuftinCallAudioSession();
      await onDisconnected?.();
    }}
    onEncryptionError={(error:any)=>Alert.alert('Call encryption error',error?.message||'Media encryption could not be started.')}
  >
    <CallRoomScreen callId={liveCall.id} callType={liveCall.callType} callScope={liveCall.callScope} sessionUserId={sessionUserId} onHangUp={onHangUp}/>
  </LiveKitRoom>;
}
function AudioBubble({uri}:{uri:string}) {
  const [playing,setPlaying]=useState(false);
  const sound=useRef<Audio.Sound|null>(null);
  useEffect(()=>()=>{if(sound.current)void sound.current.unloadAsync();},[]);
  const toggle=async()=>{
    try{
      if(!sound.current){const created=await Audio.Sound.createAsync({uri},{shouldPlay:true});sound.current=created.sound;setPlaying(true);created.sound.setOnPlaybackStatusUpdate((status:any)=>{if(status.didJustFinish)setPlaying(false);});}
      else {const status=await sound.current.getStatusAsync();if(status.isLoaded&&status.isPlaying){await sound.current.pauseAsync();setPlaying(false);}else{await sound.current.playAsync();setPlaying(true);}}
    }catch(e:any){Alert.alert('Audio playback failed',e?.message||'Could not play this voice message.');}
  };
  return <Btn onPress={()=>void toggle()} style={{flexDirection:'row',alignItems:'center',gap:10,minWidth:175,paddingVertical:5}}><Text style={{fontSize:20,color:C.green}}>{playing?'Ⅱ':'▶'}</Text><Text style={{color:C.ink,fontWeight:'800'}}>Voice message</Text></Btn>;
}
function VideoBubble({uri}:{uri:string}) {
  const player=useVideoPlayer(uri);
  return <VideoView player={player} style={{width:260,height:210,borderRadius:12}} nativeControls allowsFullscreen contentFit="contain"/>;
}

function VerifiedBadge({label='Verified account'}:{label?:string}) {
  return <Text accessibilityRole="image" accessibilityLabel={label} style={{color:'#2387e8',fontWeight:'900',fontSize:14,marginLeft:3}}>✓</Text>;
}

function GuftinApp() {
  const insets=useSafeAreaInsets();
  const [tab,setTab]=useState('Chats');
  const activeTabRef=useRef(tab);
  activeTabRef.current=tab;
  const [session,setSession]=useState<any>(null);
  const [authRestoring,setAuthRestoring]=useState(true);
  const [profile,setProfile]=useState<any>(null);
  const [profileReady,setProfileReady]=useState(false);
  const [chats,setChats]=useState<Chat[]>([]);
  const [active,setActive]=useState<Chat|null>(null);
  const [pendingNotificationConversation,setPendingNotificationConversation]=useState<string|null>(null);
  const [messages,setMessages]=useState<Record<string,Message[]>>({});
  const [peerLastReadAt,setPeerLastReadAt]=useState<string|null>(null);
  const activeConversationIdRef=useRef<string|null>(null);
  const chatMessagesListRef=useRef<FlatList<Message>|null>(null);
  const loadMessagesRef=useRef<((id:string)=>Promise<void>)|null>(null);
  const flushPendingMessagesRef=useRef<(()=>Promise<void>)|null>(null);
  const flushPendingMediaRef=useRef<(()=>Promise<void>)|null>(null);
  const flushingPendingMessages=useRef(false);
  const flushingPendingMedia=useRef(false);
  const onlineRef=useRef(true);
  useEffect(()=>{
    void registerIncomingCallBackgroundTask();
  },[]);
  useEffect(()=>{
    activeConversationIdRef.current=active?.id||null;
  },[active?.id]);
  const [draft,setDraft]=useState('');
  const [search,setSearch]=useState('');
  const [searching,setSearching]=useState(false);
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [sending,setSending]=useState(false);
  const [mediaPreparing,setMediaPreparing]=useState(false);
  const [statuses,setStatuses]=useState<any[]>([]);
  const [statusComposer,setStatusComposer]=useState(false);
  const [statusText,setStatusText]=useState('');
  const [statusAsset,setStatusAsset]=useState<any>(null);
  const [profileAvatarUrl,setProfileAvatarUrl]=useState('');
  const [profileAvatarPath,setProfileAvatarPath]=useState('');
  const [profileUploading,setProfileUploading]=useState(false);
  const [recording,setRecording]=useState<Audio.Recording|null>(null);
  const [recordingBusy,setRecordingBusy]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [showReadReceipts,setShowReadReceipts]=useState(true);
  const [mediaAutoDownload,setMediaAutoDownload]=useState(false);
  const [onlineVisibility,setOnlineVisibility]=useState(true);
  const [autoSync,setAutoSync]=useState(true);
  const [syncIntervalSeconds,setSyncIntervalSeconds]=useState(15);
  const [settingsLoaded,setSettingsLoaded]=useState(false);
  const [publishingStatus,setPublishingStatus]=useState(false);
  const [deviceIdentity,setDeviceIdentity]=useState<DeviceIdentity|null>(null);
  const [e2eeStatus,setE2eeStatus]=useState<'loading'|'ready'|'error'>('loading');
  const [incomingCall,setIncomingCall]=useState<any>(null);
  const [pendingCallAccept,setPendingCallAccept]=useState<any>(null);
  const [outgoingCall,setOutgoingCall]=useState<any>(null);
  const [liveCall,setLiveCall]=useState<any>(null);
  const [callBusy,setCallBusy]=useState(false);
  const [callHistory,setCallHistory]=useState<any[]>([]);
  const [adsReady,setAdsReady]=useState(false);
  const [pushEnabled,setPushEnabled]=useState(false);
  const [pushBusy,setPushBusy]=useState(false);
  const [pushPermissionReady,setPushPermissionReady]=useState(false);
  const [permissionSetupVisible,setPermissionSetupVisible]=useState(false);
  const [permissionSetupStep,setPermissionSetupStep]=useState(0);
  const [permissionSetupBusy,setPermissionSetupBusy]=useState(false);
  const [permissionSetupAutoSave,setPermissionSetupAutoSave]=useState(true);
  const [permissionSetupNotice,setPermissionSetupNotice]=useState('');
  const [themeName,setThemeName]=useState('emerald');
  const [deliveredByMessage,setDeliveredByMessage]=useState<Record<string,string>>({});
  const hiddenMessageIds=useRef(new Set<string>());
  const clearingConversationIds=useRef(new Set<string>());
  const clearGenerationByConversation=useRef(new Map<string,number>());
  const handledNotificationResponses=useRef(new Set<string>());
  const joiningCallIds=useRef(new Set<string>());
  const endingCallIds=useRef(new Set<string>());
  Object.assign(C,THEMES[themeName]||THEMES.emerald);

  const [authBusy,setAuthBusy]=useState(false);
  const [authMode,setAuthMode]=useState<'login'|'signup'>('signup');
  const [fullName,setFullName]=useState('');
  const [username,setUsername]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [authError,setAuthError]=useState('');

  const [addOpen,setAddOpen]=useState(false);
  const [contactUsername,setContactUsername]=useState('');
  const [adding,setAdding]=useState(false);
  const [groupCreateOpen,setGroupCreateOpen]=useState(false);
  const [groupName,setGroupName]=useState('');
  const [groupContacts,setGroupContacts]=useState<any[]>([]);
  const [selectedGroupIds,setSelectedGroupIds]=useState<string[]>([]);
  const [groupContactsLoading,setGroupContactsLoading]=useState(false);
  const [groupCreating,setGroupCreating]=useState(false);
  const [channels,setChannels]=useState<any[]>([]);
  const [channelsLoading,setChannelsLoading]=useState(false);
  const [channelCreateOpen,setChannelCreateOpen]=useState(false);
  const [channelJoinOpen,setChannelJoinOpen]=useState(false);
  const [channelTitle,setChannelTitle]=useState('');
  const [channelDescription,setChannelDescription]=useState('');
  const [channelPublic,setChannelPublic]=useState(true);
  const [channelInviteCode,setChannelInviteCode]=useState('');
  const [channelBusy,setChannelBusy]=useState(false);
  const [chatDetailsOpen,setChatDetailsOpen]=useState(false);
  const [chatDetails,setChatDetails]=useState<any>(null);
  const [chatDetailsLoading,setChatDetailsLoading]=useState(false);

  const [profileName,setProfileName]=useState('');
  const [profileUsername,setProfileUsername]=useState('');
  const [about,setAbout]=useState('');
  const [savingProfile,setSavingProfile]=useState(false);
  const handledAuthUrls=useRef(new Set<string>());
  const signedMediaCache=useRef(new Map<string,{url:string;expiresAt:number}>());
  const getSignedMediaUrl=useCallback(async(path:string):Promise<string|null>=>{
    const cached=signedMediaCache.current.get(path);
    if(cached&&cached.expiresAt>Date.now()+60000)return cached.url;
    const {data,error}=await supabase.storage.from('chat-media').createSignedUrl(path,60*60*24);
    if(error||!data?.signedUrl)return null;
    signedMediaCache.current.set(path,{url:data.signedUrl,expiresAt:Date.now()+23*60*60*1000});
    return data.signedUrl;
  },[]);

  useEffect(()=>{
    let active=true;
    AsyncStorage.getItem('guftin-preferences').then(raw=>{
      if(!active)return;
      if(raw){
        try{
          const saved=JSON.parse(raw);
          if(typeof saved.showReadReceipts==='boolean')setShowReadReceipts(saved.showReadReceipts);
          if(typeof saved.onlineVisibility==='boolean')setOnlineVisibility(saved.onlineVisibility);
          if(typeof saved.autoSync==='boolean')setAutoSync(saved.autoSync);
          if([15,30,60].includes(saved.syncIntervalSeconds))setSyncIntervalSeconds(saved.syncIntervalSeconds);
          if(typeof saved.mediaAutoDownload==='boolean')setMediaAutoDownload(saved.mediaAutoDownload);
          if(['emerald','ocean','violet','sunset','night'].includes(saved.themeName))setThemeName(saved.themeName);
        }catch{ /* Ignore an outdated or malformed local preferences record. */ }
      }
      setSettingsLoaded(true);
    }).catch(()=>{if(active)setSettingsLoaded(true);});
    return ()=>{active=false;};
  },[]);

  useEffect(()=>{
    if(!settingsLoaded)return;
    void AsyncStorage.setItem('guftin-preferences',JSON.stringify({showReadReceipts,onlineVisibility,autoSync,syncIntervalSeconds,mediaAutoDownload,themeName}));
  },[settingsLoaded,showReadReceipts,onlineVisibility,autoSync,syncIntervalSeconds,mediaAutoDownload,themeName]);

  // Create Android notification channels at startup; request OS permissions only
  // after sign-in and profile completion in the permission walkthrough below.
  useEffect(()=>{
    let mounted=true;
    void configureGuftinNotificationChannels()
      .catch(error=>console.warn('Notification channel setup:',error?.message||error))
      .finally(()=>{if(mounted)setPushPermissionReady(true);});
    return ()=>{mounted=false;};
  },[]);

  const completeAuthUrl=useCallback(async(url:string)=>{
    if(!url||handledAuthUrls.current.has(url)) return;
    handledAuthUrls.current.add(url);
    const query=url.includes('?')?url.split('?')[1].split('#')[0]:'';
    const fragment=url.split('#')[1]||'';
    const read=(source:string,key:string)=>{
      const match=source.match(new RegExp('(?:^|&)'+key+'=([^&]+)'));
      return match?decodeURIComponent(match[1].replace(/\+/g,' ')):'';
    };
    const code=read(query,'code');
    const tokenHash=read(query,'token_hash');
    const type=read(query,'type');
    if(code){
      const {error}=await supabase.auth.exchangeCodeForSession(code);
      if(error) setAuthError(error.message);
      return;
    }
    if(tokenHash&&type){
      const {error}=await supabase.auth.verifyOtp({token_hash:tokenHash,type:type as any});
      if(error) setAuthError(error.message);
      return;
    }
    const access_token=read(fragment,'access_token');
    const refresh_token=read(fragment,'refresh_token');
    if(access_token&&refresh_token){
      const {error}=await supabase.auth.setSession({access_token,refresh_token});
      if(error) setAuthError(error.message);
      return;
    }
    const description=read(query,'error_description')||read(fragment,'error_description');
    if(description) setAuthError(description);
  },[]);

  useEffect(()=>{
    let mounted=true;
    void supabase.auth.getSession().then(({data,error})=>{
      if(!mounted)return;
      if(error)console.warn('Session restore:',error.message);
      setSession(data.session);
    }).catch(error=>console.warn('Session restore failed:',error?.message||error))
      .finally(()=>{if(mounted)setAuthRestoring(false);});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>{
      if(!mounted)return;
      setSession(next);
      setAuthRestoring(false);
    });
    const linkSub=Linking.addEventListener('url',({url})=>{void completeAuthUrl(url);});
    Linking.getInitialURL().then(url=>{if(url) void completeAuthUrl(url);});
    return ()=>{mounted=false;subscription.unsubscribe();linkSub.remove();};
  },[completeAuthUrl]);

  // Show the walkthrough once for each signed-in account on this phone.
  useEffect(()=>{
    let active=true;
    if(!session?.user?.id){
      setPermissionSetupVisible(false);
      return;
    }
    if(!profileReady || profile?.id!==session.user.id || !profile?.username || !settingsLoaded || !pushPermissionReady)return;
    const key='guftin-permission-setup-v1:'+session.user.id;
    void AsyncStorage.getItem(key).then(done=>{
      if(!active)return;
      if(done!=='completed'){
        setPermissionSetupStep(0);
        setPermissionSetupAutoSave(true);
        setPermissionSetupNotice('');
        setPermissionSetupVisible(true);
      }else{
        setPermissionSetupVisible(false);
      }
    }).catch(error=>{
      console.warn('Permission setup status:',error?.message||error);
      if(active){setPermissionSetupStep(0);setPermissionSetupVisible(true);}
    });
    return ()=>{active=false;};
  },[session?.user?.id,profile?.id,profile?.username,profileReady,settingsLoaded,pushPermissionReady]);

  useEffect(()=>{
    const onHardwareBack=()=>{
      if(liveCall){
        ToastAndroid.show('End the call with the in-app button first.',ToastAndroid.SHORT);
        return true;
      }
      if(statusComposer){setStatusComposer(false);return true;}
      if(addOpen){setAddOpen(false);return true;}
      if(settingsOpen){setSettingsOpen(false);return true;}
      if(active){setActive(null);return true;}
      if(searching){setSearching(false);setSearch('');return true;}
      if(tab!=='Chats'){setTab('Chats');return true;}
      ToastAndroid.show('Guftin is open. Use Home to keep it running in background.',ToastAndroid.SHORT);
      return true;
    };
    const subscription=BackHandler.addEventListener('hardwareBackPress',onHardwareBack);
    return ()=>subscription.remove();
  },[liveCall,statusComposer,addOpen,settingsOpen,active,searching,tab]);

  useEffect(()=>{
    let cancelled=false;
    if(!session){
      setDeviceIdentity(null);
      setE2eeStatus('loading');
      return;
    }
    setE2eeStatus('loading');
    void loadOrCreateDeviceIdentity(supabase,session.user.id)
      .then(identity=>{
        if(!cancelled){
          setDeviceIdentity(identity);
          setE2eeStatus('ready');
        }
      })
      .catch(error=>{
        console.warn('E2EE device setup failed:',error?.message||error);
        if(!cancelled){
          setDeviceIdentity(null);
          setE2eeStatus('error');
        }
      });
    return ()=>{cancelled=true;};
  },[session]);

  const loadProfile=useCallback(async()=>{
    if(!session) return;
    const profileCacheKey='guftin-cache-profile:'+session.user.id;
    try{
      const cached=await AsyncStorage.getItem(profileCacheKey);
      if(cached){
        const cachedProfile=JSON.parse(cached);
        setProfile(cachedProfile);
        setProfileName(cachedProfile?.display_name||'');
        setProfileUsername(cachedProfile?.username||'');
        setAbout(cachedProfile?.about||'');
        setProfileAvatarPath(cachedProfile?.avatar_url||'');
        setProfileReady(true);
      }
    }catch{ /* Keep the app usable if the local profile cache is unreadable. */ }
    const {data,error}=await supabase.from('kc_profiles')
      .select('id,display_name,username,about,avatar_url,is_online')
      .eq('id',session.user.id).maybeSingle();
    if(error){
      if(!isConnectivityFailure(error))console.warn('Profile load:',error.message);
      setProfileReady(true);
      return;
    }
    setProfile(data);
    void AsyncStorage.setItem(profileCacheKey,JSON.stringify(data)).catch(()=>{});
    setProfileName(data?.display_name||session.user.user_metadata?.display_name||'');
    setProfileUsername(data?.username||session.user.user_metadata?.username||'');
    setAbout(data?.about||'');
    setProfileAvatarPath(data?.avatar_url||'');
    if(data?.avatar_url){setProfileAvatarUrl(await getSignedMediaUrl(data.avatar_url)||'');}
    else setProfileAvatarUrl('');
    setProfileReady(true);
  },[session,getSignedMediaUrl]);

  const loadInbox=useCallback(async()=>{
    if(!session) return;
    const inboxCacheKey='guftin-cache-inbox:'+session.user.id;
    try{
      const cached=await AsyncStorage.getItem(inboxCacheKey);
      if(cached){const parsed=JSON.parse(cached);if(Array.isArray(parsed)){const safeCached=(parsed as Chat[]).filter(chat=>chat.kind!=='direct'||chat.hasConversationActivity===true||chat.hasCallActivity===true||chat.hasPendingActivity===true);setChats(sortInboxChats(safeCached));setLoading(false);}}
    }catch{ /* Ignore a damaged local inbox cache and try the server. */ }
    try{
      const {data:memberships,error}=await supabase.from('kc_conversation_members')
        .select('conversation_id,joined_at,last_read_at,hidden_at,conversation:kc_conversations!inner(id,kind,title,photo_url,updated_at)')
        .eq('user_id',session.user.id).is('hidden_at',null);
      if(error) throw error;
      const rows=(memberships||[]) as any[];
      const ids=rows.map(r=>r.conversation_id).filter(Boolean);
      if(ids.length===0){
        setChats(prev=>{
          const pending=prev.filter(chat=>chat.kind==='direct'&&chat.hasPendingActivity===true);
          const next=sortInboxChats(pending);
          void AsyncStorage.setItem(inboxCacheKey,JSON.stringify(next)).catch(()=>{});
          return next;
        });
        return;
      }
      const directConversationIds=rows.filter(r=>r.conversation?.kind==='direct').map(r=>r.conversation_id).filter(Boolean);
      const [memberResult,profileResult,messageResult,hiddenResult,channelResult,callResult]=await Promise.all([
        supabase.from('kc_conversation_members').select('conversation_id,user_id,last_read_at,joined_at').in('conversation_id',ids),
        supabase.from('kc_profiles').select('id,display_name,avatar_url,is_online').neq('id',session.user.id),
        supabase.from('kc_messages').select('id,conversation_id,sender_id,body,message_type,created_at,deleted_at')
          .in('conversation_id',ids).is('deleted_at',null).order('created_at',{ascending:false}).limit(500),
        supabase.from('kc_message_hidden').select('message_id').eq('user_id',session.user.id),
        supabase.from('kc_channels').select('conversation_id,owner_id,title,description,invite_code,is_public,is_official,is_verified').in('conversation_id',ids),
        directConversationIds.length?supabase.from('kc_call_logs').select('conversation_id').in('conversation_id',directConversationIds):Promise.resolve({data:[],error:null})
      ]);
      if(memberResult.error) throw memberResult.error;
      if(profileResult.error) throw profileResult.error;
      if(messageResult.error) throw messageResult.error;
      if(channelResult.error) throw channelResult.error;
      if(callResult.error) console.warn('Direct chat call activity could not be checked:',callResult.error.message);
      const members=(memberResult.data||[]) as any[];
      const channelMap=new Map((channelResult.data||[]).map((channel:any)=>[channel.conversation_id,channel]));
      const callActivityIds=new Set(((callResult.data||[]) as any[]).map((call:any)=>call.conversation_id).filter(Boolean));
      const hiddenIds=new Set((hiddenResult.data||[]).map((row:any)=>row.message_id));
      hiddenIds.forEach(id=>hiddenMessageIds.current.add(id));
      const inboxMessages=((messageResult.data||[]) as any[]).filter(message=>!hiddenIds.has(message.id)&&!hiddenMessageIds.current.has(message.id));
      const peerIds=[...new Set(members.filter(m=>m.user_id!==session.user.id).map(m=>m.user_id))];
      const profiles=(profileResult.error?[]:(profileResult.data||[])) as any[];
      const profileMap=new Map(profiles.filter(p=>peerIds.includes(p.id)).map(p=>[p.id,p]));
      const latest=new Map<string,any>();
      for(const message of inboxMessages) if(!latest.has(message.conversation_id)) latest.set(message.conversation_id,message);
      const mappedRows=await Promise.all(rows.map(async row=>{
        const conv=row.conversation||{};
        const peers=members.filter(m=>m.conversation_id===row.conversation_id&&m.user_id!==session.user.id);
        const peer=peers.length?profileMap.get(peers[0].user_id):null;
        // A direct membership is not itself a conversation. Require a real registered peer profile.
        if(conv.kind==='direct'&&(!peer||!peer.id))return null;
        const channel:any=channelMap.get(row.conversation_id);
        const name=conv.kind==='group'?(conv.title||'Group chat'):conv.kind==='channel'?(channel?.title||conv.title||'Channel'):(peer?.display_name||'Guftin member');
        const avatarPath=conv.kind==='group'?(conv.photo_url||null):(peer?.avatar_url||null);
        const avatarUrl=avatarPath?(await getSignedMediaUrl(avatarPath))||undefined:undefined;
        let last=latest.get(row.conversation_id);
        if(last&&hiddenMessageIds.current.has(last.id))last=undefined;
        const readThrough=Math.max(
          row.last_read_at?new Date(row.last_read_at).getTime():0,
          row.joined_at?new Date(row.joined_at).getTime():0
        );
        const unread=inboxMessages.filter((message:any)=>
          message.conversation_id===row.conversation_id &&
          message.sender_id!==session.user.id &&
          new Date(message.created_at).getTime()>readThrough
        ).length;
        let preview='No messages yet';
        if(last){
          if(last.deleted_at)preview='This message was deleted';
          else if(last.message_type==='image')preview='Photo';
          else if(last.message_type==='video')preview='Video';
          else if(last.message_type==='audio')preview='Voice message';
          else if(last.message_type==='file')preview='Document';
          else if(typeof last.body==='string'&&last.body.startsWith(E2EE_PREFIX)){
            try{preview=deviceIdentity?decryptMessageForDevice(last.body,deviceIdentity):'Message';}
            catch{preview='Message';}
          }else preview=last.body||'Attachment';
        }
        return {id:row.conversation_id,name,avatar:initials(name),avatarUrl,color:colorFor(name),last:preview,
          time:last?timeLabel(last.created_at):'',unread,online:!!peer?.is_online,kind:conv.kind||'direct',
          lastAt:last?new Date(last.created_at).getTime():new Date(conv.updated_at||row.joined_at).getTime(),
          isOfficial:!!channel?.is_official,isVerified:!!channel?.is_verified,isChannelOwner:channel?.owner_id===session.user.id,
          inviteCode:channel?.invite_code,isPublic:channel?.is_public!==false,ownerId:channel?.owner_id,description:channel?.description||'',
          hasConversationActivity:!!last&&!!last.sender_id&&last.message_type!=='system',hasCallActivity:callActivityIds.has(row.conversation_id)};
      }));
      const mapped:Chat[]=sortInboxChats(mappedRows.filter((chat):chat is Chat=>!!chat&&(chat.kind!=='direct'||chat.hasConversationActivity===true||chat.hasCallActivity===true)));
      setChats(prev=>{
        const pending=prev.filter(chat=>chat.kind==='direct'&&chat.hasPendingActivity===true&&!mapped.some(item=>item.id===chat.id));
        const next=sortInboxChats([...mapped,...pending]);
        void AsyncStorage.setItem(inboxCacheKey,JSON.stringify(next)).catch(()=>{});
        return next;
      });
    }catch(e:any){
      if(!isConnectivityFailure(e))Alert.alert('Inbox could not load',e?.message||'Please try again.');
    }finally{setLoading(false);}
  },[session,deviceIdentity,getSignedMediaUrl]);

  const loadCallHistory=useCallback(async()=>{
    if(!session)return;
    const [{data:directRows,error:directError},{data:participantRows,error:participantError}]=await Promise.all([
      supabase.from('kc_call_logs')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope,started_at,ended_at')
        .or('caller_id.eq.'+session.user.id+',callee_id.eq.'+session.user.id)
        .order('started_at',{ascending:false}).limit(100),
      supabase.from('kc_call_participants').select('call_id').eq('user_id',session.user.id)
    ]);
    if(directError){console.warn('Call history:',directError.message);return;}
    if(participantError){console.warn('Call participant history:',participantError.message);return;}
    const participantIds=[...new Set((participantRows||[]).map((row:any)=>row.call_id).filter(Boolean))];
    const directIds=new Set((directRows||[]).map((row:any)=>row.id));
    const missingGroupIds=participantIds.filter((id:string)=>!directIds.has(id));
    const {data:groupRows,error:groupError}=missingGroupIds.length
      ?await supabase.from('kc_call_logs')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope,started_at,ended_at')
        .in('id',missingGroupIds).order('started_at',{ascending:false}).limit(100)
      :{data:[],error:null};
    if(groupError){console.warn('Group call history:',groupError.message);return;}
    const rows=[...(directRows||[]),...(groupRows||[])].sort((a:any,b:any)=>
      new Date(b.started_at||b.ended_at||0).getTime()-new Date(a.started_at||a.ended_at||0).getTime()
    ).slice(0,100) as any[];
    const peers=[...new Set(rows.filter(row=>row.call_scope!=='group').map(row=>row.caller_id===session.user.id?row.callee_id:row.caller_id).filter(Boolean))];
    const groupConversationIds=[...new Set(rows.filter(row=>row.call_scope==='group').map(row=>row.conversation_id).filter(Boolean))];
    const [{data:profiles},{data:groupConversations}]=await Promise.all([
      peers.length?supabase.from('kc_profiles').select('id,display_name,avatar_url').in('id',peers):Promise.resolve({data:[]}),
      groupConversationIds.length?supabase.from('kc_conversations').select('id,title').in('id',groupConversationIds):Promise.resolve({data:[]})
    ]);
    const profileMap=new Map((profiles||[]).map((p:any)=>[p.id,p]));
    const groupMap=new Map((groupConversations||[]).map((c:any)=>[c.id,c.title||'Group call']));
    setCallHistory(rows.map(row=>{
      const peerId=row.caller_id===session.user.id?row.callee_id:row.caller_id;
      const peer:any=profileMap.get(peerId);
      const peerName=row.call_scope==='group'?(groupMap.get(row.conversation_id)||'Group call'):(peer?.display_name||'Guftin member');
      return {...row,peer_name:peerName,outgoing:row.caller_id===session.user.id};
    }));
  },[session]);

  useEffect(()=>{
    if(session&&tab==='Calls')void loadCallHistory();
  },[session?.user?.id,tab,loadCallHistory]);

  const resolveMessage=useCallback(async(raw:any,cached?:Message):Promise<Message>=>{
    let attachment_url=raw.attachment_url||null;
    if(attachment_url){
      attachment_url=await getSignedMediaUrl(attachment_url);
    }
    let body=raw.body||null;
    const cachedPlaintextIsValid=!!cached&&cached.id===raw.id&&cached.created_at===raw.created_at&&
      cached.message_type===raw.message_type&&!cached.pending&&!raw.deleted_at&&
      typeof cached.body==='string'&&cached.body.length>0&&
      !cached.body.startsWith(E2EE_PREFIX)&&!cached.body.startsWith(E2EE_MEDIA_PREFIX)&&
      !cached.body.startsWith('🔒');
    if(typeof body==='string'&&body.startsWith(E2EE_MEDIA_PREFIX)){
      try{
        if(!attachment_url||!deviceIdentity)throw new Error('The local encryption key is not available.');
        const response=await fetch(attachment_url);
        if(!response.ok)throw new Error('Encrypted media could not be downloaded.');
        const encryptedBytes=new Uint8Array(await response.arrayBuffer());
        const decrypted=decryptMediaForDevice(encryptedBytes,body,deviceIdentity);
        const safeExtension=(decrypted.fileName.split('.').pop()||'bin').toLowerCase().replace(/[^a-z0-9]/g,'')||'bin';
        const localFile=new File(Paths.document,'kc_'+raw.id+'.'+safeExtension);
        if(localFile.exists)localFile.delete();
        localFile.create();
        await localFile.write(decrypted.bytes);
        attachment_url=localFile.uri;
        body=decrypted.fileName;
      }catch(e:any){
        attachment_url=null;
        body='Media is unavailable on this device.';
      }
    }else if(typeof body==='string'&&body.startsWith(E2EE_PREFIX)){
      try{
        if(!deviceIdentity)throw new Error('The local device key is not ready.');
        body=decryptMessageForDevice(body,deviceIdentity);
      }catch(e:any){
        body=cachedPlaintextIsValid?cached!.body:'This message is unavailable on this device.';
      }
    }
    return {...raw,body,attachment_url,mine:raw.sender_id===session?.user?.id,deleted_at:raw.deleted_at||null};
  },[session,deviceIdentity,getSignedMediaUrl]);

  useEffect(()=>{
    if(!session?.user?.id || Platform.OS!=='android')return;
    let mounted=true;
    void ensureCallKeepReady().catch((error:any)=>{
      if(mounted)console.warn('Android call screen setup:',error?.message||error);
    });
    return ()=>{mounted=false;};
  },[session?.user?.id]);

  useEffect(()=>{
    let mounted=true;
    let registering=false;
    const registerPreviouslyAllowedDevice=async()=>{
      if(!mounted||!session?.user?.id||!pushPermissionReady||registering)return;
      registering=true;
      try{
        await registerExpoPushToken(session.user.id);
        if(mounted)setPushEnabled(true);
      }catch(error:any){
        if(mounted)setPushEnabled(false);
        console.warn('Push token registration:',error?.message||error);
      }finally{
        registering=false;
      }
    };
    void registerPreviouslyAllowedDevice();
    const tokenSubscription=Notifications.addPushTokenListener(()=>{
      void registerPreviouslyAllowedDevice();
    });
    const appStateSubscription=AppState.addEventListener('change',state=>{
      if(state==='active')void registerPreviouslyAllowedDevice();
    });
    return ()=>{
      mounted=false;
      tokenSubscription.remove();
      appStateSubscription.remove();
    };
  },[session?.user?.id,pushPermissionReady]);

  const enablePushNotifications=async()=>{
    if(!session||pushBusy)return;
    setPushBusy(true);
    try{
      await configureGuftinNotificationChannels();
      let permission=await Notifications.getPermissionsAsync();
      if(!permission.granted)permission=await Notifications.requestPermissionsAsync();
      if(!permission.granted)throw new Error('Notification permission was not granted.');
      await registerExpoPushToken(session.user.id);
      setPushEnabled(true);
      Alert.alert('Notifications enabled','This phone is registered with Guftin. Send a test notification to confirm delivery.');
    }catch(e:any){
      setPushEnabled(false);
      Alert.alert('Notifications not enabled',e?.message||'Please check Android permission and Expo/Firebase FCM V1 credentials.');
    }finally{setPushBusy(false);}
  };

  const testPushNotifications=async()=>{
    if(!session||pushBusy)return;
    setPushBusy(true);
    let registered=false;
    try{
      await registerExpoPushToken(session.user.id);
      registered=true;
      setPushEnabled(true);
      const {data,error}=await supabase.functions.invoke('guftin-push',{body:{kind:'test'}});
      if(error)throw error;
      if(!data?.sent){
        const details=Array.isArray(data?.warnings)?data.warnings.join(', '):'';
        throw new Error(details||data?.reason||'The push service did not accept this test notification.');
      }
      Alert.alert('Test notification queued','Expo accepted the test push for this phone. Check the notification shade; delivery is still subject to Android and Firebase availability.');
    }catch(e:any){
      if(!registered)setPushEnabled(false);
      Alert.alert('Test notification failed',e?.message||'Check the Expo FCM V1 credentials and Android notification permission.');
    }finally{setPushBusy(false);}
  };

  const disablePushNotifications=async()=>{
    if(!session||pushBusy)return;
    setPushBusy(true);
    try{
      const projectId=getExpoProjectId();
      if(projectId){
        const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
        const {error}=await supabase.from('kc_device_tokens').delete().eq('user_id',session.user.id).eq('token',token);
        if(error)throw error;
      }
      setPushEnabled(false);
    }catch(e:any){Alert.alert('Could not turn notifications off',e?.message||'Please try again.');}
    finally{setPushBusy(false);}
  };

  const finishPermissionSetup=async()=>{
    if(!session?.user?.id)return;
    try{await AsyncStorage.setItem('guftin-permission-setup-v1:'+session.user.id,'completed');}
    catch(error:any){console.warn('Could not save permission setup completion:',error?.message||error);}
    setPermissionSetupVisible(false);
    setPermissionSetupNotice('');
  };

  const advancePermissionSetup=async()=>{
    if(permissionSetupStep>=PERMISSION_SETUP_STEPS.length-1)await finishPermissionSetup();
    else{setPermissionSetupStep(current=>current+1);setPermissionSetupNotice('');}
  };

  const skipPermissionSetupStep=async()=>{
    if(PERMISSION_SETUP_STEPS[permissionSetupStep]?.key==='autoSave')setMediaAutoDownload(false);
    await advancePermissionSetup();
  };

  const requestPermissionSetupStep=async()=>{
    if(!session||permissionSetupBusy)return;
    const step=PERMISSION_SETUP_STEPS[permissionSetupStep];
    if(!step)return;
    setPermissionSetupBusy(true);
    setPermissionSetupNotice('');
    try{
      let granted=false;
      let canAskAgain=true;
      if(step.key==='notifications'){
        await configureGuftinNotificationChannels();
        let permission=await Notifications.getPermissionsAsync();
        if(!permission.granted&&permission.canAskAgain!==false)permission=await Notifications.requestPermissionsAsync();
        granted=permission.granted;
        canAskAgain=permission.canAskAgain;
        if(granted){
          try{
            await registerExpoPushToken(session.user.id);
            setPushEnabled(true);
            setPermissionSetupNotice('This phone is registered for push notifications. You can send a test notification from Settings.');
          }catch(error:any){
            setPushEnabled(false);
            setPermissionSetupNotice(error?.message||'Android permission is allowed, but Expo/Firebase push registration still needs configuration.');
          }
        }
      }else if(step.key==='microphone'){
        const permission=await Audio.requestPermissionsAsync();
        granted=permission.granted;canAskAgain=permission.canAskAgain;
      }else if(step.key==='camera'){
        const permission=await ImagePicker.requestCameraPermissionsAsync();
        granted=permission.granted;canAskAgain=permission.canAskAgain;
      }else if(step.key==='photos'){
        const permission=await ImagePicker.requestMediaLibraryPermissionsAsync(false);
        granted=permission.granted;canAskAgain=permission.canAskAgain;
      }else if(step.key==='autoSave'){
        if(!permissionSetupAutoSave){
          setMediaAutoDownload(false);
          granted=true;
        }else{
          const permission=await MediaLibrary.requestPermissionsAsync(true,['photo','video']);
          granted=permission.granted;canAskAgain=permission.canAskAgain;
          setMediaAutoDownload(permission.granted);
        }
      }
      if(!granted&&canAskAgain===false){
        Alert.alert('Permission is turned off','Android will not show this permission prompt again. You can enable it later in Settings → Apps → Guftin → Permissions.');
      }
      await advancePermissionSetup();
    }catch(error:any){
      Alert.alert('Permission request failed',error?.message||'You can skip this permission and change it later in Android settings.');
    }finally{setPermissionSetupBusy(false);}
  };

  const dispatchPush=async(kind:'message'|'official_broadcast'|'call'|'status'|'status_like'|'status_view',id:string)=>{
    try{
      const payload=kind==='message'||kind==='official_broadcast'?{kind,message_id:id}:kind==='call'?{kind,call_id:id}:{kind,status_id:id};
      const {data,error}=await supabase.functions.invoke('guftin-push',{body:payload});
      if(error)console.warn('Push dispatch:',error.message);
      else if(kind==='call'&&(!data?.sent||data.sent<1))console.warn('Incoming call push was not queued:',data?.reason||data?.warnings||'No push ticket was accepted.');
      else if(kind==='call')console.log('Incoming call push queued:',data.sent,'of',data.attempted);
    }catch(error:any){console.warn('Push dispatch unavailable:',error?.message||error);}
  };

  const saveMediaToGallery=async(item:any,showFeedback=true)=>{
    if(!item?.attachment_url||!['image','video'].includes(item.message_type))return;
    try{
      const permission=await MediaLibrary.requestPermissionsAsync(true);
      if(!permission.granted)throw new Error('Allow photo library permission to save this media.');
      await MediaLibrary.saveToLibraryAsync(item.attachment_url);
      if(showFeedback)Alert.alert('Saved to gallery','The photo/video was saved to your device gallery.');
    }catch(e:any){
      if(showFeedback)Alert.alert('Could not save media',e?.message||'Try again after allowing gallery permission.');
    }
  };

  const hideChat=async(chat:Chat)=>{
    if(!session)return;
    if(chat.isOfficial){
      Alert.alert('Guftin Official stays in your inbox','The verified official chat is kept visible so you do not miss important announcements.');
      return;
    }
    const {error}=await supabase.from('kc_conversation_members')
      .update({hidden_at:new Date().toISOString()})
      .eq('conversation_id',chat.id).eq('user_id',session.user.id);
    if(error){Alert.alert('Chat not deleted',error.message);return;}
    setChats(prev=>{
      const next=prev.filter(item=>item.id!==chat.id);
      void AsyncStorage.setItem('guftin-cache-inbox:'+session.user.id,JSON.stringify(next)).catch(()=>{});
      return next;
    });
    if(active?.id===chat.id)setActive(null);
  };

  const clearChatForMe=async(chat:Chat)=>{
    if(!session)return;
    if(sending||mediaPreparing){Alert.alert('Please wait','Finish the current message or media upload before clearing this chat.');return;}
    const conversationId=chat.id;
    if(clearingConversationIds.current.has(conversationId))return;
    clearGenerationByConversation.current.set(conversationId,(clearGenerationByConversation.current.get(conversationId)||0)+1);
    clearingConversationIds.current.add(conversationId);
    try{
      let attempts=0;
      while((flushingPendingMessages.current||flushingPendingMedia.current)&&attempts<200){
        await new Promise<void>(resolve=>setTimeout(resolve,50));
        attempts++;
      }
      if(flushingPendingMessages.current||flushingPendingMedia.current){
        throw new Error('A message is still syncing. Close this chat and try Clear Chat again.');
      }
      const messageIds:string[]=[];
      for(let from=0;;from+=500){
        const {data,error}=await supabase.from('kc_messages').select('id')
          .eq('conversation_id',conversationId)
          .order('created_at',{ascending:true}).order('id',{ascending:true})
          .range(from,from+499);
        if(error)throw error;
        const batch=data||[];
        messageIds.push(...batch.map((row:any)=>row.id));
        if(batch.length<500)break;
      }
      for(let offset=0;offset<messageIds.length;offset+=250){
        const rows=messageIds.slice(offset,offset+250).map(message_id=>({message_id,user_id:session.user.id}));
        const {error}=await supabase.from('kc_message_hidden')
          .upsert(rows,{onConflict:'message_id,user_id',ignoreDuplicates:true});
        if(error)throw error;
      }
      messageIds.forEach(id=>hiddenMessageIds.current.add(id));
      const removeLocalFile=(uri:any)=>{
        if(typeof uri!=='string'||!uri.startsWith('file://'))return;
        try{const file=new File(uri);if(file.exists)file.delete();}catch{}
      };
      const cacheKey='guftin-cache-messages:'+session.user.id+':'+conversationId;
      try{
        const cachedRaw=await AsyncStorage.getItem(cacheKey);
        const cachedItems=cachedRaw?JSON.parse(cachedRaw):[];
        if(Array.isArray(cachedItems))cachedItems.forEach((item:any)=>removeLocalFile(item.attachment_url));
      }catch{}
      const textQueueKey='guftin-pending-messages:'+session.user.id;
      const mediaQueueKey='guftin-pending-media:'+session.user.id;
      const textQueueRaw=await AsyncStorage.getItem(textQueueKey);
      if(textQueueRaw){
        const textQueue=JSON.parse(textQueueRaw);
        if(!Array.isArray(textQueue))throw new Error('The pending message queue could not be read.');
        await AsyncStorage.setItem(textQueueKey,JSON.stringify(textQueue.filter((item:any)=>item.conversation_id!==conversationId)));
      }
      const mediaQueueRaw=await AsyncStorage.getItem(mediaQueueKey);
      if(mediaQueueRaw){
        const mediaQueue=JSON.parse(mediaQueueRaw);
        if(!Array.isArray(mediaQueue))throw new Error('The pending media queue could not be read.');
        mediaQueue.filter((item:any)=>item.conversation_id===conversationId).forEach((item:any)=>{
          removeLocalFile(item.localFileUri);
          removeLocalFile(item.outboundFileUri);
        });
        await AsyncStorage.setItem(mediaQueueKey,JSON.stringify(mediaQueue.filter((item:any)=>item.conversation_id!==conversationId)));
      }
      await AsyncStorage.removeItem(cacheKey);
      setMessages(prev=>({...prev,[conversationId]:[]}));
      setChats(prev=>{
        const next=prev.map(item=>item.id===conversationId?{...item,last:'No messages yet',time:'',unread:0,lastAt:0,hasPendingActivity:false,hasConversationActivity:false,hasCallActivity:false}:item);
        void AsyncStorage.setItem('guftin-cache-inbox:'+session.user.id,JSON.stringify(next)).catch(()=>{});
        return next;
      });
      setPeerLastReadAt(null);
      if(activeConversationIdRef.current===conversationId)setDraft('');
      void loadInbox();
      Alert.alert('Chat cleared','Messages are cleared on this phone. The other person still has their chat history.');
    }catch(error:any){
      Alert.alert('Could not clear chat',error?.message||'Please try again.');
    }finally{
      clearingConversationIds.current.delete(conversationId);
    }
  };

  const deleteMessage=async(item:Message)=>{
    if(!session)return;
    const hideForMe=async()=>{
      const {error}=await supabase.from('kc_message_hidden').insert({message_id:item.id,user_id:session.user.id});
      if(error&&error.code!=='23505'){Alert.alert('Message not deleted',error.message);return;}
      hiddenMessageIds.current.add(item.id);
      setMessages(prev=>({...prev,[item.conversation_id]:(prev[item.conversation_id]||[]).filter(m=>m.id!==item.id)}));
    };
    const deleteForEveryone=async()=>{
      const {error}=await supabase.from('kc_messages').update({deleted_at:new Date().toISOString()})
        .eq('id',item.id).eq('sender_id',session.user.id);
      if(error){Alert.alert('Message not deleted',error.message);return;}
      setMessages(prev=>({...prev,[item.conversation_id]:(prev[item.conversation_id]||[]).map(m=>m.id===item.id?{...m,deleted_at:new Date().toISOString(),body:null,attachment_url:null}:m)}));
    };
    const options:any[]=[{text:'Delete for me',onPress:()=>void hideForMe()}];
    if(item.mine&&!item.deleted_at)options.push({text:'Delete for everyone',style:'destructive',onPress:()=>void deleteForEveryone()});
    options.push({text:'Cancel',style:'cancel'});
    Alert.alert('Delete message','Choose where to delete this message.',options);
  };

  const joinCall=useCallback(async(call:any)=>{
    if(!call?.id||joiningCallIds.current.has(call.id))return;
    joiningCallIds.current.add(call.id);
    try{
      if(!session||!deviceIdentity||e2eeStatus!=='ready')throw new Error('This phone is not ready for encrypted calling. Open Guftin again and make sure secure chat is ready.');
      const {data:callRecord,error:callRecordError}=await supabase.from('kc_call_logs')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope,e2ee_key_envelopes')
        .eq('id',call.id).maybeSingle();
      if(callRecordError)throw callRecordError;
      if(!callRecord||callRecord.status!=='accepted')throw new Error('The call is no longer accepted.');
      const callScope=callRecord.call_scope||'direct';
      let nativeIncomingCall=false;
      if(callScope==='group'){
        const {data:participant,error:participantError}=await supabase.from('kc_call_participants')
          .select('status,role').eq('call_id',call.id).eq('user_id',session.user.id).maybeSingle();
        if(participantError)throw participantError;
        if(!participant||participant.status!=='accepted')throw new Error('Accept this group call before joining.');
        nativeIncomingCall=participant.role==='invitee';
      }else{
        nativeIncomingCall=callRecord.callee_id===session.user.id;
      }
      const e2eeKey=decryptCallKeyForDevice(callRecord.e2ee_key_envelopes,deviceIdentity);
      const {data,error}=await supabase.functions.invoke('livekit-token',{body:{call_id:call.id}});
      if(error)throw error;
      if(!data?.server_url||!data?.participant_token)throw new Error(data?.error||'The LiveKit token endpoint is not ready.');
      setLiveCall({id:call.id,callType:callRecord.call_type,callScope,serverUrl:data.server_url,token:data.participant_token,e2eeKey,nativeIncomingCall});
      // Mark Android Telecom active only after the secure media room connects.
      setIncomingCall(null);
      setOutgoingCall(null);
    }catch(e:any){
      let details=e?.message||'LiveKit credentials are missing or the call is no longer active.';
      try{
        const response=e?.context;
        if(response&&typeof response.clone==='function'){
          const body=await response.clone().json();
          if(typeof body?.error==='string'&&body.error.trim())details=body.error;
          if(Array.isArray(body?.missing)&&body.missing.length){
            details+=' Missing secrets: '+body.missing.filter((name:any)=>typeof name==='string').join(', ')+'.';
          }
        }
      }catch{}
      Alert.alert('Call could not connect',details);
      await supabase.from('kc_call_logs').update({status:'ended',ended_at:new Date().toISOString()}).eq('id',call.id);
      setIncomingCall(null);
      setOutgoingCall(null);
    }finally{
      joiningCallIds.current.delete(call.id);
    }
  },[session,deviceIdentity,e2eeStatus]);

  const syncNativeIncomingCallAction=(callId:string,status:'accepted'|'declined')=>{
    if(Platform.OS!=='android')return;
    try{
      if(status==='accepted')RNCallKeep.answerIncomingCall(callId);
      else RNCallKeep.rejectCall(callId);
    }catch(error:any){
      console.warn('Android Telecom call action sync:',error?.message||error);
    }
  };

  const respondToCall=useCallback(async(call:any,status:'accepted'|'declined')=>{
    if(!session||!call?.id)return;
    if((call.call_scope||'direct')==='group'){
      const {error}=await supabase.rpc('kc_answer_group_call',{p_call_id:call.id,p_status:status});
      if(error){Alert.alert('Group call action failed',error.message);return;}
      void dismissIncomingCallNotification(call.id);
      syncNativeIncomingCallAction(call.id,status);
      setIncomingCall(null);
      if(status==='accepted')await joinCall({...call,status:'accepted'});
      else setOutgoingCall(null);
      return;
    }
    const update:any={status};
    if(status==='accepted')update.started_at=new Date().toISOString();
    else update.ended_at=new Date().toISOString();
    const {error}=await supabase.from('kc_call_logs').update(update).eq('id',call.id);
    if(error){Alert.alert('Call action failed',error.message);return;}
    void dismissIncomingCallNotification(call.id);
    syncNativeIncomingCallAction(call.id,status);
    setIncomingCall(null);
    if(status==='accepted')await joinCall({...call,status:'accepted'});
    else setOutgoingCall(null);
  },[session,joinCall]);

  const acceptCallWhenReady=useCallback(async(call:any)=>{
    if(!session||!call?.id)return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      setIncomingCall(call);
      setPendingCallAccept(call);
      return;
    }
    await respondToCall(call,'accepted');
  },[session,deviceIdentity,e2eeStatus,respondToCall]);

  useEffect(()=>{
    if(!pendingCallAccept||!session||!deviceIdentity||e2eeStatus!=='ready')return;
    const call=pendingCallAccept;
    setPendingCallAccept(null);
    void respondToCall(call,'accepted');
  },[pendingCallAccept,session,deviceIdentity,e2eeStatus,respondToCall]);

  useEffect(()=>{
    if(!session){
      setLoading(false);setChats([]);setProfile(null);setProfileReady(false);setActive(null);return;
    }
    setProfileReady(false);
    void loadProfile();
    void loadInbox();
    void supabase.from('kc_profiles').update({is_online:true,last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    const appState=AppState.addEventListener('change',(state)=>{
      void supabase.from('kc_profiles').update({is_online:onlineVisibility&&state==='active',last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
      if(state==='active'){
        void loadInbox();
        if(activeConversationIdRef.current)void loadMessagesRef.current?.(activeConversationIdRef.current);
        void loadProfile();
        void flushPendingMessagesRef.current?.();
        void flushPendingMediaRef.current?.();
      }
    });
    const channel=supabase.channel('kingchat-user-'+session.user.id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'kc_messages'},async payload=>{
        const m=payload.new as any;
        const item=await resolveMessage(m);
        if(clearingConversationIds.current.has(m.conversation_id)||hiddenMessageIds.current.has(m.id))return;
        setMessages(prev=>{
          const old=prev[m.conversation_id]||[];
          return {...prev,[m.conversation_id]:old.some(x=>x.id===m.id)?old:[...old,item]};
        });
        if(m.sender_id!==session.user.id){
          void supabase.from('kc_conversation_members').update({hidden_at:null})
            .eq('conversation_id',m.conversation_id).eq('user_id',session.user.id);
          void supabase.from('kc_message_receipts').insert({message_id:m.id,user_id:session.user.id});
          if(showReadReceipts&&activeConversationIdRef.current===m.conversation_id){
            void supabase.rpc('kc_mark_conversation_read',{p_conversation_id:m.conversation_id});
          }
          if(mediaAutoDownload&&['image','video'].includes(m.message_type)){
            void saveMediaToGallery(item,false);
          }
        }
        void loadInbox();
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'kc_messages'},payload=>{
        const updated=payload.new as any;
        if(updated.deleted_at){
          setMessages(prev=>({...prev,[updated.conversation_id]:(prev[updated.conversation_id]||[]).map(item=>item.id===updated.id?{...item,deleted_at:updated.deleted_at,body:null,attachment_url:null}:item)}));
          void loadInbox();
        }
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'kc_conversation_members'},payload=>{
        const member=payload.new as any;
        if(member.conversation_id===activeConversationIdRef.current && member.user_id!==session.user.id){
          setPeerLastReadAt(member.last_read_at||null);
        }
        void loadInbox();
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'kc_profiles'},()=>{
        // Refresh names and signed avatar URLs immediately after a contact edits a profile.
        void loadInbox();
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'kc_call_logs'},payload=>{
        const call=(payload.new||payload.old) as any;
        if(!call?.id)return;
        if(activeTabRef.current==='Calls')void loadCallHistory();
        const groupCall=(call.call_scope||'direct')==='group';
        const incoming=groupCall
          ?call.caller_id!==session.user.id&&call.status==='ringing'
          :call.callee_id===session.user.id&&call.status==='ringing';
        if(incoming){
          void (async()=>{
            let callerName='Guftin contact';
            try{
              const {data:callerProfile}=await supabase.from('kc_profiles')
                .select('display_name').eq('id',call.caller_id).maybeSingle();
              if(callerProfile?.display_name)callerName=callerProfile.display_name;
            }catch{}
            const incomingWithName={...call,caller_name:callerName};
            setIncomingCall(incomingWithName);
            await presentNativeIncomingCall({
              call_id:call.id,
              caller_id:call.caller_id,
              caller_name:callerName,
              call_type:call.call_type,
              call_scope:call.call_scope||'direct'
            });
          })();
        }
        if(call.caller_id===session.user.id&&call.status==='accepted'){
          void joinCall(call);
        }
        if(['declined','ended','missed','cancelled'].includes(call.status)){
          if(Platform.OS==='android'){
            void dismissIncomingCallNotification(call.id);
            RNCallKeep.endCall(call.id);
          }
          setIncomingCall((old:any)=>old?.id===call.id?null:old);
          setOutgoingCall((old:any)=>old?.id===call.id?null:old);
          setPendingCallAccept((old:any)=>old?.id===call.id?null:old);
          setLiveCall((old:any)=>old?.id===call.id?null:old);
        }
      }).subscribe((status,error)=>{
        if(status==='SUBSCRIBED'){
          console.log('Guftin realtime connected');
          void flushPendingMessagesRef.current?.();
          void flushPendingMediaRef.current?.();
        }else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
          console.warn('Guftin realtime unavailable; automatic sync will use polling.',error?.message||status);
        }
      });
    // Realtime is the fast path. Polling is a recovery path for devices or
    // projects where Postgres Changes is not enabled or the socket drops.
    const syncTimer=setInterval(()=>{
      if(AppState.currentState==='active'){
        if(autoSync){
          void loadInbox();
          const conversationId=activeConversationIdRef.current;
          if(conversationId)void loadMessagesRef.current?.(conversationId);
        }
        void flushPendingMessagesRef.current?.();
        void flushPendingMediaRef.current?.();
      }
    },Math.max(15,syncIntervalSeconds)*1000);
    return ()=>{
      clearInterval(syncTimer);
      appState.remove();
      void supabase.removeChannel(channel);
      setIncomingCall(null);setOutgoingCall(null);setLiveCall(null);
      void supabase.from('kc_profiles').update({is_online:false,last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    };
  },[session,loadProfile,loadInbox,loadCallHistory,resolveMessage,joinCall,respondToCall,acceptCallWhenReady,onlineVisibility,autoSync,syncIntervalSeconds,showReadReceipts,mediaAutoDownload]);

  useEffect(()=>{
    let mounted=true;
    const applyNetworkState=(state:any)=>{
      const online=state?.isConnected===true&&state?.isInternetReachable!==false;
      onlineRef.current=online;
      if(online&&mounted){
        void flushPendingMessagesRef.current?.();
        void flushPendingMediaRef.current?.();
      }
    };
    void NetInfo.fetch().then(applyNetworkState).catch(()=>{});
    const unsubscribe=NetInfo.addEventListener(applyNetworkState);
    return ()=>{
      mounted=false;
      unsubscribe();
    };
  },[]);

  useEffect(()=>{
    let mounted=true;
    // Keep ads non-personalized and apply a conservative content rating.
    mobileAds().setRequestConfiguration({
      maxAdContentRating: MaxAdContentRating.G
    }).then(()=>mobileAds().initialize()).then(()=>{
      if(mounted)setAdsReady(true);
    }).catch(error=>console.warn('AdMob initialization failed:',error?.message||error));
    return ()=>{mounted=false;};
  },[]);

  useEffect(()=>{
    if(!session)return;
    const handleNotificationResponse=(response:any)=>{
      const responseId=response.notification?.request?.identifier;
      if(responseId&&handledNotificationResponses.current.has(responseId))return;
      if(responseId)handledNotificationResponses.current.add(responseId);
      const data=response.notification.request.content.data as any;
      const action=response.actionIdentifier;
      if(data?.type==='incoming_call'&&typeof data.call_id==='string'){
        void supabase.from('kc_call_logs').select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope')
          .eq('id',data.call_id).maybeSingle().then(async({data:call})=>{
            if(!call)return;
            const isGroup=(call.call_scope||data.call_scope)==='group';
            let participant:any=null;
            if(isGroup){
              const result=await supabase.from('kc_call_participants').select('status,role')
                .eq('call_id',call.id).eq('user_id',session.user.id).maybeSingle();
              if(result.error||!result.data)return;
              participant=result.data;
              if(!['ringing','invited','accepted'].includes(participant.status))return;
              if(!['ringing','accepted'].includes(call.status))return;
            }else if(call.status!=='ringing')return;
            setTab('Calls');
            if(action==='accept_call'){
              if(isGroup&&participant.status==='accepted')void joinCall(call);
              else void acceptCallWhenReady(call);
              return;
            }
            if(action==='decline_call'){
              if(isGroup&&participant.status==='accepted')return;
              void respondToCall(call,'declined');
              return;
            }
            setIncomingCall({...call,caller_name:data.caller_name||'Guftin contact'});
          });
      }else if(data?.type==='message'){
        setTab('Chats');
        if(typeof data.conversation_id==='string'){
          setPendingNotificationConversation(data.conversation_id);
          void loadInbox();
        }
      }else if(['status','status_like','status_view'].includes(data?.type)){
        setTab('Updates');
      }
    };
    const foregroundPushSubscription=Notifications.addNotificationReceivedListener((notification:any)=>{
      const data=notification?.request?.content?.data as any;
      if(data?.type!=='incoming_call'||typeof data.call_id!=='string')return;
      void supabase.from('kc_call_logs')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope')
        .eq('id',data.call_id).maybeSingle().then(async({data:call,error})=>{
          if(error||!call||call.status!=='ringing')return;
          if((call.call_scope||data.call_scope)==='group'){
            const {data:participant,error:participantError}=await supabase.from('kc_call_participants')
              .select('status,role').eq('call_id',call.id).eq('user_id',session.user.id).maybeSingle();
            if(participantError||!participant||!['invited','ringing'].includes(participant.status))return;
          }else if(call.callee_id!==session.user.id)return;
          setIncomingCall({...call,caller_name:data.caller_name||'Guftin contact'});
        });
    });
    const subscription=Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    void Notifications.getLastNotificationResponseAsync().then(response=>{
      if(response)handleNotificationResponse(response);
    });
    return ()=>{
      subscription.remove();
      foregroundPushSubscription.remove();
    };
  },[session,respondToCall,acceptCallWhenReady,loadInbox,joinCall]);

  const loadMessages=useCallback(async(conversationId:string)=>{
    if(!session||clearingConversationIds.current.has(conversationId))return;
    const loadGeneration=clearGenerationByConversation.current.get(conversationId)||0;
    const messageCacheKey='guftin-cache-messages:'+session.user.id+':'+conversationId;
    let cachedMessages:Message[]=[];
    try{
      const cached=await AsyncStorage.getItem(messageCacheKey);
      if(cached){const parsed=JSON.parse(cached);if(Array.isArray(parsed)){cachedMessages=parsed;if(!clearingConversationIds.current.has(conversationId)&&(clearGenerationByConversation.current.get(conversationId)||0)===loadGeneration)setMessages(prev=>({...prev,[conversationId]:parsed}));}}
    }catch{ /* Ignore a damaged message cache and continue with the server request. */ }
    // Restore text messages waiting for delivery, even if the app was restarted.
    let pendingTextItems:Message[]=[];
    try{
      const queueRaw=await AsyncStorage.getItem('guftin-pending-messages:'+session.user.id);
      const queue=queueRaw?JSON.parse(queueRaw):[];
      if(Array.isArray(queue)){
        pendingTextItems=queue.filter((item:any)=>item.conversation_id===conversationId).map((item:any)=>({
          id:item.localId,conversation_id:conversationId,sender_id:session.user.id,
          body:item.text,message_type:'text',created_at:item.created_at,mine:true,pending:true
        }));
      }
    }catch(error:any){console.warn('Could not restore queued text messages:',error?.message||error);}
    // Rehydrate locally encrypted media that is still waiting for network access.
    let pendingMediaItems:Message[]=[];
    if(deviceIdentity){
      try{
        const queueRaw=await AsyncStorage.getItem('guftin-pending-media:'+session.user.id);
        const queue=queueRaw?JSON.parse(queueRaw):[];
        if(Array.isArray(queue)){
          for(const pending of queue.filter((item:any)=>item.conversation_id===conversationId)){
            try{
              const encryptedFile=new File(pending.localFileUri);
              if(!encryptedFile.exists)continue;
              const cipher=new Uint8Array(await encryptedFile.arrayBuffer());
              const opened=decryptMediaForDevice(cipher,pending.localBody,deviceIdentity);
              cipher.fill(0);
              const extension=(opened.fileName.split('.').pop()||'mp4').toLowerCase().replace(/[^a-z0-9]/g,'')||'mp4';
              const previewFile=new File(Paths.document,'guftin_media_'+pending.id+'.'+extension);
              if(!previewFile.exists){previewFile.create();await previewFile.write(opened.bytes);}
              opened.bytes.fill(0);
              pendingMediaItems.push({
                id:pending.localId,conversation_id:conversationId,sender_id:session.user.id,
                body:pending.message_type==='video'?'Video':pending.message_type==='image'?'Photo':(pending.fileName||'Document'),
                message_type:pending.message_type,attachment_url:previewFile.uri,
                created_at:pending.created_at,mine:true,pending:true
              });
            }catch(error:any){console.warn('Could not restore queued media preview:',error?.message||error);}
          }
        }
      }catch(error:any){console.warn('Could not read queued media:',error?.message||error);}
    }
    const offlinePendingItems=[...pendingTextItems,...pendingMediaItems];
    if(offlinePendingItems.length){
      setMessages(prev=>{
        const current=prev[conversationId]||[];
        const merged=[...current.filter(item=>!offlinePendingItems.some(pending=>pending.id===item.id)),...offlinePendingItems];
        return {...prev,[conversationId]:merged.sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime())};
      });
    }
    const {data,error}=await supabase.from('kc_messages')
      .select('id,conversation_id,sender_id,body,message_type,attachment_url,created_at,deleted_at')
      .eq('conversation_id',conversationId)
      .order('created_at',{ascending:true}).limit(200);
    if(error){if(!isConnectivityFailure(error))Alert.alert('Messages could not load',error.message);return;}
    const {data:hiddenRows}=await supabase.from('kc_message_hidden').select('message_id').eq('user_id',session.user.id);
    const hidden=new Set((hiddenRows||[]).map((row:any)=>row.message_id));
    const visibleRows=(data||[]).filter((message:any)=>!hidden.has(message.id));
    const cachedById=new Map<string,Message>();
    [...cachedMessages,...(messages[conversationId]||[])].forEach(item=>cachedById.set(item.id,item));
    const resolved=await Promise.all(visibleRows.map(async(m:any)=>{
      const cachedItem=cachedById.get(m.id);
      if(cachedItem?.attachment_url){
        try{
          const localFile=new File(cachedItem.attachment_url);
          if(cachedItem.attachment_url.startsWith('file://')&&localFile.exists)return cachedItem;
        }catch{ /* Resolve from Supabase if the local media cache has expired. */ }
      }
      return resolveMessage(m,cachedItem);
    }));
    const combined=[...resolved,...offlinePendingItems.filter(pending=>!resolved.some(item=>item.id===pending.id))]
      .sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime());
    if(clearingConversationIds.current.has(conversationId)||(clearGenerationByConversation.current.get(conversationId)||0)!==loadGeneration)return;
    setMessages(prev=>({...prev,[conversationId]:combined}));
    void AsyncStorage.setItem(messageCacheKey,JSON.stringify(combined)).catch(()=>{});
    const ownMessageIds=visibleRows.filter((m:any)=>m.sender_id===session.user.id&&!m.deleted_at).map((m:any)=>m.id);
    const {data:memberList}=await supabase.from('kc_conversation_members').select('user_id,last_read_at').eq('conversation_id',conversationId);
    const peerMember=(memberList||[]).find((member:any)=>member.user_id!==session.user.id);
    if(peerMember&&ownMessageIds.length){
      const {data:receipts}=await supabase.from('kc_message_receipts').select('message_id,delivered_at').eq('user_id',peerMember.user_id).in('message_id',ownMessageIds);
      const receiptMap:Record<string,string>={};
      (receipts||[]).forEach((row:any)=>{receiptMap[row.message_id]=row.delivered_at;});
      setDeliveredByMessage(prev=>({...prev,...receiptMap}));
    }
    const [{data:memberRows,error:memberError},{error:readError}]=await Promise.all([
      supabase.from('kc_conversation_members')
        .select('user_id,last_read_at')
        .eq('conversation_id',conversationId),
      showReadReceipts?supabase.rpc('kc_mark_conversation_read',{p_conversation_id:conversationId}):Promise.resolve({error:null})
    ]);
    if(memberError)console.warn('Read receipt roster:',memberError.message);
    if(readError)console.warn('Could not mark conversation as read:',readError.message);
    const peer=(memberRows||[]).find((member:any)=>member.user_id!==session.user.id);
    setPeerLastReadAt(peer?.last_read_at||null);
    if(!readError)void loadInbox();
  },[session,deviceIdentity,resolveMessage,loadInbox,showReadReceipts]);
  loadMessagesRef.current=loadMessages;

  useEffect(()=>{
    if(session&&active&&!active.pendingContactId)void loadMessages(active.id);
  },[session?.user?.id,deviceIdentity?.deviceId,active?.id,loadMessages]);

  const refresh=async()=>{
    setRefreshing(true);
    await Promise.all([loadInbox(),loadProfile()]);
    setRefreshing(false);
  };

  const openChat=async(chat:Chat)=>{
    setPeerLastReadAt(null);
    setActive(chat);
    // The active-chat effect performs the single initial load; do not fetch twice.
    void supabase.from('kc_conversation_members').update({hidden_at:null})
      .eq('conversation_id',chat.id).eq('user_id',session.user.id);
  };

  const ensureActiveDirectConversation=async(chat:Chat):Promise<Chat>=>{
    if(!chat.pendingContactId)return chat;
    if(!session?.user?.id)throw new Error('Sign in required to start this conversation.');
    const {data,error}=await supabase.rpc('kc_start_direct_conversation',{p_contact_id:chat.pendingContactId});
    if(error)throw error;
    const conversationId=typeof data==='string'?data:Array.isArray(data)?data[0]:data?.conversation_id;
    if(typeof conversationId!=='string'||!conversationId)throw new Error('Guftin could not create the conversation. Please try again.');
    const ready:Chat={
      ...chat,id:conversationId,pendingContactId:undefined,
      last:'No messages yet',time:'',lastAt:Date.now(),
      hasConversationActivity:false,hasCallActivity:false,hasPendingActivity:false
    };
    setActive(ready);
    return ready;
  };

  const openChannelChat=(channel:any)=>{
    if(!channel||!session)return;
    const title=channel.title||'Guftin channel';
    const chat:Chat={
      id:channel.conversation_id,name:title,avatar:initials(title),color:colorFor(title),
      last:'Channel updates',time:'',unread:0,online:false,kind:'channel',lastAt:Date.now(),
      isOfficial:!!channel.is_official,isVerified:!!channel.is_verified,
      isChannelOwner:channel.owner_id===session.user.id,inviteCode:channel.invite_code,
      isPublic:channel.is_public!==false,ownerId:channel.owner_id,description:channel.description||''
    };
    void openChat(chat);
  };

  const loadChannels=useCallback(async()=>{
    if(!session)return;
    setChannelsLoading(true);
    try{
      const {data,error}=await supabase.from('kc_channels')
        .select('conversation_id,owner_id,title,handle,description,invite_code,is_public,is_official,is_verified,created_at')
        .order('created_at',{ascending:false}).limit(500);
      if(error)throw error;
      const rows=(data||[]) as any[];
      const ids=rows.map(row=>row.conversation_id);
      const {data:following,error:followingError}=ids.length
        ?await supabase.from('kc_channel_members').select('conversation_id,role').eq('user_id',session.user.id).in('conversation_id',ids)
        :{data:[],error:null};
      if(followingError)throw followingError;
      const membershipMap=new Map((following||[]).map((row:any)=>[row.conversation_id,row.role]));
      setChannels(rows.map(row=>({...row,isFollowing:membershipMap.has(row.conversation_id),myRole:membershipMap.get(row.conversation_id)||null})));
    }catch(error:any){
      if(!isConnectivityFailure(error))Alert.alert('Channels could not load',error?.message||'Please refresh and try again.');
    }finally{setChannelsLoading(false);}
  },[session]);

  useEffect(()=>{if(session&&tab==='Channels')void loadChannels();},[session?.user?.id,tab,loadChannels]);

  const createChannel=async()=>{
    const title=channelTitle.trim();
    if(!title||channelBusy)return;
    setChannelBusy(true);
    try{
      const {data,error}=await supabase.rpc('kc_create_channel',{
        p_title:title,p_description:channelDescription.trim(),p_is_public:channelPublic
      });
      if(error)throw error;
      setChannelCreateOpen(false);setChannelTitle('');setChannelDescription('');setChannelPublic(true);
      await Promise.all([loadChannels(),loadInbox()]);
      const {data:created,error:channelError}=await supabase.from('kc_channels')
        .select('conversation_id,owner_id,title,description,invite_code,is_public,is_official,is_verified')
        .eq('conversation_id',data).single();
      if(channelError)throw channelError;
      openChannelChat(created);
      Alert.alert('Channel created','Your channel is ready. Share its invite link so people can follow it.');
    }catch(error:any){Alert.alert('Channel not created',error?.message||'Please try again.');}
    finally{setChannelBusy(false);}
  };

  const joinChannelByInvite=useCallback(async(code:string,showMessage=true)=>{
    const invite=code.trim();
    if(!invite||!session||channelBusy)return;
    setChannelBusy(true);
    try{
      const {data,error}=await supabase.rpc('kc_join_channel',{p_channel_id:null,p_invite_code:invite});
      if(error)throw error;
      await Promise.all([loadChannels(),loadInbox()]);
      const {data:channel,error:channelError}=await supabase.from('kc_channels')
        .select('conversation_id,owner_id,title,description,invite_code,is_public,is_official,is_verified')
        .eq('conversation_id',data).single();
      if(channelError)throw channelError;
      openChannelChat(channel);
      setChannelJoinOpen(false);setChannelInviteCode('');
      if(showMessage)Alert.alert('Channel followed','You are now following '+(channel.title||'this channel')+'.');
    }catch(error:any){Alert.alert('Could not join channel',error?.message||'Check the invite link or code.');}
    finally{setChannelBusy(false);}
  },[session,channelBusy,loadChannels,loadInbox]);

  const followPublicChannel=async(channel:any)=>{
    if(!channel?.conversation_id||channelBusy)return;
    setChannelBusy(true);
    try{
      const {error}=await supabase.rpc('kc_join_channel',{p_channel_id:channel.conversation_id,p_invite_code:null});
      if(error)throw error;
      await Promise.all([loadChannels(),loadInbox()]);
      Alert.alert('Following channel','You are now following '+(channel.title||'this channel')+'.');
    }catch(error:any){Alert.alert('Could not follow channel',error?.message||'Please try again.');}
    finally{setChannelBusy(false);}
  };

  const shareChannelInvite=async(channel:any)=>{
    if(!channel?.invite_code)return;
    const link=Linking.createURL('channel/'+channel.invite_code);
    try{await Share.share({message:'Follow '+(channel.title||'this Guftin channel')+' on Guftin:\n'+link});}
    catch(error:any){Alert.alert('Could not share invite',error?.message||'Invite code: '+channel.invite_code);}
  };

  const showChannelOptions=()=>{
    if(!active||active.kind!=='channel')return;
    const channel=channels.find(row=>row.conversation_id===active.id)||active;
    const options:any[]=[];
    if(active.isChannelOwner&&!active.isOfficial){
      options.push({text:'Share invite link',onPress:()=>void shareChannelInvite(channel)});
      options.push({text:'Share invite code',onPress:()=>void Share.share({message:channel.invite_code||active.inviteCode||''})});
      options.push({text:'Delete channel',style:'destructive',onPress:()=>Alert.alert('Delete channel?', 'This removes the channel, its followers and posts for everyone.',[
        {text:'Cancel',style:'cancel'},
        {text:'Delete channel',style:'destructive',onPress:()=>void (async()=>{
          const {error}=await supabase.rpc('kc_delete_channel',{p_conversation_id:active.id});
          if(error){Alert.alert('Channel not deleted',error.message);return;}
          setActive(null);await Promise.all([loadChannels(),loadInbox()]);
        })()}
      ])});
    }else if(!active.isOfficial){
      options.push({text:'Leave channel',style:'destructive',onPress:()=>Alert.alert('Leave channel?', 'You will stop receiving this channel’s updates.',[
        {text:'Cancel',style:'cancel'},
        {text:'Leave channel',style:'destructive',onPress:()=>void (async()=>{
          const {error}=await supabase.rpc('kc_leave_channel',{p_conversation_id:active.id});
          if(error){Alert.alert('Could not leave channel',error.message);return;}
          setActive(null);await Promise.all([loadChannels(),loadInbox()]);
        })()}
      ])});
    }
    options.push({text:'Close',style:'cancel'});
    Alert.alert(active.isOfficial?'Guftin Official':'Channel options',active.description||'Channel updates are read-only for followers.',options);
  };

  const handleChannelDeepLink=useCallback(async(url:string)=>{
    const match=url.match(/channel[/:]([a-f0-9]{16,64})/i);
    if(match?.[1])await joinChannelByInvite(match[1],false);
  },[joinChannelByInvite]);

  useEffect(()=>{
    if(!session)return;
    let mounted=true;
    void Linking.getInitialURL().then(url=>{if(mounted&&url)void handleChannelDeepLink(url);}).catch(()=>{});
    const subscription=Linking.addEventListener('url',event=>void handleChannelDeepLink(event.url));
    return ()=>{mounted=false;subscription.remove();};
  },[session?.user?.id,handleChannelDeepLink]);

  useEffect(()=>{
    if(!session||tab!=='Channels')return;
    void loadChannels();
    const realtime=supabase.channel('guftin-channels-'+session.user.id)
      .on('postgres_changes',{event:'*',schema:'public',table:'kc_channels'},()=>void loadChannels())
      .on('postgres_changes',{event:'*',schema:'public',table:'kc_channel_members'},()=>void loadChannels())
      .subscribe();
    return ()=>{void supabase.removeChannel(realtime);};
  },[session?.user?.id,tab,loadChannels]);

  useEffect(()=>{
    if(!pendingNotificationConversation)return;
    const chat=chats.find(item=>item.id===pendingNotificationConversation);
    if(chat){
      setPendingNotificationConversation(null);
      void openChat(chat);
    }
  },[pendingNotificationConversation,chats]);

  const queueOfflineTextMessage=async(conversationId:string,text:string,chatForInbox?:Chat)=>{
    if(!session)return;
    if(clearingConversationIds.current.has(conversationId))throw new Error('This chat is being cleared. Please try again in a moment.');
    const id=ExpoCrypto.randomUUID();
    const localId='pending:'+id;
    const queueKey='guftin-pending-messages:'+session.user.id;
    const createdAt=new Date().toISOString();
    const entry={id,localId,conversation_id:conversationId,text,created_at:createdAt};
    let queue:any[]=[];
    try{const raw=await AsyncStorage.getItem(queueKey);queue=raw?JSON.parse(raw):[];if(!Array.isArray(queue))queue=[];}catch{queue=[];}
    if(clearingConversationIds.current.has(conversationId))throw new Error('This chat is being cleared. Please try again in a moment.');
    queue.push(entry);
    await AsyncStorage.setItem(queueKey,JSON.stringify(queue));
    const optimistic:Message={id:localId,conversation_id:conversationId,sender_id:session.user.id,body:text,message_type:'text',created_at:createdAt,mine:true,pending:true};
    setMessages(prev=>({...prev,[conversationId]:[...(prev[conversationId]||[]).filter(item=>item.id!==localId),optimistic]}));
    setChats(prev=>{
      const exists=prev.some(chat=>chat.id===conversationId);
      const next=exists
        ?prev.map(chat=>chat.id===conversationId?{...chat,last:text,time:timeLabel(createdAt),lastAt:Date.now(),hasPendingActivity:true}:chat)
        :chatForInbox?[{...chatForInbox,last:text,time:timeLabel(createdAt),lastAt:Date.now(),hasPendingActivity:true},...prev]:prev;
      const sorted=sortInboxChats(next);
      void AsyncStorage.setItem('guftin-cache-inbox:'+session.user.id,JSON.stringify(sorted)).catch(()=>{});
      return sorted;
    });
    void AsyncStorage.setItem('guftin-cache-messages:'+session.user.id+':'+conversationId,
      JSON.stringify([...(messages[conversationId]||[]).filter(item=>item.id!==localId),optimistic])).catch(()=>{});
    setDraft('');
  };

  const sendMessage=async()=>{
    const body=draft.trim();
    if(!body||!active||!session||sending||clearingConversationIds.current.has(active.id))return;
    if(active.kind==='channel'){
      if(!active.isChannelOwner){Alert.alert('Channel is read-only','Only the channel owner can publish updates.');return;}
      setSending(true);
      try{
        const {data,error}=await supabase.from('kc_messages').insert({conversation_id:active.id,sender_id:session.user.id,body,message_type:'text'})
          .select('id,conversation_id,sender_id,body,message_type,created_at').single();
        if(error)throw error;
        const item:Message={...data,mine:true};
        setMessages(prev=>({...prev,[active.id]:[...(prev[active.id]||[]),item]}));
        setDraft('');
        setChats(prev=>prev.map(chat=>chat.id===active.id?{...chat,last:body,time:timeLabel(data.created_at),lastAt:Date.now()}:chat));
        void dispatchPush(active.isOfficial?'official_broadcast':'message',data.id);
      }catch(error:any){Alert.alert('Channel update not sent',error?.message||'Please try again.');}
      finally{setSending(false);}
      return;
    }
    // Text can be stored locally before the encryption roster is online.
    // The background sender waits for the device key and network before delivery.
    setSending(true);
    try{
      const chatToSend=await ensureActiveDirectConversation(active);
      // Save locally first. The composer clears as soon as the message is safely queued;
      // server encryption, upload, and push delivery happen in the background.
      await queueOfflineTextMessage(chatToSend.id,body,chatToSend);
      setSending(false);
      void flushPendingMessagesRef.current?.();
    }catch(error:any){
      setSending(false);
      Alert.alert('Message could not be saved',error?.message||'Your draft is still available. Please try again.');
    }
  };

  const flushPendingMessages=useCallback(async()=>{
    if(!session||!deviceIdentity||e2eeStatus!=='ready'||!onlineRef.current||flushingPendingMessages.current)return;
    flushingPendingMessages.current=true;
    try{
      const queueKey='guftin-pending-messages:'+session.user.id;
      let queue:any[]=[];
      try{const raw=await AsyncStorage.getItem(queueKey);queue=raw?JSON.parse(raw):[];}catch{return;}
      if(!Array.isArray(queue)||queue.length===0)return;
      const remaining:any[]=[];
      for(let index=0;index<queue.length;index++){
        const pending=queue[index];
        if(clearingConversationIds.current.has(pending.conversation_id))continue;
        try{
          const {data:members,error:membersError}=await supabase.from('kc_conversation_members')
            .select('user_id').eq('conversation_id',pending.conversation_id);
          if(membersError)throw membersError;
          const memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
          if(!memberIds.includes(session.user.id))throw new Error('You are no longer a member of this conversation.');
          const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
            .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
          if(devicesError)throw devicesError;
          const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
          if(memberIds.some(id=>!registeredUsers.has(id)))throw new Error('A conversation member has not registered a secure device yet.');
          const encryptedBody=encryptMessageForDevices(pending.text,devices||[],deviceIdentity);
          if(clearingConversationIds.current.has(pending.conversation_id))continue;
          const inserted=await supabase.from('kc_messages').insert({
            id:pending.id,conversation_id:pending.conversation_id,sender_id:session.user.id,
            body:encryptedBody,message_type:'text'
          }).select('id,conversation_id,sender_id,message_type,created_at').single();
          let saved=inserted.data;
          if(inserted.error){
            if(inserted.error.code==='23505'){
              const existing=await supabase.from('kc_messages')
                .select('id,conversation_id,sender_id,message_type,created_at').eq('id',pending.id).maybeSingle();
              if(existing.error||!existing.data)throw inserted.error;
              saved=existing.data;
            }else throw inserted.error;
          }
          if(!saved)throw new Error('The queued message was not confirmed by the server.');
          const sentItem:Message={...saved,body:pending.text,mine:true,pending:false};
          setMessages(prev=>({...prev,[pending.conversation_id]:[
            ...(prev[pending.conversation_id]||[]).filter(item=>item.id!==pending.localId&&item.id!==pending.id),sentItem
          ]}));
          void dispatchPush('message',saved.id);
        }catch(error:any){
          remaining.push(...queue.slice(index));
          if(!isConnectivityFailure(error))console.warn('Pending message remains queued:',error?.message||error);
          break;
        }
      }
      // Preserve any messages appended while this batch was uploading.
      let concurrentItems:any[]=[];
      try{
        const latestRaw=await AsyncStorage.getItem(queueKey);
        const latest=latestRaw?JSON.parse(latestRaw):[];
        if(Array.isArray(latest)){
          const originalIds=new Set(queue.map((item:any)=>item.id));
          concurrentItems=latest.filter((item:any)=>!originalIds.has(item.id));
        }
      }catch{}
      await AsyncStorage.setItem(queueKey,JSON.stringify([...remaining,...concurrentItems])).catch(()=>{});
      if(remaining.length<queue.length)void loadInbox();
    }finally{
      flushingPendingMessages.current=false;
    }
  },[session,deviceIdentity,e2eeStatus,loadInbox]);
  flushPendingMessagesRef.current=flushPendingMessages;

  const queueOfflineMedia=async(conversationId:string,asset:any,messageType:'image'|'video'|'file',contentType:string,id:string,localId:string)=>{
    if(!session||!deviceIdentity)throw new Error('Secure chat is not ready.');
    if(clearingConversationIds.current.has(conversationId))throw new Error('This chat is being cleared. Please try again in a moment.');
    const sourceFile=new File(asset.uri);
    const plainBytes=new Uint8Array(await sourceFile.arrayBuffer());
    const selfDevice={id:deviceIdentity.deviceId,user_id:session.user.id,public_key:deviceIdentity.publicKeyHex};
    const localEncrypted=encryptMediaForDevices(
      plainBytes,[selfDevice],deviceIdentity,contentType,
      asset.fileName||('attachment.'+(messageType==='video'?'mp4':messageType==='image'?'jpg':'bin'))
    );
    plainBytes.fill(0);
    const localPath=new File(Paths.document,'guftin-pending-'+id+'.enc');
    if(localPath.exists)localPath.delete();
    localPath.create();
    await localPath.write(localEncrypted.ciphertext);
    localEncrypted.ciphertext.fill(0);
    const entry={
      id,localId,conversation_id:conversationId,message_type:messageType,contentType,
      fileName:asset.fileName||('attachment.'+(messageType==='video'?'mp4':messageType==='image'?'jpg':'bin')),
      localBody:localEncrypted.body,localFileUri:localPath.uri,created_at:new Date().toISOString()
    };
    if(clearingConversationIds.current.has(conversationId))throw new Error('This chat is being cleared. Please try again in a moment.');
    const queueKey='guftin-pending-media:'+session.user.id;
    let queue:any[]=[];
    try{const raw=await AsyncStorage.getItem(queueKey);queue=raw?JSON.parse(raw):[];if(!Array.isArray(queue))queue=[];}catch{queue=[];}
    if(clearingConversationIds.current.has(conversationId))throw new Error('This chat is being cleared. Please try again in a moment.');
    queue.push(entry);
    await AsyncStorage.setItem(queueKey,JSON.stringify(queue));
    void AsyncStorage.setItem('guftin-cache-messages:'+session.user.id+':'+conversationId,
      JSON.stringify(messages[conversationId]||[])).catch(()=>{});
  };

  const flushPendingMedia=useCallback(async()=>{
    if(!session||!deviceIdentity||e2eeStatus!=='ready'||!onlineRef.current||flushingPendingMedia.current)return;
    flushingPendingMedia.current=true;
    try{
      const queueKey='guftin-pending-media:'+session.user.id;
      let queue:any[]=[];
      try{const raw=await AsyncStorage.getItem(queueKey);queue=raw?JSON.parse(raw):[];}catch{return;}
      if(!Array.isArray(queue)||queue.length===0)return;
      const remaining:any[]=[];
      for(let index=0;index<queue.length;index++){
        const pending=queue[index];
        if(clearingConversationIds.current.has(pending.conversation_id))continue;
        let plainBytes:Uint8Array|undefined;
        let outboundCipher:Uint8Array|undefined;
        try{
          let outboundBody=pending.outboundBody as string|undefined;
          let outboundFileUri=pending.outboundFileUri as string|undefined;
          let objectPath=pending.objectPath as string|undefined;
          if(!outboundBody||!outboundFileUri||!objectPath){
            const {data:members,error:membersError}=await supabase.from('kc_conversation_members')
              .select('user_id').eq('conversation_id',pending.conversation_id);
            if(membersError)throw membersError;
            const memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
            if(!memberIds.includes(session.user.id))throw new Error('You are no longer a member of this conversation.');
            const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
              .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
            if(devicesError)throw devicesError;
            const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
            if(memberIds.some(id=>!registeredUsers.has(id)))throw new Error('A chat member has not registered a secure device yet.');
            const encryptedLocal=new File(pending.localFileUri);
            if(!encryptedLocal.exists)throw new Error('The saved offline media file is missing on this phone.');
            const localCipher=new Uint8Array(await encryptedLocal.arrayBuffer());
            const opened=decryptMediaForDevice(localCipher,pending.localBody,deviceIdentity);
            localCipher.fill(0);
            plainBytes=opened.bytes;
            const outgoing=encryptMediaForDevices(plainBytes,devices||[],deviceIdentity,pending.contentType,pending.fileName);
            outboundBody=outgoing.body;
            objectPath=session.user.id+'/'+pending.conversation_id+'/queued_'+pending.id+'.enc';
            const outboundFile=new File(Paths.document,'guftin-outbound-'+pending.id+'.enc');
            if(outboundFile.exists)outboundFile.delete();
            outboundFile.create();
            await outboundFile.write(outgoing.ciphertext);
            outboundFileUri=outboundFile.uri;
            outgoing.ciphertext.fill(0);
            pending.outboundBody=outboundBody;
            pending.outboundFileUri=outboundFileUri;
            pending.objectPath=objectPath;
            queue[index]=pending;
            await AsyncStorage.setItem(queueKey,JSON.stringify(queue));
          }
          const outboundFile=new File(outboundFileUri);
          if(!outboundFile.exists)throw new Error('The encrypted upload file is missing on this phone.');
          outboundCipher=new Uint8Array(await outboundFile.arrayBuffer());
          const existing=await supabase.from('kc_messages')
            .select('id,conversation_id,sender_id,message_type,attachment_url,created_at')
            .eq('id',pending.id).maybeSingle();
          if(existing.error)throw existing.error;
          let saved=existing.data;
          if(!saved){
            if(clearingConversationIds.current.has(pending.conversation_id))continue;
            const {data:signed}=await supabase.storage.from('chat-media').createSignedUrl(objectPath,60);
            if(!signed?.signedUrl){
              const {error:uploadError}=await supabase.storage.from('chat-media').upload(objectPath,outboundCipher,{
                contentType:'application/octet-stream',cacheControl:'3600',upsert:false
              });
              if(uploadError&&String(uploadError.message||'').toLowerCase().includes('already exists')===false)throw uploadError;
            }
            if(clearingConversationIds.current.has(pending.conversation_id))continue;
            const inserted=await supabase.from('kc_messages').insert({
              id:pending.id,conversation_id:pending.conversation_id,sender_id:session.user.id,
              body:outboundBody,message_type:pending.message_type,attachment_url:objectPath
            }).select('id,conversation_id,sender_id,message_type,attachment_url,created_at').single();
            saved=inserted.data;
            if(inserted.error){
              if(inserted.error.code==='23505'){
                const duplicate=await supabase.from('kc_messages')
                  .select('id,conversation_id,sender_id,message_type,attachment_url,created_at')
                  .eq('id',pending.id).maybeSingle();
                if(duplicate.error||!duplicate.data)throw inserted.error;
                saved=duplicate.data;
              }else throw inserted.error;
            }
          }
          if(!saved)throw new Error('The media message was not confirmed by the server.');
          const localEncrypted=new File(pending.localFileUri);
          const localCipher=new Uint8Array(await localEncrypted.arrayBuffer());
          const opened=decryptMediaForDevice(localCipher,pending.localBody,deviceIdentity);
          localCipher.fill(0);
          const safeExtension=(opened.fileName.split('.').pop()|| (pending.message_type==='video'?'mp4':pending.message_type==='image'?'jpg':'bin')).toLowerCase().replace(/[^a-z0-9]/g,'')||'bin';
          const previewFile=new File(Paths.document,'guftin_media_'+pending.id+'.'+safeExtension);
          if(previewFile.exists)previewFile.delete();
          previewFile.create();
          await previewFile.write(opened.bytes);
          opened.bytes.fill(0);
          const sentItem:Message={
            ...saved,body:pending.message_type==='video'?'Video':(pending.fileName||'Photo'),
            attachment_url:previewFile.uri,mine:true,pending:false
          };
          setMessages(prev=>({...prev,[pending.conversation_id]:[
            ...(prev[pending.conversation_id]||[]).filter(item=>item.id!==pending.localId&&item.id!==pending.id),sentItem
          ]}));
          void dispatchPush('message',saved.id);
          try{if(localEncrypted.exists)localEncrypted.delete();}catch{}
          try{if(outboundFile.exists)outboundFile.delete();}catch{}
        }catch(error:any){
          remaining.push(...queue.slice(index));
          if(!isConnectivityFailure(error))console.warn('Pending media remains queued:',error?.message||error);
          break;
        }finally{
          plainBytes?.fill(0);
          outboundCipher?.fill(0);
        }
      }
      // Preserve media added while this upload batch was running.
      let concurrentItems:any[]=[];
      try{
        const latestRaw=await AsyncStorage.getItem(queueKey);
        const latest=latestRaw?JSON.parse(latestRaw):[];
        if(Array.isArray(latest)){
          const originalIds=new Set(queue.map((item:any)=>item.id));
          concurrentItems=latest.filter((item:any)=>!originalIds.has(item.id));
        }
      }catch{}
      await AsyncStorage.setItem(queueKey,JSON.stringify([...remaining,...concurrentItems])).catch(()=>{});
      if(remaining.length<queue.length)void loadInbox();
    }finally{
      flushingPendingMedia.current=false;
    }
  },[session,deviceIdentity,e2eeStatus,loadInbox]);
  flushPendingMediaRef.current=flushPendingMedia;

  useEffect(()=>{
    if(session&&deviceIdentity&&e2eeStatus==='ready'){
      void flushPendingMessages();
      void flushPendingMedia();
    }
  },[session?.user?.id,deviceIdentity?.deviceId,e2eeStatus,flushPendingMessages,flushPendingMedia]);

  const uploadVoiceMessage=async(uri:string)=>{
    if(!active||!session||!deviceIdentity||e2eeStatus!=='ready')throw new Error('Secure chat is not ready.');
    const file=new File(uri);
    if(file.size>MAX_MEDIA_BYTES)throw new Error('This file is larger than the current 45 MB cloud-storage limit.');

    // A not-yet-started direct chat can validate its peer roster without first
    // persisting an empty conversation. Create the conversation only after
    // the media is encrypted and the upload is ready to become a message.
    let memberIds:string[];
    if(active.pendingContactId){
      memberIds=[session.user.id,active.pendingContactId];
    }else{
      const {data:members,error:membersError}=await supabase.from('kc_conversation_members')
        .select('user_id').eq('conversation_id',active.id);
      if(membersError)throw membersError;
      memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
    }
    if(!memberIds.includes(session.user.id))throw new Error('You are no longer a member of this conversation.');

    const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
      .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
    if(devicesError)throw devicesError;
    const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
    if(memberIds.some(id=>!registeredUsers.has(id)))throw new Error('All chat members must open the latest Guftin build first.');

    const plain=new Uint8Array(await file.arrayBuffer());
    const encrypted=encryptMediaForDevices(plain,devices||[],deviceIdentity,'audio/mp4','voice-message.m4a');
    plain.fill(0);

    const pathSegment=active.pendingContactId||active.id;
    const objectPath=session.user.id+'/'+pathSegment+'/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.enc';
    const {error:uploadError}=await supabase.storage.from('chat-media').upload(
      objectPath,encrypted.ciphertext,{contentType:'application/octet-stream',upsert:false}
    );
    encrypted.ciphertext.fill(0);
    if(uploadError)throw uploadError;

    try{
      const chatToSend=await ensureActiveDirectConversation(active);
      const conversationId=chatToSend.id;
      const {data,error}=await supabase.from('kc_messages').insert({
        conversation_id:conversationId,sender_id:session.user.id,body:encrypted.body,
        message_type:'audio',attachment_url:objectPath
      }).select('id,conversation_id,sender_id,message_type,attachment_url,created_at').single();
      if(error)throw error;
      void dispatchPush('message',data.id);
      const item=await resolveMessage({...data,body:encrypted.body});
      setMessages(prev=>({...prev,[conversationId]:[...(prev[conversationId]||[]),item]}));
      void loadInbox();
    }catch(error:any){
      await supabase.storage.from('chat-media').remove([objectPath]).catch(()=>{});
      throw error;
    }
  };

  const startVoiceRecording=async()=>{
    if(recording||recordingBusy)return;
    try{
      const permission=await Audio.requestPermissionsAsync();if(!permission.granted)throw new Error('Microphone permission is required.');
      await Audio.setAudioModeAsync({allowsRecordingIOS:true,playsInSilentModeIOS:true,shouldDuckAndroid:true,playThroughEarpieceAndroid:false});
      const next=new Audio.Recording();await next.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);await next.startAsync();setRecording(next);
    }catch(e:any){Alert.alert('Recording unavailable',e?.message||'Check microphone permission.');}
  };

  const stopVoiceRecording=async()=>{
    if(!recording||recordingBusy)return;setRecordingBusy(true);
    try{
      await recording.stopAndUnloadAsync();
      const uri=recording.getURI();
      setRecording(null);
      if(uri)await uploadVoiceMessage(uri);
    }catch(e:any){
      Alert.alert('Voice message not sent',e?.message||'Please try again.');
    }finally{
      setRecording(null);
      // Reset Android as well as iOS audio flags even when the upload fails.
      try{
        await Audio.setAudioModeAsync({
          allowsRecordingIOS:false,
          playsInSilentModeIOS:true,
          shouldDuckAndroid:false,
          playThroughEarpieceAndroid:false
        });
      }catch(audioModeError:any){
        console.warn('Guftin could not restore media mode after voice recording:',audioModeError?.message||audioModeError);
      }
      setRecordingBusy(false);
    }
  };

  const sendPhotosVideos=async()=>{
    if(!active||!session||mediaPreparing)return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      Alert.alert('Secure media is not ready','Guftin is still setting up this device encryption key.');
      return;
    }
    try{
      const result=await ImagePicker.launchImageLibraryAsync({
        mediaTypes:['images','videos'],allowsEditing:false,quality:0.85,videoMaxDuration:60
      });
      if(result.canceled||!result.assets?.length)return;
      const asset=result.assets[0];
      const messageType=asset.type==='video'?'video':'image';
      const file=new File(asset.uri);
      if(file.size>MAX_MEDIA_BYTES){
        Alert.alert('File too large','Encrypted photos and videos can be up to 45 MB with the current cloud-storage limit.');
        return;
      }
      const contentType=asset.mimeType||(messageType==='video'?'video/mp4':'image/jpeg');
      const allowed=['image/jpeg','image/png','image/webp','video/mp4'];
      if(!allowed.includes(contentType)){
        Alert.alert('Unsupported format','Please choose a JPG, PNG, WEBP image or MP4 video.');
        return;
      }
      const chatToSend=await ensureActiveDirectConversation(active);
      const conversationId=chatToSend.id;
      const id=ExpoCrypto.randomUUID();
      const localId='pending:'+id;
      const createdAt=new Date().toISOString();
      const optimistic:Message={
        id:localId,conversation_id:conversationId,sender_id:session.user.id,
        body:messageType==='video'?(asset.fileName||'Video'):(asset.fileName||'Photo'),
        message_type:messageType,attachment_url:asset.uri,created_at:createdAt,mine:true,pending:true
      };
      // Paint the media bubble immediately; encrypting and uploading are background work.
      setMessages(prev=>({...prev,[conversationId]:[...(prev[conversationId]||[]),optimistic]}));
      setMediaPreparing(true);
      try{
        await queueOfflineMedia(conversationId,asset,messageType,contentType,id,localId);
        setChats(prev=>{
          const exists=prev.some(chat=>chat.id===conversationId);
          const inboxChat={...chatToSend,last:messageType==='video'?'Video':'Photo',time:timeLabel(createdAt),lastAt:Date.now(),hasPendingActivity:true};
          const next=exists?prev.map(chat=>chat.id===conversationId?inboxChat:chat):[inboxChat,...prev];
          const sorted=sortInboxChats(next);
          void AsyncStorage.setItem('guftin-cache-inbox:'+session.user.id,JSON.stringify(sorted)).catch(()=>{});
          return sorted;
        });
        setMediaPreparing(false);
        void flushPendingMediaRef.current?.();
      }catch(queueError:any){
        setMessages(prev=>({...prev,[conversationId]:(prev[conversationId]||[]).filter(item=>item.id!==localId)}));
        setMediaPreparing(false);
        Alert.alert('Media could not be saved',queueError?.message||'The media file could not be kept on this phone.');
      }
    }catch(e:any){
      setMediaPreparing(false);
      Alert.alert('Encrypted media not sent',e?.message||'Please try another image or video.');
    }
  };

  const sendDocument=async()=>{
    if(!active||!session||mediaPreparing)return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      Alert.alert('Secure document sharing not ready','Guftin is still setting up this device encryption key.');
      return;
    }
    try{
      const result=await DocumentPicker.getDocumentAsync({
        type:[
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'text/plain','text/csv'
        ],
        copyToCacheDirectory:true,
        multiple:false
      });
      if(result.canceled||!result.assets?.length)return;
      const asset=result.assets[0];
      const fileName=String(asset.name||'document');
      const extension=(fileName.split('.').pop()||'').toLowerCase();
      const allowedExtensions=['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv'];
      const contentType=asset.mimeType&&asset.mimeType!=='application/octet-stream'
        ?asset.mimeType:getDocumentMimeType(fileName);
      const allowedTypes=[
        'application/pdf','application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain','text/csv'
      ];
      if(!allowedExtensions.includes(extension)||!allowedTypes.includes(contentType)){
        Alert.alert('Unsupported document','Choose a PDF, Word, Excel, PowerPoint, TXT or CSV document.');
        return;
      }
      const sourceFile=new File(asset.uri);
      const byteSize=typeof asset.size==='number'?asset.size:sourceFile.size;
      if(byteSize>MAX_MEDIA_BYTES){
        Alert.alert('Document too large','Encrypted documents can be up to 45 MB with the current cloud-storage limit.');
        return;
      }
      const chatToSend=await ensureActiveDirectConversation(active);
      const conversationId=chatToSend.id;
      const id=ExpoCrypto.randomUUID();
      const localId='pending:'+id;
      const createdAt=new Date().toISOString();
      const optimistic:Message={
        id:localId,conversation_id:conversationId,sender_id:session.user.id,
        body:fileName,message_type:'file',attachment_url:asset.uri,
        created_at:createdAt,mine:true,pending:true
      };
      setMessages(prev=>({...prev,[conversationId]:[...(prev[conversationId]||[]),optimistic]}));
      setMediaPreparing(true);
      try{
        await queueOfflineMedia(conversationId,{...asset,fileName},'file',contentType,id,localId);
        setChats(prev=>{
          const exists=prev.some(chat=>chat.id===conversationId);
          const inboxChat={...chatToSend,last:'Document: '+fileName,time:timeLabel(createdAt),lastAt:Date.now(),hasPendingActivity:true};
          const next=exists?prev.map(chat=>chat.id===conversationId?inboxChat:chat):[inboxChat,...prev];
          const sorted=sortInboxChats(next);
          void AsyncStorage.setItem('guftin-cache-inbox:'+session.user.id,JSON.stringify(sorted)).catch(()=>{});
          return sorted;
        });
        setMediaPreparing(false);
        void flushPendingMediaRef.current?.();
      }catch(queueError:any){
        setMessages(prev=>({...prev,[conversationId]:(prev[conversationId]||[]).filter(item=>item.id!==localId)}));
        setMediaPreparing(false);
        Alert.alert('Document could not be saved',queueError?.message||'The document could not be kept on this phone.');
      }
    }catch(error:any){
      setMediaPreparing(false);
      Alert.alert('Document not shared',error?.message||'Please choose another document.');
    }
  };

  const sendChannelMedia=async()=>{
    if(!active||active.kind!=='channel'||!active.isChannelOwner||!session||mediaPreparing)return;
    try{
      const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images','videos'],allowsEditing:false,quality:0.9,videoMaxDuration:60});
      if(result.canceled||!result.assets?.length)return;
      const asset=result.assets[0];
      const messageType=asset.type==='video'?'video':'image';
      const contentType=asset.mimeType||(messageType==='video'?'video/mp4':'image/jpeg');
      if(!['image/jpeg','image/png','image/webp','video/mp4'].includes(contentType))throw new Error('Choose a JPG, PNG, WEBP image or MP4 video.');
      const source=new File(asset.uri);
      if(source.size>MAX_MEDIA_BYTES)throw new Error('Channel media is limited to 45 MB per photo or video.');
      setMediaPreparing(true);
      const bytes=new Uint8Array(await source.arrayBuffer());
      const extension=messageType==='video'?'mp4':contentType==='image/png'?'png':contentType==='image/webp'?'webp':'jpg';
      const objectPath=session.user.id+'/'+active.id+'/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.'+extension;
      const {error:uploadError}=await supabase.storage.from('chat-media').upload(objectPath,bytes,{contentType,upsert:false});
      bytes.fill(0);
      if(uploadError)throw uploadError;
      const {data,error}=await supabase.from('kc_messages').insert({conversation_id:active.id,sender_id:session.user.id,body:asset.fileName||(messageType==='video'?'Video':'Photo'),message_type:messageType,attachment_url:objectPath})
        .select('id,conversation_id,sender_id,body,message_type,attachment_url,created_at').single();
      if(error){await supabase.storage.from('chat-media').remove([objectPath]);throw error;}
      const item=await resolveMessage({...data,mine:true});
      setMessages(prev=>({...prev,[active.id]:[...(prev[active.id]||[]),item]}));
      setChats(prev=>prev.map(chat=>chat.id===active.id?{...chat,last:messageType==='video'?'Video':'Photo',time:timeLabel(data.created_at),lastAt:Date.now()}:chat));
      void dispatchPush(active.isOfficial?'official_broadcast':'message',data.id);
    }catch(error:any){Alert.alert('Channel media not posted',error?.message||'Please try again.');}
    finally{setMediaPreparing(false);}
  };

  const sendMedia=()=>{
    if(active?.kind==='channel'){
      if(!active.isChannelOwner){Alert.alert('Channel is read-only','Only the channel owner can publish media.');return;}
      void sendChannelMedia();return;
    }
    Alert.alert('Attach to chat','Choose what you want to share.',[
      {text:'Photo or video',onPress:()=>void sendPhotosVideos()},
      {text:'PDF or document',onPress:()=>void sendDocument()},
      {text:'Cancel',style:'cancel'}
    ]);
  };

  const startCall=async(callType:'voice'|'video')=>{
    if(!active||!session||callBusy)return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      Alert.alert('Secure calling not ready','Open Guftin on both phones and wait until secure chat is ready before starting a call.');
      return;
    }
    if(!['direct','group'].includes(active.kind)){
      Alert.alert('Calling unavailable','Calls are available in direct chats and groups.');
      return;
    }
    setCallBusy(true);
    try{
      let memberIds:string[];
      if(active.pendingContactId){
        memberIds=[session.user.id,active.pendingContactId];
      }else{
        const {data:members,error:memberError}=await supabase.from('kc_conversation_members')
          .select('user_id').eq('conversation_id',active.id);
        if(memberError)throw memberError;
        memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
      }
      if(!memberIds.includes(session.user.id))throw new Error('You are no longer a member of this conversation.');
      if(active.kind==='direct'&&(memberIds.length!==2||memberIds.filter(id=>id!==session.user.id).length!==1))
        throw new Error('This direct call needs exactly one other member.');
      if(active.kind==='group'&&(memberIds.length<2||memberIds.length>20))
        throw new Error('Group calls need 2–20 group members, including you.');
      const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
        .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
      if(devicesError)throw devicesError;
      const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
      if(memberIds.some((id:string)=>!registeredUsers.has(id)))
        throw new Error('Every participant must open the latest Guftin version and register a secure device before this encrypted call can start.');
      if(!(devices||[]).some((device:any)=>device.id===deviceIdentity.deviceId))
        throw new Error('This phone is not in the conversation encryption roster. Reopen Guftin and try again.');
      const callKey=ExpoCrypto.getRandomBytes(32);
      let e2eeKeyEnvelopes:any;
      try{
        e2eeKeyEnvelopes=encryptCallKeyForDevices(callKey,devices||[],deviceIdentity);
      }finally{
        callKey.fill(0);
      }
      const callChat=await ensureActiveDirectConversation(active);
      let call:any;
      if(callChat.kind==='group'){
        const {data,error}=await supabase.rpc('kc_create_group_call',{
          p_conversation_id:callChat.id,
          p_call_type:callType,
          p_e2ee_key_envelopes:e2eeKeyEnvelopes
        });
        if(error)throw error;
        const callId=typeof data==='string'?data:(Array.isArray(data)?data[0]:data);
        if(!callId)throw new Error('The group call was created but the call ID was not returned.');
        call={id:callId,conversation_id:callChat.id,caller_id:session.user.id,call_type:callType,status:'ringing',call_scope:'group'};
      }else{
        const peer=memberIds.find(id=>id!==session.user.id);
        const {data,error}=await supabase.from('kc_call_logs').insert({
          conversation_id:callChat.id,
          caller_id:session.user.id,
          callee_id:peer,
          call_type:callType,
          status:'ringing',
          call_scope:'direct',
          e2ee_key_envelopes:e2eeKeyEnvelopes
        }).select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope').single();
        if(error)throw error;
        call=data;
      }
      // Use Guftin's own full-screen outgoing call page. Calling
      // RNCallKeep.startCall here also launches the generic Android Telecom
      // outgoing flow and can cover the app's custom call screen.
      setIncomingCall(null);
      setOutgoingCall({...call,contact_name:callChat.name,contact_avatar:callChat.avatar,contact_avatar_url:callChat.avatarUrl});
      void dispatchPush('call',call.id);
      void loadInbox();
    }catch(e:any){
      Alert.alert('Call could not start',e?.message||'Please try again.');
    }finally{
      setCallBusy(false);
    }
  };

  const endCall=async(callId:string,fromNative=false)=>{
    if(!callId||endingCallIds.current.has(callId))return;
    endingCallIds.current.add(callId);

    const endingGroup=(liveCall?.id===callId&&liveCall?.callScope==='group')||(outgoingCall?.id===callId&&outgoingCall?.call_scope==='group');
    const hasNativeIncomingCall=(liveCall?.id===callId&&liveCall?.nativeIncomingCall)||(incomingCall?.id===callId);

    // Telecom can ask us to end an active call without going through the
    // in-call button. Disconnect LiveKit before changing state or releasing
    // Android's communication audio focus.
    if(liveCall?.id===callId){
      const recordingController=activeGuftinCallRecordingController;
      if(recordingController?.callId===callId){
        try{await recordingController.stopAndSave();}
        catch(error:any){console.warn('Guftin recording stop before call end:',error?.message||error);}
      }
      const roomController=activeGuftinCallRoom;
      if(roomController?.callId===callId&&!roomController.disconnected){
        try{await roomController.disconnect();}
        catch(error:any){console.warn('Guftin forced call disconnect:',error?.message||error);}
      }
      await stopGuftinCallAudioSession();
    }

    // Clear the local call UI immediately; network updates must not hold audio
    // resources or leave a stale call screen on the device.
    setLiveCall(null);
    setOutgoingCall(null);
    setIncomingCall(null);
    setPendingCallAccept((old:any)=>old?.id===callId?null:old);
    void dismissIncomingCallNotification(callId);

    if(hasNativeIncomingCall&&Platform.OS==='android'){
      try{RNCallKeep.endCall(callId);}catch(error:any){console.warn('Could not end Android Telecom call:',error?.message||error);}
    }

    try{
      if(endingGroup){
        const {error}=await supabase.rpc('kc_leave_group_call',{p_call_id:callId});
        if(error)throw error;
      }else{
        const {error}=await supabase.from('kc_call_logs')
          .update({status:'ended',ended_at:new Date().toISOString()}).eq('id',callId);
        if(error)throw error;
      }
    }catch(error:any){
      console.warn('Guftin call-end server update failed:',error?.message||error);
      Alert.alert('Call disconnected','The phone audio has been restored, but the server could not update the call status. Reopen Calls when your internet connection is available.');
    }finally{
      // Avoid an unbounded per-session set while retaining short-term duplicate protection.
      if(endingCallIds.current.size>128){
        const oldest=endingCallIds.current.values().next().value;
        if(oldest)endingCallIds.current.delete(oldest);
      }
    }
  };

  const pendingNativeCallActions=useRef<Array<{callUUID:string;action:'answer'|'end'}>>([]);
  const processedNativeCallActions=useRef<Set<string>>(new Set());
  const handleNativeCallAction=useCallback(async(callUUID:string,action:'answer'|'end')=>{
    if(!callUUID)return;
    if(!session?.user?.id){
      pendingNativeCallActions.current.push({callUUID,action});
      return;
    }
    const actionKey=callUUID+':'+action;
    if(processedNativeCallActions.current.has(actionKey))return;
    if(action==='answer'&&Platform.OS==='android'){
      try{await RNCallKeep.backToForeground();}
      catch(foregroundError:any){console.warn('Could not bring Guftin to foreground after call answer:',foregroundError?.message||foregroundError);}
    }
    processedNativeCallActions.current.add(actionKey);
    try{
      const {data:call,error}=await supabase.from('kc_call_logs')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope')
        .eq('id',callUUID).maybeSingle();
      if(error)throw error;
      if(!call)return;
      const groupCall=(call.call_scope||'direct')==='group';
      let groupParticipant:any=null;
      if(groupCall){
        const result=await supabase.from('kc_call_participants')
          .select('status,role').eq('call_id',call.id).eq('user_id',session.user.id).maybeSingle();
        if(result.error)throw result.error;
        groupParticipant=result.data;
        if(!groupParticipant)return;
      }else if(call.caller_id!==session.user.id&&call.callee_id!==session.user.id)return;

      if(action==='answer'){
        const canAnswer=groupCall
          ?groupParticipant.role==='invitee'&&['ringing','invited'].includes(groupParticipant.status)
          :call.callee_id===session.user.id&&call.status==='ringing';
        if(canAnswer){
          setTab('Calls');
          await acceptCallWhenReady(call);
        }else if(call.status==='accepted'&&(!groupCall||groupParticipant.status==='accepted')){
          setTab('Calls');
          if(!liveCall)void joinCall(call);
        }
      }else if(groupCall&&groupParticipant.role==='invitee'&&['ringing','invited'].includes(groupParticipant.status)&&['ringing','accepted'].includes(call.status)){
        await respondToCall(call,'declined');
      }else if(call.status==='ringing'&&!groupCall&&call.callee_id===session.user.id){
        await respondToCall(call,'declined');
      }else if(call.status==='ringing'&&groupCall&&groupParticipant.role==='caller'){
        await endCall(call.id,true);
      }else if(call.status==='ringing'&&!groupCall&&call.caller_id===session.user.id){
        await supabase.from('kc_call_logs').update({status:'cancelled',ended_at:new Date().toISOString()}).eq('id',call.id);
        setOutgoingCall(null);
      }else if(call.status==='accepted'){
        await endCall(call.id,true);
      }
    }catch(error:any){
      console.warn('Native call action failed:',error?.message||error);
    }
  },[session,acceptCallWhenReady,respondToCall,joinCall,liveCall,outgoingCall]);

  const nativeCallActionHandlerRef=useRef<any>(null);
  nativeCallActionHandlerRef.current=handleNativeCallAction;

  useEffect(()=>{
    if(Platform.OS!=='android')return;
    const answerSub=RNCallKeep.addEventListener('answerCall',({callUUID}:any)=>{
      void nativeCallActionHandlerRef.current?.(callUUID,'answer');
    });
    const endSub=RNCallKeep.addEventListener('endCall',({callUUID}:any)=>{
      void nativeCallActionHandlerRef.current?.(callUUID,'end');
    });
    const showUiSub=RNCallKeep.addEventListener('showIncomingCallUi',({callUUID}:any)=>{
      if(!session?.user?.id||!callUUID)return;
      try{RNCallKeep.backToForeground();}catch(foregroundError:any){
        console.warn('Could not foreground Guftin for incoming call:',foregroundError?.message||foregroundError);
      }
      void supabase.from('kc_call_logs')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,call_scope')
        .eq('id',callUUID).maybeSingle().then(async({data:call,error})=>{
          if(error||!call||call.status!=='ringing')return;
          if((call.call_scope||'direct')==='group'){
            const {data:participant,error:participantError}=await supabase.from('kc_call_participants')
              .select('status,role').eq('call_id',call.id).eq('user_id',session.user.id).maybeSingle();
            if(participantError||!participant||!['invited','ringing'].includes(participant.status))return;
          }else if(call.callee_id!==session.user.id)return;
          setTab('Calls');
          setIncomingCall(call);
        });
    });

    return ()=>{
      answerSub.remove();
      endSub.remove();
      showUiSub.remove();
    };
  },[session?.user?.id]);

  useEffect(()=>{
    if(!session?.user?.id||Platform.OS!=='android')return;
    const queued=pendingNativeCallActions.current.splice(0);
    for(const action of queued)void handleNativeCallAction(action.callUUID,action.action);
    void RNCallKeep.getInitialEvents().then((events:any[])=>{
      for(const event of events||[]){
        const uuid=event?.data?.callUUID;
        if(!uuid)continue;
        if(String(event.name||'').toLowerCase().includes('answer')){
          void handleNativeCallAction(uuid,'answer');
        }else if(String(event.name||'').toLowerCase().includes('end')){
          void handleNativeCallAction(uuid,'end');
        }
      }
      RNCallKeep.clearInitialEvents();
    }).catch(error=>console.warn('Could not restore native call actions:',error?.message||error));
  },[session?.user?.id,handleNativeCallAction]);

  const chooseProfilePhoto=async()=>{
    const permission=await ImagePicker.requestMediaLibraryPermissionsAsync();
    if(!permission.granted){Alert.alert('Permission needed','Allow photo access to choose a profile picture.');return;}
    const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images'],allowsEditing:true,aspect:[1,1],quality:0.85});
    if(result.canceled||!result.assets?.[0]||!session)return;
    setProfileUploading(true);
    try{
      const asset=result.assets[0],file=new File(asset.uri);
      if(file.size>10*1024*1024)throw new Error('Profile photo must be under 10 MB.');
      const bytes=new Uint8Array(await file.arrayBuffer()),objectPath=session.user.id+'/profile/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.jpg';
      const {error}=await supabase.storage.from('chat-media').upload(objectPath,bytes,{contentType:'image/jpeg',upsert:false});bytes.fill(0);
      if(error)throw error;
      const {error:profileError}=await supabase.rpc('kc_save_profile_avatar',{p_avatar_path:objectPath});
      if(profileError)throw profileError;
      const signedUrl=await getSignedMediaUrl(objectPath);
      setProfileAvatarPath(objectPath);
      setProfileAvatarUrl(signedUrl||asset.uri);
      setProfile((current:any)=>current?{...current,avatar_url:objectPath}:current);
    }catch(e:any){Alert.alert('Photo not saved',e?.message||'Please try again.');}
    finally{setProfileUploading(false);}
  };

  const chooseStatusMedia=async()=>{
    const permission=await ImagePicker.requestMediaLibraryPermissionsAsync();
    if(!permission.granted){Alert.alert('Permission needed','Allow photo/video access to share status media.');return;}
    const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images','videos'],allowsEditing:false,quality:0.85,videoMaxDuration:60});
    if(!result.canceled&&result.assets?.[0])setStatusAsset(result.assets[0]);
  };

  const publishStatus=async()=>{
    const caption=statusText.trim();
    if(!session||publishingStatus)return;
    if((!caption&&!statusAsset)||caption.length>700){Alert.alert('Status required','Write a caption or choose a photo/video (maximum 700 characters).');return;}
    setPublishingStatus(true);
    let media_url:string|null=null;
    if(statusAsset){
      try{
        const file=new File(statusAsset.uri);if(file.size>MAX_MEDIA_BYTES)throw new Error('Status photo or video must be under 45 MB with the current cloud-storage limit.');
        const bytes=new Uint8Array(await file.arrayBuffer()),ext=statusAsset.type==='video'?'mp4':'jpg',path=session.user.id+'/status/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.'+ext;
        const mime=statusAsset.mimeType||(statusAsset.type==='video'?'video/mp4':'image/jpeg');
        const {error:uploadError}=await supabase.storage.from('chat-media').upload(path,bytes,{contentType:mime,upsert:false});bytes.fill(0);
        if(uploadError)throw uploadError;media_url=path;
      }catch(e:any){setPublishingStatus(false);Alert.alert('Status upload failed',e?.message||'Please try again.');return;}
    }
    const {data:postedStatus,error}=await supabase.from('kc_status_updates').insert({user_id:session.user.id,caption:caption||null,media_url}).select('id').single();
    setPublishingStatus(false);
    if(error){
      Alert.alert('Status not posted',error.message);
      return;
    }
    setStatusComposer(false);
    setStatusText('');setStatusAsset(null);
    if(postedStatus?.id)void dispatchPush('status',postedStatus.id);
    await loadStatuses();
  };

  const signUpEmail=async()=>{
    const cleanEmail=email.trim().toLowerCase();
    const cleanUsername=username.trim().toLowerCase().replace(/^@/,'');
    const cleanName=fullName.trim();
    if(cleanName.length<2||cleanName.length>40){setAuthError('Enter your display name (2-40 characters).');return;}
    if(!/^[a-z0-9_]{3,24}$/.test(cleanUsername)){setAuthError('Username must be 3-24 characters using letters, numbers or underscore.');return;}
    if(!/^\S+@\S+\.\S+$/.test(cleanEmail)){setAuthError('Enter a valid email address.');return;}
    if(password.length<8){setAuthError('Password must be at least 8 characters.');return;}
    setAuthBusy(true);setAuthError('');
    const {data,error}=await supabase.auth.signUp({
      email:cleanEmail,password,
      options:{emailRedirectTo:AUTH_REDIRECT_URL,data:{display_name:cleanName,username:cleanUsername}}
    });
    setAuthBusy(false);
    if(error){setAuthError(error.message);return;}
    if(data.session){
      setAuthError('');
    }else{
      setAuthMode('login');
      setAuthError('Account created. Check your email inbox and confirm your address, then sign in.');
    }
  };

  const signInEmail=async()=>{
    const cleanEmail=email.trim().toLowerCase();
    if(!cleanEmail||!password){setAuthError('Enter your email and password.');return;}
    setAuthBusy(true);setAuthError('');
    const {error}=await supabase.auth.signInWithPassword({email:cleanEmail,password});
    setAuthBusy(false);
    if(error)setAuthError(error.message);
  };

  const finishProfile=async()=>{
    if(!session||savingProfile)return;
    const cleanUsername=profileUsername.trim().toLowerCase().replace(/^@/,'');
    const cleanName=profileName.trim();
    if(!/^[a-z0-9_]{3,24}$/.test(cleanUsername)){Alert.alert('Username not valid','Use 3-24 lowercase letters, numbers or underscore.');return;}
    if(cleanName.length<2||cleanName.length>40){Alert.alert('Name required','Use a name between 2 and 40 characters.');return;}
    setSavingProfile(true);
    const {error}=await supabase.rpc('kc_finish_profile',{p_username:cleanUsername,p_display_name:cleanName});
    setSavingProfile(false);
    if(error){Alert.alert('Profile not saved',error.message);return;}
    await loadProfile();
  };

  const addContact=async()=>{
    if(!session||adding)return;
    const cleanUsername=contactUsername.trim().toLowerCase().replace(/^@/,'');
    if(!/^[a-z0-9_]{3,24}$/.test(cleanUsername)){Alert.alert('Username not valid','Enter a username such as ali_786.');return;}
    setAdding(true);
    const {data,error}=await supabase.rpc('kc_save_contact_by_username',{p_username:cleanUsername});
    setAdding(false);
    if(error){Alert.alert('Could not find contact',error.message);return;}
    const row=Array.isArray(data)?data[0]:data;
    if(!row?.contact_id){Alert.alert('Contact not found','No registered Guftin account uses this username yet.');return;}
    setAddOpen(false);setContactUsername('');
    const name=row.display_name||row.username||'Guftin member';
    const chat:Chat={
      id:'pending:'+row.contact_id,pendingContactId:row.contact_id,
      name,avatar:initials(name),color:colorFor(name),
      last:'Start a conversation',time:'',unread:0,online:false,kind:'direct',lastAt:0
    };
    setPeerLastReadAt(null);
    setActive(chat);
  };

  const saveProfile=async()=>{
    if(!session||savingProfile)return;
    const cleanUsername=profileUsername.trim().toLowerCase().replace(/^@/,'');
    const cleanName=profileName.trim();
    if(cleanName.length<2||cleanName.length>40){Alert.alert('Name required','Use a name between 2 and 40 characters.');return;}
    if(!/^[a-z0-9_]{3,24}$/.test(cleanUsername)){Alert.alert('Username not valid','Use 3-24 lowercase letters, numbers or underscore.');return;}
    setSavingProfile(true);
    const {error}=await supabase.rpc('kc_finish_profile',{p_username:cleanUsername,p_display_name:cleanName});
    if(error){setSavingProfile(false);Alert.alert('Profile not saved',error.message);return;}
    const {error:aboutError}=await supabase.from('kc_profiles').update({about:about.trim().slice(0,160)}).eq('id',session.user.id);
    setSavingProfile(false);
    if(aboutError){Alert.alert('About text not saved',aboutError.message);return;}
    await loadProfile();
    Alert.alert('Saved','Your Guftin profile has been updated.');
  };

  const loadGroupContacts=async()=>{
    if(!session)return;
    setGroupContactsLoading(true);
    try{
      const {data:links,error}=await supabase.from('kc_contacts').select('contact_id').eq('owner_id',session.user.id);
      if(error)throw error;
      const ids=[...new Set((links||[]).map((row:any)=>row.contact_id).filter(Boolean))] as string[];
      if(!ids.length){setGroupContacts([]);return;}
      const {data:people,error:peopleError}=await supabase.from('kc_profiles')
        .select('id,display_name,username,avatar_url').in('id',ids).order('display_name');
      if(peopleError)throw peopleError;
      const contacts=await Promise.all((people||[]).map(async(person:any)=>{
        const avatar=person.avatar_url?(await getSignedMediaUrl(person.avatar_url))||undefined:undefined;
        return {...person,avatar_signed_url:avatar};
      }));
      setGroupContacts(contacts);
    }catch(e:any){
      Alert.alert('Contacts could not load',e?.message||'Please try again.');
    }finally{setGroupContactsLoading(false);}
  };

  const openGroupCreator=async()=>{
    setGroupName('');
    setSelectedGroupIds([]);
    setGroupCreateOpen(true);
    await loadGroupContacts();
  };

  const toggleGroupMember=(id:string)=>{
    setSelectedGroupIds(current=>current.includes(id)?current.filter(value=>value!==id):[...current,id]);
  };

  const createGroup=async()=>{
    const title=groupName.trim();
    if(!session||groupCreating)return;
    if(title.length<2||title.length>60){Alert.alert('Group name required','Enter a group name between 2 and 60 characters.');return;}
    if(selectedGroupIds.length<1){Alert.alert('Add members','Select at least one contact to create a group.');return;}
    setGroupCreating(true);
    try{
      const {data,error}=await supabase.rpc('kc_create_group',{p_title:title,p_member_ids:selectedGroupIds});
      if(error)throw error;
      const conversationId=typeof data==='string'?data:(Array.isArray(data)?data[0]:data);
      if(!conversationId)throw new Error('The group was created but its conversation ID was not returned.');
      const chat:Chat={id:conversationId,name:title,avatar:initials(title),color:colorFor(title),last:'Group created',time:timeLabel(new Date().toISOString()),unread:0,online:false,kind:'group',lastAt:Date.now()};
      setChats(current=>[chat,...current.filter(item=>item.id!==chat.id)]);
      setGroupCreateOpen(false);
      setActive(chat);
      void loadInbox();
    }catch(e:any){
      Alert.alert('Group could not be created',e?.message||'Please check your contacts and try again.');
    }finally{setGroupCreating(false);}
  };

  const openChatDetails=async()=>{
    if(!active||!session||chatDetailsLoading)return;
    setChatDetailsLoading(true);
    try{
      const [{data:conversation,error:conversationError},{data:members,error:membersError}]=await Promise.all([
        supabase.from('kc_conversations').select('id,kind,title,photo_url,created_at,created_by').eq('id',active.id).single(),
        supabase.from('kc_conversation_members').select('user_id,role,joined_at').eq('conversation_id',active.id)
      ]);
      if(conversationError)throw conversationError;
      if(membersError)throw membersError;
      const ids=[...new Set((members||[]).map((member:any)=>member.user_id))] as string[];
      const {data:people,error:peopleError}=await supabase.from('kc_profiles')
        .select('id,display_name,username,about,avatar_url,is_online,last_seen_at,created_at').in('id',ids);
      if(peopleError)throw peopleError;
      const peopleMap=new Map((people||[]).map((person:any)=>[person.id,person]));
      const details=await Promise.all((members||[]).map(async(member:any)=>{
        const person:any=peopleMap.get(member.user_id)||{};
        const avatar=person.avatar_url?(await getSignedMediaUrl(person.avatar_url))||null:null;
        return {...member,...person,avatar_signed_url:avatar,is_me:member.user_id===session.user.id};
      }));
      setChatDetails({conversation,members:details});
      setChatDetailsOpen(true);
    }catch(e:any){
      Alert.alert('Details could not load',e?.message||'Please try again.');
    }finally{setChatDetailsLoading(false);}
  };

  const loadStatuses=useCallback(async()=>{
    if(!session)return;
    const statusCacheKey='guftin-cache-statuses:'+session.user.id;
    // Paint the last successfully synced status feed immediately. Cached media
    // is stored as an app-private file so previously loaded statuses remain
    // viewable without a network connection.
    try{
      const cachedRaw=await AsyncStorage.getItem(statusCacheKey);
      if(cachedRaw){
        const cached=JSON.parse(cachedRaw);
        if(Array.isArray(cached)){
          const stillValid=cached.filter((item:any)=>!item.expires_at||new Date(item.expires_at).getTime()>Date.now());
          setStatuses(stillValid);
        }
      }
    }catch{ /* A damaged cache must never prevent online refresh. */ }
    if(!onlineRef.current)return;
    const {data,error}=await supabase.from('kc_status_updates')
      .select('id,user_id,caption,media_url,created_at,expires_at')
      .gt('expires_at',new Date().toISOString())
      .order('created_at',{ascending:false}).limit(100);
    if(error){if(!isConnectivityFailure(error))Alert.alert('Statuses could not load',error.message);return;}
    const rows=(data||[]) as any[];
    const ids=rows.map(row=>row.id);
    if(!ids.length){setStatuses([]);return;}

    // Record only the first view from this account; avoid repeated writes on refresh.
    const viewableIds=rows.filter(row=>row.user_id!==session.user.id).map(row=>row.id);
    if(viewableIds.length){
      const {data:existingViews}=await supabase.from('kc_status_views')
        .select('status_id').eq('viewer_id',session.user.id).in('status_id',viewableIds);
      const seenIds=new Set((existingViews||[]).map((view:any)=>view.status_id));
      const unseenIds=viewableIds.filter(id=>!seenIds.has(id));
      if(unseenIds.length){
        const {error:viewError}=await supabase.from('kc_status_views').upsert(
          unseenIds.map(status_id=>({status_id,viewer_id:session.user.id})),
          {onConflict:'status_id,viewer_id',ignoreDuplicates:true}
        );
        if(viewError)console.warn('Status view not recorded:',viewError.message);
        else for(const statusId of unseenIds)void dispatchPush('status_view',statusId);
      }
    }
    const [peopleResult,viewsResult,likesResult,officialResult]=await Promise.all([
      supabase.from('kc_profiles').select('id,display_name,username,avatar_url').in('id',[...new Set(rows.map(row=>row.user_id))]),
      supabase.from('kc_status_views').select('status_id,viewer_id,viewed_at').in('status_id',ids),
      supabase.from('kc_status_likes').select('status_id,user_id,created_at').in('status_id',ids),
      supabase.from('kc_channels').select('owner_id').eq('is_official',true).maybeSingle()
    ]);
    const people=new Map((peopleResult.data||[]).map((person:any)=>[person.id,person]));
    const statusActorIds=[...new Set([
      ...(viewsResult.data||[]).map((view:any)=>view.viewer_id),
      ...(likesResult.data||[]).map((like:any)=>like.user_id)
    ])];
    const {data:statusActors}=statusActorIds.length
      ?await supabase.from('kc_profiles').select('id,display_name,username').in('id',statusActorIds)
      :{data:[]};
    const statusActorMap=new Map((statusActors||[]).map((person:any)=>[person.id,person]));
    const mapped=await Promise.all(rows.map(async row=>{
      const signed=row.media_url?await getSignedMediaUrl(row.media_url):null;
      let playableMedia=signed;
      if(signed&&row.media_url){
        try{
          const rawExtension=String(row.media_url).split('.').pop()?.toLowerCase()||'jpg';
          const extension=rawExtension.replace(/[^a-z0-9]/g,'').slice(0,5)||'jpg';
          const localFile=new File(Paths.document,'guftin-status-'+row.id+'.'+extension);
          if(!localFile.exists)await File.downloadFileAsync(signed,localFile);
          if(localFile.exists)playableMedia=localFile.uri;
        }catch(downloadError:any){
          console.warn('Status offline media cache:',downloadError?.message||downloadError);
        }
      }
      const avatarPath=(people.get(row.user_id) as any)?.avatar_url||null;
      const avatarSigned=avatarPath?await getSignedMediaUrl(avatarPath):null;
      const views=(viewsResult.data||[]).filter((view:any)=>view.status_id===row.id);
      const likes=(likesResult.data||[]).filter((like:any)=>like.status_id===row.id);
      return {
        ...row,
        display_name:row.user_id===officialResult.data?.owner_id?'Guftin Official':((people.get(row.user_id) as any)?.display_name||'Guftin member'),
        username:row.user_id===officialResult.data?.owner_id?'':((people.get(row.user_id) as any)?.username||''),
        is_verified:row.user_id===officialResult.data?.owner_id,
        avatar_signed_url:avatarSigned,
        status_count:rows.filter(candidate=>candidate.user_id===row.user_id).length,
        media_signed_url:playableMedia,
        view_count:views.length,
        viewer_names:views.map((view:any)=>(statusActorMap.get(view.viewer_id) as any)?.display_name||'Guftin member'),
        liker_names:likes.map((like:any)=>(statusActorMap.get(like.user_id) as any)?.display_name||'Guftin member'),
        like_count:likes.length,
        liked_by_me:likes.some((like:any)=>like.user_id===session.user.id)
      };
    }));
    setStatuses(mapped);
    void AsyncStorage.setItem(statusCacheKey,JSON.stringify(mapped)).catch(()=>{});
  },[session,getSignedMediaUrl]);

  const toggleStatusLike=async(status:any)=>{
    if(!session||status.user_id===session.user.id)return;
    if(status.liked_by_me){
      const {error}=await supabase.from('kc_status_likes').delete()
        .eq('status_id',status.id).eq('user_id',session.user.id);
      if(error){Alert.alert('Could not remove like',error.message);return;}
    }else{
      const {error}=await supabase.from('kc_status_likes').insert({
        status_id:status.id,user_id:session.user.id
      });
      if(error&&error.code!=='23505'){Alert.alert('Could not like status',error.message);return;}
      if(!error)void dispatchPush('status_like',status.id);
    }
    await loadStatuses();
  };

  useEffect(()=>{
    if(!session||tab!=='Updates')return;
    void loadStatuses();
    const channel=supabase.channel('guftin-status-'+session.user.id)
      .on('postgres_changes',{event:'*',schema:'public',table:'kc_status_updates'},()=>{void loadStatuses();})
      .on('postgres_changes',{event:'*',schema:'public',table:'kc_status_views'},()=>{void loadStatuses();})
      .on('postgres_changes',{event:'*',schema:'public',table:'kc_status_likes'},()=>{void loadStatuses();})
      .subscribe((status,error)=>{
        if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'||status==='CLOSED'){
          console.warn('Status realtime unavailable; automatic refresh will use polling.',error?.message||status);
        }
      });
    const timer=setInterval(()=>{
      if(AppState.currentState==='active')void loadStatuses();
    },30000);
    const appState=AppState.addEventListener('change',state=>{
      if(state==='active')void loadStatuses();
    });
    return ()=>{
      clearInterval(timer);
      appState.remove();
      void supabase.removeChannel(channel);
    };
  },[session,tab,loadStatuses]);

  const visible=useMemo(()=>chats.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())),[chats,search]);
  const pageTitle=tab==='Chats'?'Messages':tab==='Updates'?'Updates':tab==='Channels'?'Channels':tab==='Calls'?'Calls':'You';

  if(authRestoring){
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper,alignItems:'center',justifyContent:'center'}}>
      <ActivityIndicator color={C.green} size="large"/>
      <Text style={{color:C.muted,marginTop:12}}>Restoring your Guftin session…</Text>
    </SafeAreaView>;
  }

  if(!session){
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper,padding:25,justifyContent:'center'}}>
      <StatusBar barStyle="dark-content"/>
      <ScrollView contentContainerStyle={{flexGrow:1,justifyContent:'center'}}>
        <View style={{alignItems:'center',marginBottom:34}}>
          <Avatar label="K" color={C.green} size={78}/>
          <Heading>Guftin</Heading>
          <Text style={{color:C.muted,marginTop:8}}>Your world. Your people. One place.</Text>
        </View>
        <Text style={{fontSize:23,fontWeight:'900',color:C.ink,marginBottom:8}}>{authMode==='signup'?'Create your Guftin ID':'Welcome back'}</Text>
        <Text style={{color:C.muted,marginBottom:18,lineHeight:20}}>{authMode==='signup'?'Create an account with email and choose your unique username.':'Sign in with the email and password linked to your account.'}</Text>
        {authMode==='signup'?<>
          <TextInput value={fullName} onChangeText={setFullName} placeholder="Your full name" autoCapitalize="words" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
          <TextInput value={username} onChangeText={v=>setUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} placeholder="Choose username (e.g. ali_786)" autoCapitalize="none" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
        </>:null}
        <TextInput value={email} onChangeText={setEmail} placeholder="Email address" keyboardType="email-address" autoCapitalize="none" autoComplete="email" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
        <TextInput value={password} onChangeText={setPassword} placeholder="Password (at least 8 characters)" secureTextEntry autoCapitalize="none" autoComplete={authMode==='signup'?'new-password':'password'} style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:12,color:C.ink}}/>
        {authError?<Text style={{color:C.red,fontSize:12,lineHeight:18,marginBottom:12}}>{authError}</Text>:null}
        <Btn disabled={authBusy} onPress={authMode==='signup'?signUpEmail:signInEmail} style={{backgroundColor:C.green,padding:17,borderRadius:16,alignItems:'center'}}>
          {authBusy?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>{authMode==='signup'?'Create account':'Sign in with email'}</Text>}
        </Btn>
        <Btn onPress={()=>{setAuthMode(authMode==='signup'?'login':'signup');setAuthError('');}} style={{padding:16,alignItems:'center'}}>
          <Text style={{color:C.green,fontWeight:'800'}}>{authMode==='signup'?'Already have an account? Sign in':'New to Guftin? Create account'}</Text>
        </Btn>
        <Text style={{color:C.muted,fontSize:10,textAlign:'center',marginTop:8,lineHeight:16}}>Your username is your Guftin ID. Other members can search it to add you. Email confirmation may be required.</Text>
      </ScrollView>
    </SafeAreaView>;
  }

  if(!profileReady){
    return <SafeAreaView style={{flex:1,alignItems:'center',justifyContent:'center',backgroundColor:C.paper}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:10}}>Loading your account…</Text></SafeAreaView>;
  }

  if(!profile?.username){
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper,padding:24,justifyContent:'center'}}>
      <StatusBar barStyle="dark-content"/>
      <View style={{alignItems:'center',marginBottom:28}}><Avatar label="K" color={C.green} size={70}/><Heading>Set your Guftin ID</Heading></View>
      <Text style={{fontSize:22,fontWeight:'900',color:C.ink,marginBottom:8}}>Complete your profile</Text>
      <Text style={{color:C.muted,lineHeight:20,marginBottom:18}}>Choose a username that people can search to find and add you.</Text>
      <TextInput value={profileName} onChangeText={setProfileName} placeholder="Your display name" autoCapitalize="words" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
      <TextInput value={profileUsername} onChangeText={v=>setProfileUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} placeholder="Username (3-24 characters)" autoCapitalize="none" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
      <Text style={{fontSize:11,color:C.muted,marginBottom:14}}>Allowed: lowercase letters, numbers and underscore.</Text>
      <Btn disabled={savingProfile} onPress={finishProfile} style={{backgroundColor:C.green,padding:17,borderRadius:16,alignItems:'center'}}>{savingProfile?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>Save and continue</Text>}</Btn>
      <Btn onPress={()=>supabase.auth.signOut()} style={{padding:15,alignItems:'center'}}><Text style={{color:C.red,fontWeight:'700'}}>Sign out</Text></Btn>
    </SafeAreaView>;
  }

  if(permissionSetupVisible&&session){
    const step=PERMISSION_SETUP_STEPS[permissionSetupStep];
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper,paddingHorizontal:22}}>
      <StatusBar barStyle="dark-content"/>
      <ScrollView contentContainerStyle={{flexGrow:1,justifyContent:'center',paddingVertical:28}}>
        <View style={{alignItems:'center',marginBottom:26}}>
          <Avatar label="K" color={C.green} size={70}/>
          <Heading>Guftin setup</Heading>
          <Text style={{color:C.muted,fontSize:12,marginTop:7,textAlign:'center'}}>Set your device permissions</Text>
        </View>
        <Text style={{fontSize:23,fontWeight:'900',color:C.ink,marginBottom:8}}>Allow the features you want</Text>
        <Text style={{color:C.muted,fontSize:13,lineHeight:20,marginBottom:18}}>Guftin will ask one permission at a time. For Android call permissions, Allow opens the exact system settings page; after you enable the switch and return, Guftin verifies it automatically.</Text>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <Text style={{fontSize:11,color:C.green,fontWeight:'900'}}>STEP {permissionSetupStep+1} OF {PERMISSION_SETUP_STEPS.length}</Text>
          <Text style={{fontSize:11,color:C.muted}}>{Math.round(((permissionSetupStep+1)/PERMISSION_SETUP_STEPS.length)*100)}%</Text>
        </View>
        <View style={{height:7,backgroundColor:'#dcebe4',borderRadius:8,overflow:'hidden',marginBottom:20}}>
          <View style={{height:7,width:((((permissionSetupStep+1)/PERMISSION_SETUP_STEPS.length)*100)+'%') as any,backgroundColor:C.green,borderRadius:8}}/>
        </View>
        <View style={{backgroundColor:C.white,borderRadius:22,padding:22,borderWidth:1,borderColor:C.line}}>
          <Text style={{fontSize:39,marginBottom:12}}>{step.icon}</Text>
          <Text style={{fontSize:21,fontWeight:'900',color:C.ink,marginBottom:8}}>{step.title}</Text>
          <Text style={{fontSize:13,color:C.muted,lineHeight:20}}>{step.description}</Text>
          {step.key==='autoSave'?<View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:20,paddingTop:15,borderTopWidth:1,borderColor:C.line}}>
            <View style={{flex:1,paddingRight:12}}>
              <Text style={{fontSize:13,fontWeight:'900',color:C.ink}}>Turn on automatic gallery saving</Text>
              <Text style={{fontSize:11,color:C.muted,marginTop:4}}>When enabled, new incoming photos and videos can be saved automatically.</Text>
            </View>
            <Switch value={permissionSetupAutoSave} onValueChange={setPermissionSetupAutoSave} trackColor={{true:C.green}}/>
          </View>:null}
          {permissionSetupNotice?<Text style={{fontSize:11,color:C.muted,lineHeight:17,marginTop:15}}>{permissionSetupNotice}</Text>:null}
        </View>
        <View style={{flexDirection:'row',gap:10,marginTop:22}}>
          <Btn disabled={permissionSetupBusy} onPress={()=>void skipPermissionSetupStep()} style={{flex:1,padding:15,borderRadius:14,alignItems:'center',backgroundColor:C.white,borderWidth:1,borderColor:C.line}}>
            <Text style={{color:C.ink,fontWeight:'800'}}>Not now</Text>
          </Btn>
          <Btn disabled={permissionSetupBusy} onPress={()=>void requestPermissionSetupStep()} style={{flex:1,padding:15,borderRadius:14,alignItems:'center',backgroundColor:C.green}}>
            {permissionSetupBusy?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>{step.key==='autoSave'?'Save choice':'Allow'}</Text>}
          </Btn>
        </View>
        <Btn disabled={permissionSetupBusy} onPress={()=>void finishPermissionSetup()} style={{paddingVertical:14,paddingHorizontal:12,alignItems:'center',marginTop:7}}>
          <Text style={{color:C.green,fontWeight:'900'}}>Skip setup for now</Text>
        </Btn>
        <Text style={{fontSize:10,color:C.muted,textAlign:'center',lineHeight:16,marginTop:8}}>You can allow each permission later when you use the feature. Contacts and location access are not needed for username-based Guftin chats. Android only grants access when you choose Allow.</Text>
      </ScrollView>
    </SafeAreaView>;
  }

  if(liveCall){
    return <SecureLiveKitRoom
      liveCall={liveCall}
      sessionUserId={session.user.id}
      onConnected={()=>{
        if(Platform.OS==='android'&&liveCall.nativeIncomingCall){
          try{RNCallKeep.setCurrentCallActive(liveCall.id);}
          catch(nativeStateError:any){console.warn('Android incoming call active-state sync:',nativeStateError?.message||nativeStateError);}
        }
      }}
      onDisconnected={()=>void endCall(liveCall.id)}
      onHangUp={()=>endCall(liveCall.id)}
    />;
  }

  if(incomingCall){
    return <CallLobbyScreen
      call={incomingCall}
      mode="incoming"
      busy={!!pendingCallAccept&&pendingCallAccept.id===incomingCall.id}
      onAccept={()=>void acceptCallWhenReady(incomingCall)}
      onDecline={()=>void respondToCall(incomingCall,'declined')}
    />;
  }

  if(outgoingCall){
    return <CallLobbyScreen
      call={outgoingCall}
      mode="outgoing"
      onCancel={()=>void endCall(outgoingCall.id)}
    />;
  }

  if(active){
    const list=messages[active.id]||[];
    return <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'} keyboardVerticalOffset={Platform.OS==='ios'?insets.top:0}>
      <SafeAreaView style={{flex:1,backgroundColor:C.paper}}>
      <StatusBar barStyle="dark-content"/>
      <View style={{minHeight:82,backgroundColor:C.white,flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingVertical:7,borderBottomWidth:1,borderColor:C.line,elevation:2}}>
        <Btn onPress={()=>setActive(null)} style={{padding:10}}><Text style={{fontSize:24,color:C.ink}}>‹</Text></Btn>
        <Avatar label={active.avatar} color={active.color} size={43} online={active.online} uri={active.avatarUrl}/>
        <Btn onPress={()=>active.kind==='channel'?showChannelOptions():void openChatDetails()} style={{flex:1,marginLeft:11,alignItems:'flex-start'}}>
          <View style={{flexDirection:'row',alignItems:'center',gap:5}}><Text numberOfLines={1} style={{fontWeight:'900',fontSize:15,color:C.ink}}>{active.name}</Text>{active.isVerified?<VerifiedBadge label={active.isOfficial?'Verified Guftin Official account':'Verified channel'}/>:null}</View>
          <Text style={{fontSize:11,color:active.isOfficial?C.green:active.online?C.green:C.muted}}>{active.kind==='channel'?(active.isOfficial?'Official Guftin announcements':active.isChannelOwner?'Your channel · publish updates':'Channel · read-only'):active.kind==='group'?'Tap for group info':outgoingCall?'Calling…':active.online?'● online':'Tap for contact info'}</Text>
        </Btn>
        {active.kind!=='channel'?(outgoingCall?<Btn onPress={()=>void endCall(outgoingCall.id)} style={{backgroundColor:'#fde8e8',borderRadius:15,width:62,height:58,alignItems:'center',justifyContent:'center',borderWidth:1,borderColor:'#f3c6c6'}}><Text style={{fontSize:11,fontWeight:'900',color:C.red}}>Cancel</Text><Text style={{fontSize:9,color:C.red}}>call</Text></Btn>:<>
          <Btn disabled={callBusy} onPress={()=>void startCall('voice')} style={{backgroundColor:C.mint,borderRadius:15,width:56,height:58,alignItems:'center',justifyContent:'center',opacity:callBusy?0.5:1,borderWidth:1,borderColor:'#cce9dc'}}><Text style={{fontSize:20,color:C.green}}>☎</Text><Text style={{fontSize:10,fontWeight:'900',color:C.green}}>{active.kind==='group'?'Group call':'Call'}</Text></Btn>
          <Btn disabled={callBusy} onPress={()=>void startCall('video')} style={{backgroundColor:C.mint,borderRadius:15,width:56,height:58,alignItems:'center',justifyContent:'center',opacity:callBusy?0.5:1,borderWidth:1,borderColor:'#cce9dc'}}><Text style={{fontSize:19,color:C.green}}>▣</Text><Text style={{fontSize:10,fontWeight:'900',color:C.green}}>Video</Text></Btn>
        </>):null}
        <Btn onPress={()=>active.kind==='channel'?showChannelOptions():Alert.alert('Chat options',active.name,[
          {text:'Chat info',onPress:()=>void openChatDetails()},
          {text:'Clear Chat',style:'destructive',onPress:()=>Alert.alert('Clear this chat?', 'This removes the messages from your Guftin account on this phone. The other participant keeps their chat history.',[
            {text:'Cancel',style:'cancel'},
            {text:'Clear Chat',style:'destructive',onPress:()=>void clearChatForMe(active)}
          ])},
          {text:'Cancel',style:'cancel'}
        ])} style={{width:36,height:52,borderRadius:13,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:26,fontWeight:'900',color:C.ink}}>⋮</Text></Btn>
      </View>
      <FlatList ref={chatMessagesListRef} data={list} keyExtractor={m=>m.id} keyboardShouldPersistTaps="handled" style={{flex:1}} contentContainerStyle={{padding:18,gap:12,flexGrow:1,justifyContent:list.length?'flex-end':'center'}}
        ListEmptyComponent={<Text style={{textAlign:'center',color:C.muted}}>No messages yet. Send the first message.</Text>}
        renderItem={({item})=><TouchableOpacity activeOpacity={1} onLongPress={active.kind==='channel'&&!active.isChannelOwner?undefined:()=>deleteMessage(item)} delayLongPress={420} style={{alignSelf:item.mine?'flex-end':'flex-start',maxWidth:'84%',backgroundColor:item.mine?'#dff4e8':C.white,padding:13,borderRadius:17,borderTopRightRadius:item.mine?5:17,borderTopLeftRadius:item.mine?17:5}}>
          {item.deleted_at?<Text style={{fontSize:12,color:C.muted,fontStyle:'italic'}}>This message was deleted</Text>:item.message_type==='image'&&item.attachment_url?<Image source={{uri:item.attachment_url}} style={{width:210,height:210,borderRadius:12}} resizeMode="cover"/>:item.message_type==='video'&&item.attachment_url?<VideoBubble uri={item.attachment_url}/>:item.message_type==='audio'&&item.attachment_url?<AudioBubble uri={item.attachment_url}/>:item.message_type==='file'&&item.attachment_url?<View style={{minWidth:225,maxWidth:270,backgroundColor:C.paper,borderRadius:13,padding:12}}>
            <Text style={{fontSize:25,color:C.green}}>▤</Text>
            <Text numberOfLines={2} style={{fontSize:13,fontWeight:'900',color:C.ink,marginTop:5}}>{item.body||'Document'}</Text>
            <Text style={{fontSize:10,color:C.muted,marginTop:3}}>{getDocumentMimeType(item.body||'').replace('application/','').replace('vnd.openxmlformats-officedocument.','')}</Text>
            <Btn onPress={()=>void Sharing.shareAsync(item.attachment_url!,{mimeType:getDocumentMimeType(item.body||''),dialogTitle:item.body||'Share document'})} style={{marginTop:10,padding:10,borderRadius:10,backgroundColor:C.mint,alignSelf:'flex-start'}}>
              <Text style={{color:C.green,fontWeight:'900',fontSize:11}}>Open / Share document</Text>
            </Btn>
          </View>:<Text style={{color:C.ink,fontSize:14,lineHeight:21}}>{item.body||'Attachment'}</Text>}
          {!item.deleted_at&&['image','video'].includes(item.message_type)&&item.attachment_url?<Btn onPress={()=>void saveMediaToGallery(item)} style={{marginTop:7,paddingVertical:6,paddingHorizontal:9,borderRadius:9,backgroundColor:C.paper,alignSelf:'flex-start'}}><Text style={{fontSize:11,color:C.green,fontWeight:'800'}}>↓ Save to gallery</Text></Btn>:null}
          <Text style={{textAlign:'right',fontSize:9,color:C.muted,marginTop:5}}>
            {timeLabel(item.created_at)}{item.pending?' · Queued':item.mine ? " · " + (showReadReceipts && peerLastReadAt && new Date(peerLastReadAt).getTime() >= new Date(item.created_at).getTime() ? "✓✓ Read" : deliveredByMessage[item.id] ? "✓✓ Delivered" : "✓ Sent") : ""}
          </Text>
        </TouchableOpacity>}/>
      <View style={{flexDirection:'row',alignItems:'center',padding:11,gap:8,backgroundColor:C.white,borderTopWidth:1,borderColor:C.line}}>
        {active.kind==='channel'&&!active.isChannelOwner
          ?<Text style={{flex:1,textAlign:'center',fontSize:12,color:C.muted,fontWeight:'800',paddingVertical:12}}>Only the channel owner can publish updates.</Text>
          :<>
            <Btn disabled={mediaPreparing} onPress={sendMedia} style={{width:42,height:42,borderRadius:15,backgroundColor:C.paper,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:23,color:C.green}}>＋</Text></Btn>
            {active.kind!=='channel'?<Btn disabled={sending||recordingBusy} onPress={recording?stopVoiceRecording:startVoiceRecording} style={{width:42,height:42,borderRadius:15,backgroundColor:recording?'#fde8e8':C.paper,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:18,color:recording?C.red:C.green}}>{recording?'■':'🎙'}</Text></Btn>:null}
            <TextInput value={draft} onChangeText={setDraft} onFocus={()=>requestAnimationFrame(()=>chatMessagesListRef.current?.scrollToEnd({animated:true}))} placeholder={active.kind==='channel'?'Write a channel update…':recording?'Recording… tap ■ to send':'Write a message...'} multiline maxLength={4000} style={{flex:1,minHeight:46,maxHeight:110,backgroundColor:C.paper,borderRadius:16,paddingHorizontal:15,paddingVertical:12,color:C.ink,textAlignVertical:'center'}}/>
            <Btn disabled={!draft.trim()||sending} onPress={sendMessage} style={{backgroundColor:C.green,width:46,height:46,borderRadius:16,alignItems:'center',justifyContent:'center'}}>
              {sending?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontSize:20}}>➤</Text>}
            </Btn>
          </>}
      </View>
    <Modal visible={chatDetailsOpen} animationType="slide" onRequestClose={()=>setChatDetailsOpen(false)}>
      <SafeAreaView style={{flex:1,backgroundColor:C.paper}}>
        <StatusBar barStyle="dark-content"/>
        <View style={{height:58,backgroundColor:C.white,flexDirection:'row',alignItems:'center',paddingHorizontal:14,borderBottomWidth:1,borderColor:C.line}}>
          <Btn onPress={()=>setChatDetailsOpen(false)} style={{padding:10}}><Text style={{fontSize:25,color:C.ink}}>‹</Text></Btn>
          <Text style={{fontSize:18,fontWeight:'900',color:C.ink,marginLeft:8}}>Contact info</Text>
        </View>
        {chatDetailsLoading?<View style={{flex:1,alignItems:'center',justifyContent:'center'}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:10}}>Loading contact information…</Text></View>:chatDetails?<ScrollView contentContainerStyle={{padding:18,paddingBottom:34}}>
          <View style={{alignItems:'center',backgroundColor:C.white,borderRadius:22,padding:24,marginBottom:16}}>
            <Avatar label={initials(chatDetails.conversation.kind==='group'?chatDetails.conversation.title:(chatDetails.members.find((member:any)=>member.user_id!==session.user.id)?.display_name||active.name||'G'))}
              color={C.green} size={112} uri={chatDetails.conversation.kind==='group'?undefined:(chatDetails.members.find((member:any)=>member.user_id!==session.user.id)?.avatar_signed_url||undefined)}/>
            <Text style={{fontSize:22,fontWeight:'900',color:C.ink,marginTop:15}}>{chatDetails.conversation.kind==='group'?chatDetails.conversation.title:(chatDetails.members.find((member:any)=>member.user_id!==session.user.id)?.display_name||active.name)}</Text>
            {chatDetails.conversation.kind==='group'?<Text style={{fontSize:12,color:C.muted,marginTop:5}}>Group conversation · {chatDetails.members.length} participants</Text>:(()=>{
              const person=chatDetails.members.find((member:any)=>member.user_id!==session.user.id)||{};
              return <><Text style={{fontSize:13,color:C.green,fontWeight:'800',marginTop:5}}>@{person.username||'—'}</Text><Text style={{fontSize:12,color:C.muted,marginTop:5}}>{person.is_online?'● Online now':person.last_seen_at?'Last seen '+timeLabel(person.last_seen_at):'Offline'}</Text></>;
            })()}
          </View>
          {chatDetails.conversation.kind==='group'?<>
            <View style={{backgroundColor:C.white,borderRadius:18,padding:16}}>
              <Text style={{fontSize:14,fontWeight:'900',color:C.ink,marginBottom:8}}>Participants · {chatDetails.members.length}</Text>
              {chatDetails.members.map((member:any)=><View key={member.user_id} style={{flexDirection:'row',alignItems:'center',gap:11,paddingVertical:11,borderBottomWidth:1,borderColor:C.line}}>
                <Avatar label={initials(member.display_name||member.username||'G')} color={colorFor(member.user_id)} size={44} uri={member.avatar_signed_url}/>
                <View style={{flex:1}}><Text style={{fontWeight:'800',color:C.ink}}>{member.display_name||'Guftin member'}{member.is_me?' (You)':''}</Text><Text style={{fontSize:11,color:C.muted,marginTop:3}}>@{member.username||'member'}</Text></View>
                <Text style={{fontSize:10,color:C.green,fontWeight:'800'}}>{member.role||'member'}</Text>
              </View>)}
            </View>
          </>:(()=>{
            const person=chatDetails.members.find((member:any)=>member.user_id!==session.user.id)||{};
            return <View style={{gap:12}}>
              <View style={{backgroundColor:C.white,borderRadius:16,padding:16}}>
                <Text style={{fontSize:10,color:C.muted,fontWeight:'900',letterSpacing:1}}>NAME</Text>
                <Text style={{fontSize:15,color:C.ink,fontWeight:'800',marginTop:5}}>{person.display_name||'Guftin member'}</Text>
              </View>
              <View style={{backgroundColor:C.white,borderRadius:16,padding:16}}>
                <Text style={{fontSize:10,color:C.muted,fontWeight:'900',letterSpacing:1}}>USERNAME / GUFTIN ID</Text>
                <Text style={{fontSize:15,color:C.ink,fontWeight:'900',marginTop:5}}>@{person.username||'—'}</Text>
              </View>
              <View style={{backgroundColor:C.white,borderRadius:16,padding:16}}>
                <Text style={{fontSize:10,color:C.muted,fontWeight:'900',letterSpacing:1}}>ABOUT</Text>
                <Text style={{fontSize:14,color:C.ink,lineHeight:21,marginTop:5}}>{person.about||'No about information added.'}</Text>
              </View>
              <View style={{backgroundColor:C.white,borderRadius:16,padding:16}}>
                <Text style={{fontSize:10,color:C.muted,fontWeight:'900',letterSpacing:1}}>ACTIVITY</Text>
                <Text style={{fontSize:14,color:C.ink,marginTop:5}}>{person.is_online?'Online now':person.last_seen_at?'Last seen '+timeLabel(person.last_seen_at):'Offline'}</Text>
              </View>
              <View style={{backgroundColor:C.white,borderRadius:16,padding:16}}>
                <Text style={{fontSize:10,color:C.muted,fontWeight:'900',letterSpacing:1}}>MEMBER SINCE</Text>
                <Text style={{fontSize:14,color:C.ink,marginTop:5}}>{person.created_at?new Date(person.created_at).toLocaleDateString([],{month:'long',year:'numeric'}):'Not available'}</Text>
              </View>
            </View>;
          })()}
        </ScrollView>:<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:30}}><Text style={{color:C.muted}}>No contact information available.</Text></View>}
      </SafeAreaView>
    </Modal>

      </SafeAreaView>
    </KeyboardAvoidingView>;
  }

  return <SafeAreaView edges={['top','left','right']} style={{flex:1,backgroundColor:C.white}}>
    <StatusBar barStyle="dark-content"/>
    <View style={{paddingHorizontal:18,paddingTop:14,paddingBottom:13,flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:10}}>
        <Btn onPress={()=>setTab('You')}><Avatar label={initials(profile?.display_name||'G')} color={C.green} size={40} uri={profileAvatarUrl}/></Btn>
        <View><Heading>{pageTitle}</Heading><Text style={{color:C.muted,fontSize:12,marginTop:4}}>{tab==='Chats'?'Your real conversations':tab==='You'?'Your Guftin ID':'Guftin'}</Text></View>
      </View>
      <View style={{flexDirection:'row',gap:9}}>
        <Btn onPress={()=>setSettingsOpen(true)} style={{backgroundColor:C.paper,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:19,color:C.green}}>⚙</Text></Btn>
        {tab==='Chats'?<Btn onPress={()=>void openGroupCreator()} style={{backgroundColor:C.mint,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:18,color:C.green}}>👥</Text></Btn>:null}
        {tab==='Chats'?<Btn onPress={()=>setSearching(!searching)} style={{backgroundColor:C.paper,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:19}}>⌕</Text></Btn>:null}
        {tab==='Chats'?<Btn onPress={()=>setAddOpen(true)} style={{backgroundColor:C.green,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:24,color:'#fff'}}>＋</Text></Btn>:null}
        {tab==='Channels'?<Btn onPress={()=>setChannelJoinOpen(true)} style={{backgroundColor:C.mint,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:18,color:C.green}}>↗</Text></Btn>:null}
        {tab==='Channels'?<Btn onPress={()=>setChannelCreateOpen(true)} style={{backgroundColor:C.green,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:24,color:'#fff'}}>＋</Text></Btn>:null}
      </View>
    </View>
    {tab==='Chats'?<>
      {searching?<TextInput value={search} onChangeText={setSearch} placeholder="Search your conversations..." autoFocus style={{marginHorizontal:20,marginBottom:12,padding:14,backgroundColor:C.paper,borderRadius:14,color:C.ink}}/>:null}
      {loading&&chats.length===0?<View style={{flex:1,alignItems:'center',justifyContent:'center'}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:10}}>Loading your conversations…</Text></View>:
        <FlatList data={visible} keyExtractor={x=>x.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.green}/>} contentContainerStyle={{paddingHorizontal:13,paddingBottom:25,flexGrow:1}}
          ListEmptyComponent={<View style={{alignItems:'center',padding:35,marginTop:50}}><Avatar label="K" color={C.green} size={64}/><Text style={{fontSize:17,fontWeight:'900',color:C.ink,marginTop:15}}>No conversations yet</Text><Text style={{color:C.muted,textAlign:'center',marginTop:7,lineHeight:20}}>Tap ＋ and search by a person's unique username to start a real chat.</Text><Btn onPress={()=>setAddOpen(true)} style={{backgroundColor:C.green,paddingHorizontal:22,paddingVertical:13,borderRadius:14,marginTop:18}}><Text style={{color:'#fff',fontWeight:'800'}}>Find by username</Text></Btn></View>}
          renderItem={({item})=><Btn onPress={()=>openChat(item)} onLongPress={()=>Alert.alert('Chat options',item.name,[{text:'Delete chat for me',style:'destructive',onPress:()=>void hideChat(item)},{text:'Cancel',style:'cancel'}])} style={{flexDirection:'row',alignItems:'center',padding:10,gap:12,borderRadius:17}}>
            <Avatar label={item.avatar} color={item.color} online={item.online} uri={item.avatarUrl}/>
            <View style={{flex:1,borderBottomWidth:1,borderColor:C.line,paddingBottom:14,paddingTop:2}}>
              <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><View style={{flexDirection:'row',alignItems:'center',gap:4,flex:1}}><Text numberOfLines={1} style={{fontWeight:'800',color:C.ink,fontSize:14}}>{item.name}</Text>{<>{item.isOfficial?<Text style={{fontSize:9,color:'#2387e8',fontWeight:'900'}}>OFFICIAL</Text>:null}{item.isVerified?<VerifiedBadge label={item.isOfficial?'Verified Guftin Official account':'Verified channel'}/>:null}</>}</View><Text style={{fontSize:10,color:C.muted}}>{item.time}</Text></View>
              <View style={{flexDirection:'row',alignItems:'center',gap:8,marginTop:6}}>
                <Text numberOfLines={1} style={{fontSize:12,color:C.muted,flex:1}}>{item.last}</Text>
                {item.unread>0?<View style={{minWidth:20,height:20,paddingHorizontal:6,borderRadius:10,backgroundColor:C.green,alignItems:'center',justifyContent:'center'}}>
                  <Text style={{fontSize:10,color:'#fff',fontWeight:'900'}}>{item.unread>99?'99+':item.unread}</Text>
                </View>:null}
              </View>
            </View>
          </Btn>}/>
      }
    </>:null}
    {tab==='Updates'?<ScrollView contentContainerStyle={{padding:20,paddingBottom:30}}>
      <View style={{backgroundColor:C.paper,borderRadius:20,padding:18,marginBottom:18}}>
        <Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>Your status</Text>
        <Text style={{color:C.muted,fontSize:12,marginTop:5}}>Share a photo, video or text. It expires after 24 hours.</Text>
        <Btn onPress={()=>setStatusComposer(true)} style={{backgroundColor:C.green,padding:14,borderRadius:14,alignItems:'center',marginTop:13}}>
          <Text style={{color:'#fff',fontWeight:'900'}}>＋ Add status</Text>
        </Btn>
      </View>
      <Text style={{fontSize:16,fontWeight:'900',color:C.ink,marginBottom:4}}>Recent updates</Text>
      <Text style={{fontSize:11,color:C.muted,marginBottom:10}}>{new Set(statuses.map((item:any)=>item.user_id)).size} people · {statuses.length} updates shared in the last 24 hours</Text>
      {statuses.length===0?<Text style={{color:C.muted,textAlign:'center',padding:30}}>No active statuses from your contacts yet.</Text>:statuses.map((status:any)=><View key={status.id} style={{padding:14,borderBottomWidth:1,borderColor:C.line,flexDirection:'row',gap:12}}>
        <Avatar label={initials(status.display_name)} color={colorFor(status.user_id)} size={46} uri={status.avatar_signed_url}/>
        <View style={{flex:1}}>
          <View style={{flexDirection:'row',alignItems:'center',gap:5,flexWrap:'wrap'}}><Text style={{fontWeight:'900',color:C.ink}}>{status.user_id===session.user.id?'You':status.display_name}{status.username?'  @'+status.username:''}</Text>{status.is_verified?<VerifiedBadge label="Verified Guftin Official account"/>:null}</View>
          {status.media_signed_url?(status.media_url?.toLowerCase().match(/\.(mp4|mov|m4v)$/)?<VideoBubble uri={status.media_signed_url}/>:<Image source={{uri:status.media_signed_url}} style={{width:210,height:190,borderRadius:14,marginTop:8}} resizeMode="cover"/>):null}
          {status.caption?<Text style={{color:C.ink,lineHeight:20,marginTop:5}}>{status.caption}</Text>:null}
          <Text style={{color:C.muted,fontSize:10,marginTop:5}}>{timeLabel(status.created_at)} · {status.status_count} status update{status.status_count===1?'':'s'} from this person</Text>
          {status.user_id===session.user.id?<View style={{marginTop:8,padding:10,borderRadius:12,backgroundColor:C.paper}}>
            <Text style={{fontSize:11,color:C.green,fontWeight:'900'}}>◉ {status.view_count||0} views  ·  ♥ {status.like_count||0} likes</Text>
            {status.viewer_names?.length?<Text style={{fontSize:10,color:C.muted,marginTop:4}}>Seen by: {status.viewer_names.join(', ')}</Text>:null}
            {status.liker_names?.length?<Text style={{fontSize:10,color:C.muted,marginTop:4}}>Liked by: {status.liker_names.join(', ')}</Text>:null}
          </View>:<Btn onPress={()=>void toggleStatusLike(status)} style={{alignSelf:'flex-start',marginTop:9,paddingHorizontal:12,paddingVertical:7,borderRadius:12,backgroundColor:status.liked_by_me?'#ffe8ed':C.mint}}>
            <Text style={{fontSize:11,fontWeight:'900',color:status.liked_by_me?'#c74768':C.green}}>{status.liked_by_me?'♥ Liked':'♡ Like status'}</Text>
          </Btn>}
        </View>
      </View>)}
    </ScrollView>:null}
    {tab==='Channels'?<ScrollView contentContainerStyle={{padding:18,paddingBottom:30}}>
      <View style={{backgroundColor:C.paper,borderRadius:20,padding:18,marginBottom:16}}>
        <Text style={{fontSize:19,fontWeight:'900',color:C.ink}}>Guftin Channels</Text>
        <Text style={{fontSize:12,color:C.muted,lineHeight:18,marginTop:6}}>Create a broadcast channel, invite people with a link, and publish photos, videos or updates. Followers can view posts but cannot publish.</Text>
        <View style={{flexDirection:'row',gap:9,marginTop:14}}>
          <Btn onPress={()=>setChannelCreateOpen(true)} style={{flex:1,backgroundColor:C.green,padding:13,borderRadius:13,alignItems:'center'}}><Text style={{color:'#fff',fontWeight:'900'}}>＋ Create channel</Text></Btn>
          <Btn onPress={()=>setChannelJoinOpen(true)} style={{flex:1,backgroundColor:C.mint,padding:13,borderRadius:13,alignItems:'center'}}><Text style={{color:C.green,fontWeight:'900'}}>Join by link</Text></Btn>
        </View>
      </View>
      {channelsLoading&&channels.length===0?<View style={{padding:30,alignItems:'center'}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:8}}>Loading channels…</Text></View>:null}
      <Text style={{fontSize:16,fontWeight:'900',color:C.ink,marginBottom:9}}>Your channels</Text>
      {channels.filter(channel=>channel.owner_id===session.user.id).length===0
        ?<Text style={{fontSize:12,color:C.muted,marginBottom:16}}>You have not created a channel yet.</Text>
        :channels.filter(channel=>channel.owner_id===session.user.id).map(channel=><View key={channel.conversation_id} style={{backgroundColor:C.white,borderRadius:17,padding:13,marginBottom:9,borderWidth:1,borderColor:C.line}}>
          <View style={{flexDirection:'row',alignItems:'center',gap:11}}>
            <View style={{width:46,height:46,borderRadius:16,backgroundColor:C.mint,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:21,color:C.green}}>◈</Text></View>
            <View style={{flex:1}}><Text style={{fontSize:14,fontWeight:'900',color:C.ink}}>{channel.title||'My channel'}{channel.is_verified?<VerifiedBadge label="Verified channel"/>:null}</Text><Text style={{fontSize:10,color:C.muted,marginTop:3}}>{channel.is_public?'Public channel':'Private · invite link only'} · Owner</Text></View>
            <Btn onPress={()=>void shareChannelInvite(channel)} style={{padding:9,borderRadius:11,backgroundColor:C.mint}}><Text style={{fontSize:11,color:C.green,fontWeight:'900'}}>Invite ↗</Text></Btn>
          </View>
          <Text numberOfLines={2} style={{fontSize:11,color:C.muted,lineHeight:16,marginTop:8}}>{channel.description||'No channel description'}</Text>
          <Btn onPress={()=>openChannelChat(channel)} style={{marginTop:10,backgroundColor:C.paper,padding:10,borderRadius:11,alignItems:'center'}}><Text style={{fontSize:11,color:C.green,fontWeight:'900'}}>Open channel ›</Text></Btn>
        </View>)}
      <Text style={{fontSize:16,fontWeight:'900',color:C.ink,marginTop:13,marginBottom:9}}>Followed and discover</Text>
      {channels.filter(channel=>channel.owner_id!==session.user.id).length===0
        ?<Text style={{fontSize:12,color:C.muted}}>No public channels to discover yet. Share your own channel link to invite followers.</Text>
        :channels.filter(channel=>channel.owner_id!==session.user.id).map(channel=><View key={channel.conversation_id} style={{flexDirection:'row',alignItems:'center',gap:11,padding:12,borderBottomWidth:1,borderColor:C.line}}>
          <View style={{width:44,height:44,borderRadius:15,backgroundColor:C.mint,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:20,color:C.green}}>◈</Text></View>
          <View style={{flex:1}}><Text style={{fontSize:13,fontWeight:'900',color:C.ink}}>{channel.is_official?'Guftin Official':(channel.title||'Guftin channel')}{channel.is_verified?<VerifiedBadge label="Verified channel"/>:null}</Text><Text numberOfLines={2} style={{fontSize:10,color:C.muted,marginTop:3}}>{channel.description|| (channel.is_public?'Public channel':'Private channel')}</Text></View>
          {channel.isFollowing?<Btn onPress={()=>openChannelChat(channel)} style={{paddingHorizontal:13,paddingVertical:9,borderRadius:11,backgroundColor:C.mint}}><Text style={{color:C.green,fontWeight:'900',fontSize:11}}>Open</Text></Btn>
            :channel.is_public?<Btn disabled={channelBusy} onPress={()=>void followPublicChannel(channel)} style={{paddingHorizontal:13,paddingVertical:9,borderRadius:11,backgroundColor:C.green}}><Text style={{color:'#fff',fontWeight:'900',fontSize:11}}>Follow</Text></Btn>
            :<Btn onPress={()=>setChannelJoinOpen(true)} style={{paddingHorizontal:13,paddingVertical:9,borderRadius:11,backgroundColor:C.paper}}><Text style={{color:C.green,fontWeight:'900',fontSize:11}}>Invite only</Text></Btn>}
        </View>)}
      <Text style={{fontSize:10,color:C.muted,lineHeight:16,marginTop:18}}>Channel posts are broadcast content. They are visible to followers and are not end-to-end encrypted like private one-to-one messages.</Text>
    </ScrollView>:null}
    {tab==='Calls'?<ScrollView contentContainerStyle={{padding:18,paddingBottom:30}}>
      <View style={{backgroundColor:C.paper,borderRadius:18,padding:16,marginBottom:16}}>
        <Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>Call history</Text>
        <Text style={{fontSize:11,color:C.muted,marginTop:5}}>Your recent voice and video calls</Text>
      </View>
      {callHistory.length===0?<Text style={{color:C.muted,textAlign:'center',padding:32}}>No calls yet. Start a call from any direct chat.</Text>:callHistory.map((call:any)=><View key={call.id} style={{flexDirection:'row',alignItems:'center',gap:12,padding:13,borderBottomWidth:1,borderColor:C.line}}>
        <View style={{width:43,height:43,borderRadius:15,backgroundColor:C.mint,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:19,color:C.green}}>{call.call_type==='video'?'▣':'☎'}</Text></View>
        <View style={{flex:1}}>
          <Text style={{fontWeight:'900',color:C.ink}}>{call.peer_name}</Text>
          <Text style={{fontSize:11,color:C.muted,marginTop:3}}>{call.outgoing?'Outgoing':'Incoming'} {call.call_type==='video'?'video':'voice'} call · {call.status}</Text>
          <Text style={{fontSize:10,color:C.muted,marginTop:3}}>{timeLabel(call.started_at||call.ended_at||'')}</Text>
        </View>
        <Text style={{color:call.status==='accepted'||call.status==='ended'?C.green:C.muted,fontSize:11,fontWeight:'800'}}>{call.status==='missed'?'Missed':call.status==='declined'?'Declined':call.status==='ringing'?'Ringing':'Done'}</Text>
      </View>)}
      <Text style={{fontSize:10,color:C.muted,marginTop:15,lineHeight:16}}>Incoming calls can arrive as push alerts while Guftin is closed when notifications are enabled on this phone. Use Accept or Decline on the call notification. Full-screen continuous ringing still depends on native call-screen integration and platform credentials.</Text>
    </ScrollView>:null}
    {tab==='You'?<ScrollView contentContainerStyle={{padding:22}}>
      <View style={{alignItems:'center',padding:25,backgroundColor:C.paper,borderRadius:22}}>
        <Btn onPress={chooseProfilePhoto} style={{alignItems:'center'}}><Avatar label={initials(profile?.display_name||session.user.email||'KC')} color={C.green} size={88} uri={profileAvatarUrl}/><Text style={{color:C.green,fontWeight:'800',fontSize:12,marginTop:8}}>{profileUploading?'Uploading…':'Change profile photo'}</Text></Btn>
        <Text style={{fontSize:20,fontWeight:'900',color:C.ink,marginTop:12}}>{profile?.display_name||'Your profile'}</Text>
        <Text style={{color:C.muted,fontSize:12,marginTop:4}}>{session.user.email||'Verified account'}</Text>
        <Text style={{color:C.green,fontSize:13,fontWeight:'800',marginTop:6}}>@{profile?.username}</Text>
      </View>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:25,marginBottom:8}}>Display name</Text>
      <TextInput value={profileName} onChangeText={setProfileName} placeholder="Your name" maxLength={40} style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:15,marginBottom:8}}>Username · permanent</Text>
      {profile?.username?<View style={{backgroundColor:C.paper,borderRadius:14,padding:15,borderWidth:1,borderColor:C.line}}>
        <Text style={{color:C.ink,fontWeight:'900'}}>@{profile.username}</Text>
        <Text style={{color:C.muted,fontSize:11,marginTop:5}}>Your Guftin ID is locked and cannot be changed.</Text>
      </View>:<TextInput value={profileUsername} onChangeText={v=>setProfileUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} placeholder="Your unique username" autoCapitalize="none" maxLength={24} style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>}
      <Text style={{fontWeight:'800',color:C.ink,marginTop:15,marginBottom:8}}>About</Text>
      <TextInput value={about} onChangeText={setAbout} placeholder="A little about you" maxLength={160} multiline style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink,minHeight:75,textAlignVertical:'top'}}/>
      <Btn disabled={savingProfile||profileUploading} onPress={saveProfile} style={{backgroundColor:C.green,padding:15,borderRadius:14,alignItems:'center',marginTop:10}}>{savingProfile?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Save profile</Text>}</Btn>
      <View style={{padding:15,backgroundColor:C.mint,borderRadius:14,marginTop:18}}>
        <Text style={{fontWeight:'900',color:C.green}}>🔒 Message encryption</Text>
        <Text style={{color:C.ink,fontSize:12,lineHeight:18,marginTop:6}}>{e2eeStatus==='ready'?'This device has a private key stored locally. New text messages are encrypted for each registered conversation device before upload.':'This device encryption key is not available yet. Secure text sending is paused.'}</Text>
        <Text style={{color:C.muted,fontSize:10,lineHeight:15,marginTop:6}}>This is an early encryption implementation with no forward secrecy or verified safety numbers, and private keys cannot be recovered after reinstalling Android. New direct voice/video calls now use LiveKit media E2EE with a per-call key wrapped to each registered device. Status updates are not encrypted, and neither messaging nor calling has had an independent security audit.</Text>
      </View>
      <Btn onPress={()=>Alert.alert('Privacy','New text messages and photo/video attachments are encrypted on the sending device before upload. New direct voice/video calls use LiveKit media E2EE with a per-call key wrapped to each registered device. Public keys are not yet verified with safety numbers, forward secrecy is not implemented, status is not end-to-end encrypted, and this version has not had an independent security audit.')} style={{padding:18,borderBottomWidth:1,borderColor:C.line,marginTop:12}}><Text style={{color:C.ink,fontWeight:'700'}}>Privacy and security　›</Text></Btn>
      <Btn onPress={()=>supabase.auth.signOut()} style={{padding:18}}><Text style={{color:C.red,fontWeight:'800'}}>Sign out</Text></Btn>
    </ScrollView>:null}
    {adsReady&&tab!=='You'?<View style={{alignItems:'center',justifyContent:'center',backgroundColor:C.white,minHeight:50,paddingTop:4}}>
      <BannerAd
        unitId={__DEV__?TestIds.BANNER:(process.env.EXPO_PUBLIC_ADMOB_BANNER_UNIT_ID||'ca-app-pub-3116820002792089/9054692427')}
        size={BannerAdSize.BANNER}
        requestOptions={{requestNonPersonalizedAdsOnly:true}}
        onAdFailedToLoad={error=>console.warn('AdMob banner failed:',error?.message||error)}
      />
    </View>:null}
    <View style={{height:66+insets.bottom,paddingTop:5,paddingBottom:Math.max(insets.bottom,6),borderTopWidth:1,borderColor:C.line,flexDirection:'row',alignItems:'center',justifyContent:'space-around',backgroundColor:C.white,elevation:8}}>
      {([['Chats','▤'],['Updates','◉'],['Channels','◈'],['Calls','⌕'],['You','●']] as string[][]).map(([t,icon])=><Btn key={t} onPress={()=>setTab(t)} style={{alignItems:'center',minWidth:58}}><Text style={{fontSize:19,color:tab===t?C.green:C.muted}}>{icon}</Text><Text style={{fontSize:10,fontWeight:tab===t?'900':'600',color:tab===t?C.green:C.muted,marginTop:3}}>{t}</Text></Btn>)}
    </View>

    <Modal visible={groupCreateOpen} transparent animationType="slide" onRequestClose={()=>setGroupCreateOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'flex-end'}}>
        <View style={{backgroundColor:C.white,borderTopLeftRadius:24,borderTopRightRadius:24,padding:20,maxHeight:'88%'}}>
          <Text style={{fontSize:21,fontWeight:'900',color:C.ink}}>Create a group</Text>
          <Text style={{fontSize:12,color:C.muted,marginTop:5}}>Choose a name and add people from your saved contacts.</Text>
          <TextInput value={groupName} onChangeText={setGroupName} placeholder="Group name" maxLength={60} style={{backgroundColor:C.paper,borderRadius:14,padding:14,marginTop:15,color:C.ink}}/>
          <Text style={{fontSize:13,fontWeight:'900',color:C.ink,marginTop:16,marginBottom:8}}>Members ({selectedGroupIds.length})</Text>
          {groupContactsLoading?<ActivityIndicator color={C.green} style={{padding:24}}/>:groupContacts.length===0?
            <Text style={{color:C.muted,padding:20,textAlign:'center'}}>No saved contacts yet. Add contacts by username first.</Text>:
            <FlatList data={groupContacts} keyExtractor={(item:any)=>item.id} style={{maxHeight:300}} renderItem={({item}:any)=>{
              const selected=selectedGroupIds.includes(item.id);
              return <Btn onPress={()=>toggleGroupMember(item.id)} style={{flexDirection:'row',alignItems:'center',gap:11,paddingVertical:10,borderBottomWidth:1,borderColor:C.line}}>
                <Avatar label={initials(item.display_name||item.username||'G')} color={colorFor(item.id)} size={42} uri={item.avatar_signed_url}/>
                <View style={{flex:1}}><Text style={{fontWeight:'800',color:C.ink}}>{item.display_name||'Guftin member'}</Text><Text style={{fontSize:11,color:C.muted}}>@{item.username||'member'}</Text></View>
                <Text style={{fontSize:20,color:selected?C.green:C.muted,fontWeight:'900'}}>{selected?'☑':'＋'}</Text>
              </Btn>;
            }}/>}
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:18}}>
            <Btn onPress={()=>setGroupCreateOpen(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={groupCreating||groupContactsLoading||selectedGroupIds.length===0} onPress={()=>void createGroup()} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>
              {groupCreating?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>Create group</Text>}
            </Btn>
          </View>
        </View>
      </View>
    </Modal>

    <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={()=>setSettingsOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'flex-end'}}><View style={{backgroundColor:C.white,borderTopLeftRadius:24,borderTopRightRadius:24,padding:22}}>
        <Text style={{fontSize:21,fontWeight:'900',color:C.ink}}>Guftin settings</Text>
        <Text style={{color:C.muted,fontSize:12,marginTop:5,marginBottom:15}}>Privacy and connection preferences</Text>
        <Btn onPress={()=>{setSettingsOpen(false);setPermissionSetupStep(0);setPermissionSetupAutoSave(mediaAutoDownload);setPermissionSetupNotice('');setPermissionSetupVisible(true);}} style={{backgroundColor:C.mint,padding:12,borderRadius:13,marginBottom:7}}>
          <Text style={{color:C.green,fontWeight:'900',textAlign:'center'}}>Review app permissions</Text>
        </Btn>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Show online status</Text><Text style={{color:C.muted,fontSize:11}}>Let contacts see when you are online</Text></View><Switch value={onlineVisibility} onValueChange={setOnlineVisibility} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Read receipts</Text><Text style={{color:C.muted,fontSize:11}}>Show seen status on messages</Text></View><Switch value={showReadReceipts} onValueChange={setShowReadReceipts} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Push notifications on this phone</Text><Text style={{color:C.muted,fontSize:11}}>Messages, status likes/views, and incoming call alerts with Accept/Decline</Text></View><Switch value={pushEnabled} disabled={pushBusy} onValueChange={enabled=>enabled?void enablePushNotifications():void disablePushNotifications()} trackColor={{true:C.green}}/></View>
        <Btn disabled={pushBusy||!session} onPress={()=>void testPushNotifications()} style={{backgroundColor:C.mint,padding:12,borderRadius:13,marginTop:2,marginBottom:7,opacity:pushBusy ? .55 : 1}}>
          <Text style={{color:C.green,fontWeight:'900',textAlign:'center'}}>{pushBusy?'Checking notification service…':'Send test notification to this phone'}</Text>
        </Btn>
        <View style={{padding:13,backgroundColor:C.mint,borderRadius:13,marginTop:6,marginBottom:8}}>
          <Text style={{color:C.green,fontWeight:'900',textAlign:'center'}}>Guftin in-app calling</Text>
          <Text style={{color:C.muted,fontSize:11,textAlign:'center',marginTop:5,lineHeight:17}}>Incoming, outgoing and active calls use Guftin's own call screens. Android Phone app calling-account setup is not required.</Text>
        </View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Automatic message sync</Text><Text style={{color:C.muted,fontSize:11}}>Refresh while Guftin is open</Text></View><Switch value={autoSync} onValueChange={setAutoSync} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Auto-save incoming photos/videos</Text><Text style={{color:C.muted,fontSize:11}}>Save new media to your gallery automatically</Text></View><Switch value={mediaAutoDownload} onValueChange={setMediaAutoDownload} trackColor={{true:C.green}}/></View>
        <Text style={{color:C.ink,fontWeight:'800',marginTop:12}}>App theme</Text>
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:10}}>
          {([['emerald','#087e6c','Emerald'],['ocean','#2476d2','Ocean'],['violet','#7950c8','Violet'],['sunset','#d45b42','Sunset'],['night','#101a2b','Night']] as any[]).map(([name,color,label])=><Btn key={name} onPress={()=>setThemeName(name)} style={{paddingHorizontal:13,paddingVertical:10,borderRadius:13,backgroundColor:color,borderWidth:themeName===name?3:0,borderColor:'#f2c75c'}}><Text style={{color:'#fff',fontWeight:'900',fontSize:11}}>{label}</Text></Btn>)}
        </View>
        <Text style={{fontSize:10,color:C.muted,marginTop:10}}>Gallery access is requested only when you save media or enable auto-save.</Text>
        <Text style={{color:C.ink,fontWeight:'800',marginTop:10}}>Sync interval</Text><View style={{flexDirection:'row',gap:8,marginTop:10}}>{[15,30,60].map(seconds=><Btn key={seconds} onPress={()=>setSyncIntervalSeconds(seconds)} style={{flex:1,padding:12,borderRadius:12,backgroundColor:syncIntervalSeconds===seconds?C.green:C.paper,alignItems:'center'}}><Text style={{color:syncIntervalSeconds===seconds?'#fff':C.ink,fontWeight:'800'}}>{seconds}s</Text></Btn>)}</View>
        <Btn onPress={()=>setSettingsOpen(false)} style={{backgroundColor:C.green,padding:15,borderRadius:14,alignItems:'center',marginTop:20}}><Text style={{color:'#fff',fontWeight:'900'}}>Done</Text></Btn>
      </View></View>
    </Modal>

    <Modal visible={statusComposer} transparent animationType="fade" onRequestClose={()=>setStatusComposer(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:22}}>
        <View style={{backgroundColor:C.white,borderRadius:22,padding:22}}>
          <Text style={{fontSize:20,fontWeight:'900',color:C.ink}}>Add a status</Text>
          <Text style={{color:C.muted,lineHeight:19,marginTop:7,marginBottom:16}}>Your text status is visible to Guftin contacts for 24 hours.</Text>
          <Btn onPress={chooseStatusMedia} style={{backgroundColor:C.mint,padding:13,borderRadius:12,alignItems:'center',marginBottom:12}}><Text style={{color:C.green,fontWeight:'800'}}>{statusAsset?'Change selected media':'＋ Add photo or video'}</Text></Btn>
          {statusAsset?<Text style={{color:C.green,fontSize:12,marginBottom:8}}>Selected: {statusAsset.fileName||statusAsset.type||'Media'}</Text>:null}
          <TextInput value={statusText} onChangeText={setStatusText} placeholder="What's new?" maxLength={700} multiline style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink,minHeight:120,textAlignVertical:'top'}}/>
          <Text style={{color:C.muted,fontSize:10,marginTop:7,textAlign:'right'}}>{statusText.length}/700</Text>
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:15}}>
            <Btn onPress={()=>setStatusComposer(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={publishingStatus||(!statusText.trim()&&!statusAsset)} onPress={publishStatus} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>{publishingStatus?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Share status</Text>}</Btn>
          </View>
        </View>
      </View>
    </Modal>


    <Modal visible={channelCreateOpen} transparent animationType="slide" onRequestClose={()=>setChannelCreateOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'flex-end'}}>
        <View style={{backgroundColor:C.white,borderTopLeftRadius:24,borderTopRightRadius:24,padding:21}}>
          <Text style={{fontSize:21,fontWeight:'900',color:C.ink}}>Create a channel</Text>
          <Text style={{fontSize:12,color:C.muted,marginTop:5}}>Create multiple channels and invite followers with a shareable link.</Text>
          <TextInput value={channelTitle} onChangeText={setChannelTitle} placeholder="Channel name" maxLength={60} style={{backgroundColor:C.paper,borderRadius:14,padding:14,marginTop:15,color:C.ink}}/>
          <TextInput value={channelDescription} onChangeText={setChannelDescription} placeholder="Description (optional)" maxLength={500} multiline style={{backgroundColor:C.paper,borderRadius:14,padding:14,marginTop:10,minHeight:75,textAlignVertical:'top',color:C.ink}}/>
          <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:14}}>
            <View style={{flex:1,paddingRight:12}}><Text style={{fontWeight:'900',color:C.ink}}>Public channel</Text><Text style={{fontSize:11,color:C.muted,marginTop:3}}>Anyone can discover and follow it</Text></View>
            <Switch value={channelPublic} onValueChange={setChannelPublic} trackColor={{true:C.green}}/>
          </View>
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:20}}>
            <Btn onPress={()=>setChannelCreateOpen(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={channelBusy||channelTitle.trim().length<2} onPress={()=>void createChannel()} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>{channelBusy?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>Create channel</Text>}</Btn>
          </View>
        </View>
      </View>
    </Modal>
    <Modal visible={channelJoinOpen} transparent animationType="fade" onRequestClose={()=>setChannelJoinOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:22}}>
        <View style={{backgroundColor:C.white,borderRadius:22,padding:22}}>
          <Text style={{fontSize:20,fontWeight:'900',color:C.ink}}>Join a channel</Text>
          <Text style={{fontSize:12,color:C.muted,lineHeight:18,marginTop:7,marginBottom:14}}>Paste a Guftin channel invite code. Opening an invite link in Guftin will also join it.</Text>
          <TextInput value={channelInviteCode} onChangeText={setChannelInviteCode} autoCapitalize="none" placeholder="Invite code" style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:18}}>
            <Btn onPress={()=>setChannelJoinOpen(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={channelBusy||!channelInviteCode.trim()} onPress={()=>void joinChannelByInvite(channelInviteCode)} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>{channelBusy?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>Join channel</Text>}</Btn>
          </View>
        </View>
      </View>
    </Modal>
    <Modal visible={addOpen} transparent animationType="fade" onRequestClose={()=>setAddOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:22}}>
        <View style={{backgroundColor:C.white,borderRadius:22,padding:22}}>
          <Text style={{fontSize:20,fontWeight:'900',color:C.ink}}>Find a Guftin user</Text>
          <Text style={{color:C.muted,lineHeight:19,marginTop:7,marginBottom:16}}>Search by their exact username. Example: ali_786</Text>
          <TextInput value={contactUsername} onChangeText={v=>setContactUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} autoCapitalize="none" placeholder="Username (without @)" style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
          <Btn onPress={()=>{setAddOpen(false);void openGroupCreator();}} style={{padding:12,alignSelf:'flex-start',marginTop:12}}><Text style={{color:C.green,fontWeight:'800'}}>👥 Create a group instead</Text></Btn>
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:18}}>
            <Btn onPress={()=>setAddOpen(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={adding} onPress={addContact} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>{adding?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Find and add</Text>}</Btn>
          </View>
        </View>
      </View>
    </Modal>
  </SafeAreaView>;
}

export default function App(){
  return <SafeAreaProvider><GuftinApp/></SafeAreaProvider>;
}
