import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator, Alert, AppState, BackHandler, FlatList, Image, KeyboardAvoidingView, Modal,
  Platform, RefreshControl, ScrollView, StatusBar, Switch, Text, TextInput, ToastAndroid,
  TouchableOpacity, View
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from './src/lib/supabase';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Audio } from 'expo-av';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import mobileAds, { BannerAd, BannerAdSize, MaxAdContentRating, TestIds } from 'react-native-google-mobile-ads';
import { File, Paths } from 'expo-file-system';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as ExpoCrypto from 'expo-crypto';
import { DeviceIdentity, E2EE_MEDIA_PREFIX, E2EE_PREFIX, decryptCallKeyForDevice, decryptMediaForDevice, decryptMessageForDevice, encryptCallKeyForDevices, encryptMediaForDevices, encryptMessageForDevices, loadOrCreateDeviceIdentity } from './src/lib/e2ee';
import { AudioSession, LiveKitRoom, VideoTrack, isTrackReference, registerGlobals, useRNE2EEManager, useTracks } from '@livekit/react-native';
import { Track } from 'livekit-client';

WebBrowser.maybeCompleteAuthSession();
registerGlobals();
Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowAlert:true,shouldPlaySound:true,shouldSetBadge:true,shouldShowBanner:true,shouldShowList:true})});

let C:any = { ink:'#102b27', muted:'#82938e', green:'#087e6c', mint:'#e5f5ee', paper:'#f5f8f6', white:'#fff', line:'#e9efec', red:'#b94e48' };
const THEMES:any = {
  emerald:{ink:'#102b27',muted:'#82938e',green:'#087e6c',mint:'#e5f5ee',paper:'#f5f8f6',white:'#fff',line:'#e9efec',red:'#b94e48'},
  ocean:{ink:'#112b46',muted:'#71869e',green:'#2476d2',mint:'#e5f0ff',paper:'#f4f8ff',white:'#fff',line:'#e0e9f5',red:'#c94f68'},
  violet:{ink:'#2d2145',muted:'#8b7c9f',green:'#7950c8',mint:'#efe8ff',paper:'#f8f5ff',white:'#fff',line:'#ece4f7',red:'#c45073'},
  sunset:{ink:'#472b2b',muted:'#987c73',green:'#d45b42',mint:'#ffede4',paper:'#fff7f2',white:'#fff',line:'#f3e4dc',red:'#b63f4b'},
  night:{ink:'#edf3ff',muted:'#9baac0',green:'#77b9ff',mint:'#223d5d',paper:'#101a2b',white:'#1a2940',line:'#2a3b54',red:'#ff8894'}
};
type Chat = { id:string; name:string; avatar:string; avatarUrl?:string; color:string; last:string; time:string; unread:number; online:boolean; kind:string; lastAt:number };
type Message = { id:string; conversation_id:string; sender_id:string|null; body:string|null; message_type:string; attachment_url?:string|null; created_at:string; mine:boolean; deleted_at?:string|null; pending?:boolean };
const AUTH_REDIRECT_URL = 'kingchat://auth/callback';
const palette = ['#d49a91','#8796c7','#81ad98','#bd8aa8','#c4a47c','#9a91bd'];
// Supabase chat-media is currently configured for 50 MB per object. Keep encrypted
// uploads below that ceiling because authenticated encryption adds a small overhead.
const MAX_MEDIA_BYTES = 45 * 1024 * 1024;
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
    await Notifications.setNotificationChannelAsync('calls',{
      name:'Incoming calls',
      description:'Guftin voice and video call alerts',
      importance:Notifications.AndroidImportance.MAX,
      vibrationPattern:[0,500,250,500,250,700],
      sound:'default',
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

function CallRoomScreen({callType,onHangUp}:any) {
  const tracks=useTracks([Track.Source.Camera]);
  useEffect(()=>{
    void AudioSession.startAudioSession();
    return ()=>{void AudioSession.stopAudioSession();};
  },[]);
  return <SafeAreaView style={{flex:1,backgroundColor:'#102b27'}}>
    <StatusBar barStyle="light-content"/>
    <View style={{flex:1,justifyContent:'center',padding:18}}>
      <Text style={{fontSize:24,fontWeight:'900',color:'#fff',textAlign:'center'}}>
        {callType==='video'?'Video call':'Voice call'}
      </Text>
      {callType==='video'?<FlatList
        data={tracks}
        keyExtractor={(item:any)=>item.publication?.trackSid||item.participant.identity}
        renderItem={({item}:any)=>isTrackReference(item)
          ?<VideoTrack trackRef={item} style={{height:260,borderRadius:16,marginTop:16}}/>
          :<View style={{height:130,alignItems:'center',justifyContent:'center'}}><Text style={{color:'#fff'}}>Waiting for camera…</Text></View>}
        ListEmptyComponent={<Text style={{color:'#fff',textAlign:'center',marginTop:25}}>Waiting for video…</Text>}
      />:<View style={{alignItems:'center',padding:35}}>
        <Text style={{fontSize:50,color:'#fff'}}>☎</Text>
        <Text style={{color:'#d8e8e1',marginTop:14}}>Guftin voice connection</Text>
      </View>}
    </View>
    <View style={{padding:20,alignItems:'center'}}>
      <Btn onPress={onHangUp} style={{backgroundColor:'#c43e48',paddingHorizontal:30,paddingVertical:15,borderRadius:30}}>
        <Text style={{color:'#fff',fontWeight:'900'}}>End call</Text>
      </Btn>
    </View>
  </SafeAreaView>;
}
function SecureLiveKitRoom({liveCall,onDisconnected,onHangUp}:any) {
  // Each participant unwraps the same random call key from their own device envelope.
  const {e2eeManager}=useRNE2EEManager({sharedKey:liveCall.e2eeKey});
  return <LiveKitRoom
    serverUrl={liveCall.serverUrl}
    token={liveCall.token}
    connect={true}
    audio={true}
    video={liveCall.callType==='video'}
    options={{e2ee:{e2eeManager}}}
    onDisconnected={onDisconnected}
    onEncryptionError={(error:any)=>Alert.alert('Call encryption error',error?.message||'Media encryption could not be started.')}
  >
    <CallRoomScreen callType={liveCall.callType} onHangUp={onHangUp}/>
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
  return <VideoView player={player} style={{width:230,height:165,borderRadius:12}} nativeControls allowsFullscreen contentFit="contain"/>;
}

function GuftinApp() {
  const insets=useSafeAreaInsets();
  const [tab,setTab]=useState('Chats');
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
  const loadMessagesRef=useRef<((id:string)=>Promise<void>)|null>(null);
  const flushPendingMessagesRef=useRef<(()=>Promise<void>)|null>(null);
  useEffect(()=>{
    activeConversationIdRef.current=active?.id||null;
  },[active?.id]);
  const [draft,setDraft]=useState('');
  const [search,setSearch]=useState('');
  const [searching,setSearching]=useState(false);
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [sending,setSending]=useState(false);
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
  const [syncIntervalSeconds,setSyncIntervalSeconds]=useState(4);
  const [settingsLoaded,setSettingsLoaded]=useState(false);
  const [publishingStatus,setPublishingStatus]=useState(false);
  const [deviceIdentity,setDeviceIdentity]=useState<DeviceIdentity|null>(null);
  const [e2eeStatus,setE2eeStatus]=useState<'loading'|'ready'|'error'>('loading');
  const [incomingCall,setIncomingCall]=useState<any>(null);
  const [outgoingCall,setOutgoingCall]=useState<any>(null);
  const [liveCall,setLiveCall]=useState<any>(null);
  const [callBusy,setCallBusy]=useState(false);
  const [callHistory,setCallHistory]=useState<any[]>([]);
  const [adsReady,setAdsReady]=useState(false);
  const [pushEnabled,setPushEnabled]=useState(false);
  const [pushBusy,setPushBusy]=useState(false);
  const [pushPermissionReady,setPushPermissionReady]=useState(false);
  const [themeName,setThemeName]=useState('emerald');
  const [deliveredByMessage,setDeliveredByMessage]=useState<Record<string,string>>({});
  const hiddenMessageIds=useRef(new Set<string>());
  const handledNotificationResponses=useRef(new Set<string>());
  const joiningCallIds=useRef(new Set<string>());
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
          if([3,5,10].includes(saved.syncIntervalSeconds))setSyncIntervalSeconds(saved.syncIntervalSeconds);
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

  // Ask for notification permission once on the first app launch, after creating
  // Android channels (required by Android 13+ before the permission dialog can show).
  // Push-token registration waits for this request to finish and for Auth to restore.
  useEffect(()=>{
    let mounted=true;
    const requestNotificationPermissionOnFirstLaunch=async()=>{
      try{
        await configureGuftinNotificationChannels();
        let permission=await Notifications.getPermissionsAsync();
        const alreadyPrompted=await AsyncStorage.getItem('guftin-notification-permission-prompted-v1');
        if(!permission.granted&&!alreadyPrompted&&permission.canAskAgain!==false){
          await AsyncStorage.setItem('guftin-notification-permission-prompted-v1','yes');
          permission=await Notifications.requestPermissionsAsync();
        }
        if(mounted)setPushPermissionReady(true);
      }catch(error:any){
        console.warn('First-launch notification permission setup:',error?.message||error);
        if(mounted)setPushPermissionReady(true);
      }
    };
    void requestNotificationPermissionOnFirstLaunch();
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
      if(cached){const parsed=JSON.parse(cached);if(Array.isArray(parsed)){setChats(parsed);setLoading(false);}}
    }catch{ /* Ignore a damaged local inbox cache and try the server. */ }
    try{
      const {data:memberships,error}=await supabase.from('kc_conversation_members')
        .select('conversation_id,joined_at,last_read_at,hidden_at,conversation:kc_conversations!inner(id,kind,title,photo_url,updated_at)')
        .eq('user_id',session.user.id).is('hidden_at',null);
      if(error) throw error;
      const rows=(memberships||[]) as any[];
      const ids=rows.map(r=>r.conversation_id).filter(Boolean);
      if(ids.length===0){setChats([]);void AsyncStorage.setItem(inboxCacheKey,'[]').catch(()=>{});return;}
      const [memberResult,profileResult,messageResult,hiddenResult]=await Promise.all([
        supabase.from('kc_conversation_members').select('conversation_id,user_id,last_read_at,joined_at').in('conversation_id',ids),
        supabase.from('kc_profiles').select('id,display_name,avatar_url,is_online').neq('id',session.user.id),
        supabase.from('kc_messages').select('id,conversation_id,sender_id,body,message_type,created_at,deleted_at')
          .in('conversation_id',ids).is('deleted_at',null).order('created_at',{ascending:false}).limit(500),
        supabase.from('kc_message_hidden').select('message_id').eq('user_id',session.user.id)
      ]);
      if(memberResult.error) throw memberResult.error;
      if(messageResult.error) throw messageResult.error;
      const members=(memberResult.data||[]) as any[];
      const hiddenIds=new Set((hiddenResult.data||[]).map((row:any)=>row.message_id));
      const inboxMessages=((messageResult.data||[]) as any[]).filter(message=>!hiddenIds.has(message.id));
      const peerIds=[...new Set(members.filter(m=>m.user_id!==session.user.id).map(m=>m.user_id))];
      const profiles=(profileResult.error?[]:(profileResult.data||[])) as any[];
      const profileMap=new Map(profiles.filter(p=>peerIds.includes(p.id)).map(p=>[p.id,p]));
      const latest=new Map<string,any>();
      for(const message of inboxMessages) if(!latest.has(message.conversation_id)) latest.set(message.conversation_id,message);
      const mapped:Chat[]=(await Promise.all(rows.map(async row=>{
        const conv=row.conversation||{};
        const peers=members.filter(m=>m.conversation_id===row.conversation_id&&m.user_id!==session.user.id);
        const peer=peers.length?profileMap.get(peers[0].user_id):null;
        const name=conv.kind==='group'?(conv.title||'Group chat'):(peer?.display_name||'Guftin member');
        const avatarPath=conv.kind==='group'?(conv.photo_url||null):(peer?.avatar_url||null);
        const avatarUrl=avatarPath?(await getSignedMediaUrl(avatarPath))||undefined:undefined;
        const last=latest.get(row.conversation_id);
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
          else if(typeof last.body==='string'&&last.body.startsWith(E2EE_PREFIX)){
            try{preview=deviceIdentity?decryptMessageForDevice(last.body,deviceIdentity):'🔒 Encrypted message';}
            catch{preview='🔒 Encrypted message';}
          }else preview=last.body||'Attachment';
        }
        return {id:row.conversation_id,name,avatar:initials(name),avatarUrl,color:colorFor(name),last:preview,
          time:last?timeLabel(last.created_at):'',unread,online:!!peer?.is_online,kind:conv.kind||'direct',
          lastAt:last?new Date(last.created_at).getTime():new Date(conv.updated_at||row.joined_at).getTime()};
      }))).sort((a,b)=>b.lastAt-a.lastAt);
      setChats(mapped);
      void AsyncStorage.setItem(inboxCacheKey,JSON.stringify(mapped)).catch(()=>{});
    }catch(e:any){
      if(!isConnectivityFailure(e))Alert.alert('Inbox could not load',e?.message||'Please try again.');
    }finally{setLoading(false);}
  },[session,deviceIdentity,getSignedMediaUrl]);

  const loadCallHistory=useCallback(async()=>{
    if(!session)return;
    const {data,error}=await supabase.from('kc_call_logs')
      .select('id,conversation_id,caller_id,callee_id,call_type,status,started_at,ended_at')
      .or('caller_id.eq.'+session.user.id+',callee_id.eq.'+session.user.id)
      .order('started_at',{ascending:false}).limit(100);
    if(error){console.warn('Call history:',error.message);return;}
    const rows=(data||[]) as any[];
    const peers=[...new Set(rows.map(row=>row.caller_id===session.user.id?row.callee_id:row.caller_id).filter(Boolean))];
    const {data:profiles}=peers.length?await supabase.from('kc_profiles').select('id,display_name,avatar_url').in('id',peers):{data:[]};
    const profileMap=new Map((profiles||[]).map((p:any)=>[p.id,p]));
    setCallHistory(rows.map(row=>{
      const peerId=row.caller_id===session.user.id?row.callee_id:row.caller_id;
      const peer:any=profileMap.get(peerId);
      return {...row,peer_name:peer?.display_name||'Guftin member',outgoing:row.caller_id===session.user.id};
    }));
  },[session]);

  const resolveMessage=useCallback(async(raw:any):Promise<Message>=>{
    let attachment_url=raw.attachment_url||null;
    if(attachment_url){
      attachment_url=await getSignedMediaUrl(attachment_url);
    }
    let body=raw.body||null;
    if(typeof body==='string'&&body.startsWith(E2EE_MEDIA_PREFIX)){
      try{
        if(!attachment_url||!deviceIdentity)throw new Error('The local encryption key is not available.');
        const response=await fetch(attachment_url);
        if(!response.ok)throw new Error('Encrypted media could not be downloaded.');
        const encryptedBytes=new Uint8Array(await response.arrayBuffer());
        const decrypted=decryptMediaForDevice(encryptedBytes,body,deviceIdentity);
        const safeExtension=(decrypted.fileName.split('.').pop()||'bin').toLowerCase().replace(/[^a-z0-9]/g,'')||'bin';
        const localFile=new File(Paths.cache,'kc_'+raw.id+'.'+safeExtension);
        if(localFile.exists)localFile.delete();
        localFile.create();
        await localFile.write(decrypted.bytes);
        attachment_url=localFile.uri;
        body=decrypted.fileName;
      }catch(e:any){
        attachment_url=null;
        body='🔒 Encrypted media — '+(e?.message||'unable to decrypt on this device.');
      }
    }else if(typeof body==='string'&&body.startsWith(E2EE_PREFIX)){
      try{
        body=deviceIdentity?decryptMessageForDevice(body,deviceIdentity):'🔒 Encrypted message — this device key is not ready.';
      }catch(e:any){
        body='🔒 Encrypted message — '+(e?.message||'unable to decrypt on this device.');
      }
    }
    return {...raw,body,attachment_url,mine:raw.sender_id===session?.user?.id,deleted_at:raw.deleted_at||null};
  },[session,deviceIdentity,getSignedMediaUrl]);

  useEffect(()=>{
    let mounted=true;
    const registerPreviouslyAllowedDevice=async()=>{
      setPushEnabled(false);
      if(!session||!pushPermissionReady)return;
      const permission=await Notifications.getPermissionsAsync();
      if(!permission.granted)return;
      const projectId=getExpoProjectId();
      if(!projectId){
        console.warn('Push permission is granted, but EXPO_PUBLIC_EAS_PROJECT_ID is missing from this build.');
        return;
      }
      await configureGuftinNotificationChannels();
      const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
      const {error}=await supabase.from('kc_device_tokens').upsert({
        user_id:session.user.id,token,platform:Platform.OS
      },{onConflict:'token'});
      if(mounted)setPushEnabled(!error);
      if(error)console.warn('Push token registration:',error.message);
    };
    void registerPreviouslyAllowedDevice().catch(error=>console.warn('Push registration check:',error?.message||error));
    return ()=>{mounted=false;};
  },[session?.user?.id,pushPermissionReady]);

  const enablePushNotifications=async()=>{
    if(!session||pushBusy)return;
    setPushBusy(true);
    try{
      await configureGuftinNotificationChannels();
      let permission=await Notifications.getPermissionsAsync();
      if(!permission.granted)permission=await Notifications.requestPermissionsAsync();
      if(!permission.granted)throw new Error('Notification permission was not granted.');
      const projectId=getExpoProjectId();
      if(!projectId){
        throw new Error('Push notifications are not linked to an Expo project yet. Add EXPO_PUBLIC_EAS_PROJECT_ID to the Guftin Android build and configure FCM credentials before background delivery can be enabled.');
      }
      const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
      const {error}=await supabase.from('kc_device_tokens').upsert({
        user_id:session.user.id,token,platform:Platform.OS
      },{onConflict:'token'});
      if(error)throw error;
      setPushEnabled(true);
      Alert.alert('Notifications enabled','This device is registered for Guftin message and call alerts. Delivery still depends on the platform push credentials.');
    }catch(e:any){
      setPushEnabled(false);
      Alert.alert('Notifications not enabled',e?.message||'Please check notification permissions and push credentials.');
    }finally{setPushBusy(false);}
  };

  const disablePushNotifications=async()=>{
    if(!session||pushBusy)return;
    setPushBusy(true);
    try{
      const projectId=getExpoProjectId();
      if(projectId){
        const token=(await Notifications.getExpoPushTokenAsync({projectId})).data;
        await supabase.from('kc_device_tokens').delete().eq('user_id',session.user.id).eq('token',token);
      }
      setPushEnabled(false);
    }catch(e:any){Alert.alert('Could not turn notifications off',e?.message||'Please try again.');}
    finally{setPushBusy(false);}
  };

  const dispatchPush=async(kind:'message'|'call'|'status'|'status_like'|'status_view',id:string)=>{
    try{
      const payload=kind==='message'?{kind,message_id:id}:kind==='call'?{kind,call_id:id}:{kind,status_id:id};
      const {error}=await supabase.functions.invoke('guftin-push',{body:payload});
      if(error)console.warn('Push dispatch:',error.message);
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
    const {error}=await supabase.from('kc_conversation_members')
      .update({hidden_at:new Date().toISOString()})
      .eq('conversation_id',chat.id).eq('user_id',session.user.id);
    if(error){Alert.alert('Chat not deleted',error.message);return;}
    setChats(prev=>prev.filter(item=>item.id!==chat.id));
    if(active?.id===chat.id)setActive(null);
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
        .select('id,conversation_id,caller_id,callee_id,call_type,status,e2ee_key_envelopes')
        .eq('id',call.id).maybeSingle();
      if(callRecordError)throw callRecordError;
      if(!callRecord||callRecord.status!=='accepted')throw new Error('The call is no longer accepted.');
      const e2eeKey=decryptCallKeyForDevice(callRecord.e2ee_key_envelopes,deviceIdentity);
      const {data,error}=await supabase.functions.invoke('livekit-token',{body:{call_id:call.id}});
      if(error)throw error;
      if(!data?.server_url||!data?.participant_token)throw new Error(data?.error||'The LiveKit token endpoint is not ready.');
      setLiveCall({id:call.id,callType:callRecord.call_type,serverUrl:data.server_url,token:data.participant_token,e2eeKey});
      setIncomingCall(null);
      setOutgoingCall(null);
    }catch(e:any){
      let details=e?.message||'LiveKit credentials are missing or the call is no longer active.';
      // Supabase FunctionsHttpError keeps the function's JSON response in context.
      // Show the real server reason (e.g. missing LiveKit secrets) instead of the
      // generic "non-2xx status code" message.
      try{
        const response=e?.context;
        if(response&&typeof response.clone==='function'){
          const body=await response.clone().json();
          if(typeof body?.error==='string'&&body.error.trim())details=body.error;
        }
      }catch{ /* Fall back to the SDK message if the response has no JSON body. */ }
      Alert.alert('Call could not connect',details);
      await supabase.from('kc_call_logs').update({status:'ended',ended_at:new Date().toISOString()}).eq('id',call.id);
      setIncomingCall(null);
      setOutgoingCall(null);
    }finally{
      joiningCallIds.current.delete(call.id);
    }
  },[session,deviceIdentity,e2eeStatus]);

  const respondToCall=useCallback(async(call:any,status:'accepted'|'declined')=>{
    if(!session||!call?.id)return;
    const update:any={status};
    if(status==='accepted')update.started_at=new Date().toISOString();
    else update.ended_at=new Date().toISOString();
    const {error}=await supabase.from('kc_call_logs').update(update).eq('id',call.id);
    if(error){Alert.alert('Call action failed',error.message);return;}
    setIncomingCall(null);
    if(status==='accepted')await joinCall({...call,status:'accepted'});
    else setOutgoingCall(null);
  },[session,joinCall]);

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
      }
    });
    const channel=supabase.channel('kingchat-user-'+session.user.id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'kc_messages'},async payload=>{
        const m=payload.new as any;
        const item=await resolveMessage(m);
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
        if(call.callee_id===session.user.id&&call.status==='ringing'){
          setIncomingCall(call);
          Alert.alert(
            call.call_type==='video'?'Incoming video call':'Incoming voice call',
            'A Guftin contact is calling you.',
            [
              {text:'Decline',style:'cancel',onPress:()=>void respondToCall(call,'declined')},
              {text:'Accept',onPress:()=>void respondToCall(call,'accepted')}
            ],
            {cancelable:false}
          );
        }
        if(call.caller_id===session.user.id&&call.status==='accepted'){
          void joinCall(call);
        }
        if(['declined','ended','missed','cancelled'].includes(call.status)){
          setIncomingCall((old:any)=>old?.id===call.id?null:old);
          setOutgoingCall((old:any)=>old?.id===call.id?null:old);
          setLiveCall((old:any)=>old?.id===call.id?null:old);
        }
      }).subscribe((status,error)=>{
        if(status==='SUBSCRIBED'){
          console.log('Guftin realtime connected');
          void flushPendingMessagesRef.current?.();
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
      }
    },Math.max(3,syncIntervalSeconds)*1000);
    return ()=>{
      clearInterval(syncTimer);
      appState.remove();
      void supabase.removeChannel(channel);
      setIncomingCall(null);setOutgoingCall(null);setLiveCall(null);
      void supabase.from('kc_profiles').update({is_online:false,last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    };
  },[session,loadProfile,loadInbox,resolveMessage,joinCall,respondToCall,onlineVisibility,autoSync,syncIntervalSeconds,showReadReceipts,mediaAutoDownload]);

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
        void supabase.from('kc_call_logs').select('id,conversation_id,caller_id,callee_id,call_type,status')
          .eq('id',data.call_id).maybeSingle().then(({data:call})=>{
            if(call?.status!=='ringing')return;
            setTab('Calls');
            if(action==='accept_call'){
              void respondToCall(call,'accepted');
              return;
            }
            if(action==='decline_call'){
              void respondToCall(call,'declined');
              return;
            }
            setIncomingCall(call);
            Alert.alert(
              call.call_type==='video'?'Incoming video call':'Incoming voice call',
              'A Guftin contact is calling you.',
              [
                {text:'Decline',style:'cancel',onPress:()=>void respondToCall(call,'declined')},
                {text:'Accept',onPress:()=>void respondToCall(call,'accepted')}
              ],
              {cancelable:false}
            );
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
    const subscription=Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    void Notifications.getLastNotificationResponseAsync().then(response=>{
      if(response)handleNotificationResponse(response);
    });
    return ()=>subscription.remove();
  },[session,respondToCall,loadInbox]);

  const loadMessages=useCallback(async(conversationId:string)=>{
    if(!session) return;
    const messageCacheKey='guftin-cache-messages:'+session.user.id+':'+conversationId;
    try{
      const cached=await AsyncStorage.getItem(messageCacheKey);
      if(cached){const parsed=JSON.parse(cached);if(Array.isArray(parsed))setMessages(prev=>({...prev,[conversationId]:parsed}));}
    }catch{ /* Ignore a damaged message cache and continue with the server request. */ }
    const {data,error}=await supabase.from('kc_messages')
      .select('id,conversation_id,sender_id,body,message_type,attachment_url,created_at,deleted_at')
      .eq('conversation_id',conversationId)
      .order('created_at',{ascending:true}).limit(200);
    if(error){if(!isConnectivityFailure(error))Alert.alert('Messages could not load',error.message);return;}
    const {data:hiddenRows}=await supabase.from('kc_message_hidden').select('message_id').eq('user_id',session.user.id);
    const hidden=new Set((hiddenRows||[]).map((row:any)=>row.message_id));
    const visibleRows=(data||[]).filter((message:any)=>!hidden.has(message.id));
    const resolved=await Promise.all(visibleRows.map((m:any)=>resolveMessage(m)));
    setMessages(prev=>({...prev,[conversationId]:resolved}));
    void AsyncStorage.setItem(messageCacheKey,JSON.stringify(resolved.map(item=>({...item,attachment_url:null})))).catch(()=>{});
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
  },[session,resolveMessage,loadInbox,showReadReceipts]);
  loadMessagesRef.current=loadMessages;

  useEffect(()=>{
    if(session&&deviceIdentity&&active)void loadMessages(active.id);
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

  useEffect(()=>{
    if(!pendingNotificationConversation)return;
    const chat=chats.find(item=>item.id===pendingNotificationConversation);
    if(chat){
      setPendingNotificationConversation(null);
      void openChat(chat);
    }
  },[pendingNotificationConversation,chats]);

  const queueOfflineTextMessage=async(conversationId:string,text:string)=>{
    if(!session)return;
    const id=ExpoCrypto.randomUUID();
    const localId='pending:'+id;
    const queueKey='guftin-pending-messages:'+session.user.id;
    const entry={id,localId,conversation_id:conversationId,text,created_at:new Date().toISOString()};
    let queue:any[]=[];
    try{const raw=await AsyncStorage.getItem(queueKey);queue=raw?JSON.parse(raw):[];if(!Array.isArray(queue))queue=[];}catch{queue=[];}
    queue.push(entry);
    await AsyncStorage.setItem(queueKey,JSON.stringify(queue));
    const optimistic:Message={id:localId,conversation_id:conversationId,sender_id:session.user.id,body:text,message_type:'text',created_at:entry.created_at,mine:true,pending:true};
    setMessages(prev=>({...prev,[conversationId]:[...(prev[conversationId]||[]).filter(item=>item.id!==localId),optimistic]}));
    setChats(prev=>{
      const next=prev.map(chat=>chat.id===conversationId?{...chat,last:text,time:timeLabel(entry.created_at),lastAt:Date.now()}:chat);
      void AsyncStorage.setItem('guftin-cache-inbox:'+session.user.id,JSON.stringify(next)).catch(()=>{});
      return next;
    });
    void AsyncStorage.setItem('guftin-cache-messages:'+session.user.id+':'+conversationId,JSON.stringify([...(messages[conversationId]||[]).filter(item=>item.id!==localId),optimistic].map(item=>({...item,attachment_url:null})))).catch(()=>{});
    setDraft('');
  };

  const sendMessage=async()=>{
    const body=draft.trim();
    if(!body||!active||!session||sending) return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      Alert.alert('Secure chat is not ready','Guftin is still setting up this device encryption key. Check your connection and reopen the app.');
      return;
    }
    setSending(true);
    const conversationId=active.id;
    try{
      const {data:members,error:membersError}=await supabase.from('kc_conversation_members')
        .select('user_id').eq('conversation_id',conversationId);
      if(membersError)throw membersError;
      const memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
      if(!memberIds.includes(session.user.id))throw new Error('You are no longer a member of this conversation.');

      const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
        .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
      if(devicesError)throw devicesError;
      const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
      const missingUsers=memberIds.filter(id=>!registeredUsers.has(id));
      if(missingUsers.length){
        throw new Error('A conversation member has not registered an encryption device yet. Ask them to update and open Guftin before sending secure messages.');
      }
      const encryptedBody=encryptMessageForDevices(body,devices||[],deviceIdentity);
      const {data,error}=await supabase.from('kc_messages').insert({
        conversation_id:conversationId,sender_id:session.user.id,body:encryptedBody,message_type:'text'
      }).select('id,conversation_id,sender_id,message_type,created_at').single();
      if(error)throw error;
      setDraft('');
      void dispatchPush('message',data.id);
      const item:Message={...data,body,mine:true};
      setMessages(prev=>{
        const old=prev[conversationId]||[];
        return {...prev,[conversationId]:old.some(x=>x.id===item.id)?old:[...old,item]};
      });
      void loadInbox();
    }catch(e:any){
      if(isConnectivityFailure(e)){
        try{await queueOfflineTextMessage(conversationId,body);}
        catch(queueError:any){Alert.alert('Message could not be saved',queueError?.message||'This device could not store the pending message.');}
      }else{
        Alert.alert('Secure message not sent',e?.message||'Please try again.');
      }
    }finally{
      setSending(false);
    }
  };

  const flushPendingMessages=useCallback(async()=>{
    if(!session||!deviceIdentity||e2eeStatus!=='ready')return;
    const queueKey='guftin-pending-messages:'+session.user.id;
    let queue:any[]=[];
    try{const raw=await AsyncStorage.getItem(queueKey);queue=raw?JSON.parse(raw):[];}catch{return;}
    if(!Array.isArray(queue)||queue.length===0)return;
    const remaining:any[]=[];
    for(let index=0;index<queue.length;index++){
      const pending=queue[index];
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
        if(memberIds.some(id=>!registeredUsers.has(id)))throw new Error('A conversation member has not registered an encryption device yet.');
        const encryptedBody=encryptMessageForDevices(pending.text,devices||[],deviceIdentity);
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
    await AsyncStorage.setItem(queueKey,JSON.stringify(remaining)).catch(()=>{});
    if(remaining.length<queue.length)void loadInbox();
  },[session,deviceIdentity,e2eeStatus,loadInbox]);
  flushPendingMessagesRef.current=flushPendingMessages;
  useEffect(()=>{
    if(session&&deviceIdentity&&e2eeStatus==='ready')void flushPendingMessages();
  },[session?.user?.id,deviceIdentity?.deviceId,e2eeStatus,flushPendingMessages]);

  const uploadVoiceMessage=async(uri:string)=>{
    if(!active||!session||!deviceIdentity||e2eeStatus!=='ready')throw new Error('Secure chat is not ready.');
    const file=new File(uri);if(file.size>MAX_MEDIA_BYTES)throw new Error('This file is larger than the current 45 MB cloud-storage limit.');
    const {data:members,error:membersError}=await supabase.from('kc_conversation_members').select('user_id').eq('conversation_id',active.id);
    if(membersError)throw membersError;
    const memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
    const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices').select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
    if(devicesError)throw devicesError;
    const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
    if(memberIds.some(id=>!registeredUsers.has(id)))throw new Error('All chat members must open the latest Guftin build first.');
    const plain=new Uint8Array(await file.arrayBuffer());
    const encrypted=encryptMediaForDevices(plain,devices||[],deviceIdentity,'audio/mp4','voice-message.m4a');plain.fill(0);
    const objectPath=session.user.id+'/'+active.id+'/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.enc';
    const {error:uploadError}=await supabase.storage.from('chat-media').upload(objectPath,encrypted.ciphertext,{contentType:'application/octet-stream',upsert:false});
    if(uploadError)throw uploadError;
    const {data,error}=await supabase.from('kc_messages').insert({conversation_id:active.id,sender_id:session.user.id,body:encrypted.body,message_type:'audio',attachment_url:objectPath}).select('id,conversation_id,sender_id,message_type,attachment_url,created_at').single();
    if(error){await supabase.storage.from('chat-media').remove([objectPath]);throw error;}
    void dispatchPush('message',data.id);
    const item=await resolveMessage({...data,body:encrypted.body});
    setMessages(prev=>({...prev,[active.id]:[...(prev[active.id]||[]),item]}));void loadInbox();
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
    try{await recording.stopAndUnloadAsync();const uri=recording.getURI();setRecording(null);if(uri)await uploadVoiceMessage(uri);await Audio.setAudioModeAsync({allowsRecordingIOS:false,playsInSilentModeIOS:true});}
    catch(e:any){setRecording(null);Alert.alert('Voice message not sent',e?.message||'Please try again.');}
    finally{setRecordingBusy(false);}
  };

  const sendMedia=async()=>{
    if(!active||!session||sending)return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      Alert.alert('Secure media is not ready','Guftin is still setting up this device encryption key.');
      return;
    }
    try{
      const result=await ImagePicker.launchImageLibraryAsync({
        mediaTypes:['images','videos'],
        allowsEditing:false,
        quality:0.85,
        videoMaxDuration:60
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
      setSending(true);
      const {data:members,error:membersError}=await supabase.from('kc_conversation_members')
        .select('user_id').eq('conversation_id',active.id);
      if(membersError)throw membersError;
      const memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
      const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
        .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
      if(devicesError)throw devicesError;
      const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
      if(memberIds.some(id=>!registeredUsers.has(id))){
        throw new Error('A conversation member must open the latest Guftin build before receiving encrypted media.');
      }

      const plainBytes=new Uint8Array(await file.arrayBuffer());
      const encrypted=encryptMediaForDevices(
        plainBytes,devices||[],deviceIdentity,contentType,asset.fileName||('attachment.'+(messageType==='video'?'mp4':'jpg'))
      );
      plainBytes.fill(0);
      const objectPath=session.user.id+'/'+active.id+'/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.enc';
      const {error:uploadError}=await supabase.storage.from('chat-media').upload(objectPath,encrypted.ciphertext,{
        contentType:'application/octet-stream',cacheControl:'3600',upsert:false
      });
      if(uploadError)throw uploadError;
      const {data,error}=await supabase.from('kc_messages').insert({
        conversation_id:active.id,sender_id:session.user.id,
        body:encrypted.body,message_type:messageType,attachment_url:objectPath
      }).select('id,conversation_id,sender_id,message_type,created_at').single();
      if(error){
        await supabase.storage.from('chat-media').remove([objectPath]);
        throw error;
      }
      void dispatchPush('message',data.id);
      const item:Message={...data,body:messageType==='video'?'Video':'Photo',attachment_url:asset.uri,mine:true};
      setMessages(prev=>{
        const old=prev[active.id]||[];
        return {...prev,[active.id]:old.some(x=>x.id===item.id)?old:[...old,item]};
      });
      void loadInbox();
    }catch(e:any){
      Alert.alert('Encrypted media not sent',e?.message||'Please try another image or video.');
    }finally{
      setSending(false);
    }
  };

  const startCall=async(callType:'voice'|'video')=>{
    if(!active||!session||callBusy)return;
    if(!deviceIdentity||e2eeStatus!=='ready'){
      Alert.alert('Secure calling not ready','Open Guftin on both phones and wait until secure chat is ready before starting a call.');
      return;
    }
    if(active.kind!=='direct'){
      Alert.alert('Direct calls only','Group calls are not enabled in this first calling build.');
      return;
    }
    setCallBusy(true);
    try{
      const {data:members,error:memberError}=await supabase.from('kc_conversation_members')
        .select('user_id').eq('conversation_id',active.id);
      if(memberError)throw memberError;
      const memberIds=[...new Set((members||[]).map((row:any)=>row.user_id))] as string[];
      const peers=memberIds.filter((id:string)=>id!==session.user.id);
      if(peers.length!==1||memberIds.length!==2)throw new Error('This call needs exactly one other member in the direct chat.');
      const {data:devices,error:devicesError}=await supabase.from('kc_e2ee_devices')
        .select('id,user_id,public_key').in('user_id',memberIds).is('revoked_at',null);
      if(devicesError)throw devicesError;
      const registeredUsers=new Set((devices||[]).map((device:any)=>device.user_id));
      if(memberIds.some(id=>!registeredUsers.has(id)))throw new Error('Both users must open the latest Guftin version before making an encrypted call.');
      if(!(devices||[]).some((device:any)=>device.id===deviceIdentity.deviceId))throw new Error('This phone is not in the conversation encryption roster. Reopen Guftin and try again.');
      const callKey=ExpoCrypto.getRandomBytes(32);
      let e2eeKeyEnvelopes:any;
      try{
        e2eeKeyEnvelopes=encryptCallKeyForDevices(callKey,devices||[],deviceIdentity);
      }finally{
        callKey.fill(0);
      }
      const {data,error}=await supabase.from('kc_call_logs').insert({
        conversation_id:active.id,
        caller_id:session.user.id,
        callee_id:peers[0],
        call_type:callType,
        status:'ringing',
        e2ee_key_envelopes:e2eeKeyEnvelopes
      }).select('id,conversation_id,caller_id,callee_id,call_type,status').single();
      if(error)throw error;
      setOutgoingCall(data);
      void dispatchPush('call',data.id);
      Alert.alert('Calling','Calling '+active.name+'. Keep Guftin open while they answer.');
    }catch(e:any){
      Alert.alert('Call could not start',e?.message||'Please try again.');
    }finally{
      setCallBusy(false);
    }
  };

  const endCall=async(callId:string)=>{
    await supabase.from('kc_call_logs').update({status:'ended',ended_at:new Date().toISOString()}).eq('id',callId);
    setLiveCall(null);
    setOutgoingCall(null);
    setIncomingCall(null);
  };

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
    const {data,error}=await supabase.rpc('kc_add_contact_by_username',{p_username:cleanUsername});
    setAdding(false);
    if(error){Alert.alert('Could not find contact',error.message);return;}
    const row=Array.isArray(data)?data[0]:data;
    if(!row?.conversation_id){Alert.alert('Contact not found','No Guftin account uses this username yet.');return;}
    setAddOpen(false);setContactUsername('');
    await supabase.from('kc_conversation_members').update({hidden_at:null})
      .eq('conversation_id',row.conversation_id).eq('user_id',session.user.id);
    const name=row.display_name||row.username||'Guftin member';
    const chat:Chat={id:row.conversation_id,name,avatar:initials(name),color:colorFor(name),last:'No messages yet',time:'',unread:0,online:false,kind:'direct',lastAt:Date.now()};
    setChats(prev=>[chat,...prev.filter(c=>c.id!==chat.id)]);
    setActive(chat);
    await loadMessages(chat.id);
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
    const [peopleResult,viewsResult,likesResult]=await Promise.all([
      supabase.from('kc_profiles').select('id,display_name,username,avatar_url').in('id',[...new Set(rows.map(row=>row.user_id))]),
      supabase.from('kc_status_views').select('status_id,viewer_id,viewed_at').in('status_id',ids),
      supabase.from('kc_status_likes').select('status_id,user_id,created_at').in('status_id',ids)
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
      const avatarPath=(people.get(row.user_id) as any)?.avatar_url||null;
      const avatarSigned=avatarPath?await getSignedMediaUrl(avatarPath):null;
      const views=(viewsResult.data||[]).filter((view:any)=>view.status_id===row.id);
      const likes=(likesResult.data||[]).filter((like:any)=>like.status_id===row.id);
      return {
        ...row,
        display_name:(people.get(row.user_id) as any)?.display_name||'Guftin member',
        username:(people.get(row.user_id) as any)?.username||'',
        avatar_signed_url:avatarSigned,
        status_count:rows.filter(candidate=>candidate.user_id===row.user_id).length,
        media_signed_url:signed,
        view_count:views.length,
        viewer_names:views.map((view:any)=>(statusActorMap.get(view.viewer_id) as any)?.display_name||'Guftin member'),
        liker_names:likes.map((like:any)=>(statusActorMap.get(like.user_id) as any)?.display_name||'Guftin member'),
        like_count:likes.length,
        liked_by_me:likes.some((like:any)=>like.user_id===session.user.id)
      };
    }));
    setStatuses(mapped);
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
  const pageTitle=tab==='Chats'?'Messages':tab==='Updates'?'Updates':tab==='Calls'?'Calls':'You';

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

  if(liveCall){
    return <SecureLiveKitRoom
      liveCall={liveCall}
      onDisconnected={()=>void endCall(liveCall.id)}
      onHangUp={()=>void endCall(liveCall.id)}
    />;
  }

  if(active){
    const list=messages[active.id]||[];
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper}}>
      <StatusBar barStyle="dark-content"/>
      <View style={{minHeight:82,backgroundColor:C.white,flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingVertical:7,borderBottomWidth:1,borderColor:C.line,elevation:2}}>
        <Btn onPress={()=>setActive(null)} style={{padding:10}}><Text style={{fontSize:24,color:C.ink}}>‹</Text></Btn>
        <Avatar label={active.avatar} color={active.color} size={43} online={active.online} uri={active.avatarUrl}/>
        <Btn onPress={()=>void openChatDetails()} style={{flex:1,marginLeft:11,alignItems:'flex-start'}}>
          <Text numberOfLines={1} style={{fontWeight:'900',fontSize:15,color:C.ink}}>{active.name}</Text>
          <Text style={{fontSize:11,color:active.online?C.green:C.muted}}>{active.kind==='group'?'Tap for group info':outgoingCall?'Calling…':active.online?'● online':'Tap for contact info'}</Text>
        </Btn>
        <Btn disabled={callBusy||!!outgoingCall} onPress={()=>void startCall('voice')} style={{backgroundColor:C.mint,borderRadius:15,width:56,height:58,alignItems:'center',justifyContent:'center',opacity:callBusy?0.5:1,borderWidth:1,borderColor:'#cce9dc'}}><Text style={{fontSize:20,color:C.green}}>☎</Text><Text style={{fontSize:10,fontWeight:'900',color:C.green}}>Call</Text></Btn>
        <Btn disabled={callBusy||!!outgoingCall} onPress={()=>void startCall('video')} style={{backgroundColor:C.mint,borderRadius:15,width:56,height:58,alignItems:'center',justifyContent:'center',opacity:callBusy?0.5:1,borderWidth:1,borderColor:'#cce9dc'}}><Text style={{fontSize:19,color:C.green}}>▣</Text><Text style={{fontSize:10,fontWeight:'900',color:C.green}}>Video</Text></Btn>
      </View>
      <FlatList data={list} keyExtractor={m=>m.id} contentContainerStyle={{padding:18,gap:12,flexGrow:1,justifyContent:list.length?'flex-end':'center'}}
        ListEmptyComponent={<Text style={{textAlign:'center',color:C.muted}}>No messages yet. Send the first message.</Text>}
        renderItem={({item})=><TouchableOpacity activeOpacity={1} onLongPress={()=>deleteMessage(item)} delayLongPress={420} style={{alignSelf:item.mine?'flex-end':'flex-start',maxWidth:'84%',backgroundColor:item.mine?'#dff4e8':C.white,padding:13,borderRadius:17,borderTopRightRadius:item.mine?5:17,borderTopLeftRadius:item.mine?17:5}}>
          {item.deleted_at?<Text style={{fontSize:12,color:C.muted,fontStyle:'italic'}}>This message was deleted</Text>:item.message_type==='image'&&item.attachment_url?<Image source={{uri:item.attachment_url}} style={{width:210,height:210,borderRadius:12}} resizeMode="cover"/>:item.message_type==='video'&&item.attachment_url?<VideoBubble uri={item.attachment_url}/>:item.message_type==='audio'&&item.attachment_url?<AudioBubble uri={item.attachment_url}/>:<Text style={{color:C.ink,fontSize:14,lineHeight:21}}>{item.body||'Attachment'}</Text>}
          {!item.deleted_at&&['image','video'].includes(item.message_type)&&item.attachment_url?<Btn onPress={()=>void saveMediaToGallery(item)} style={{marginTop:7,paddingVertical:6,paddingHorizontal:9,borderRadius:9,backgroundColor:C.paper,alignSelf:'flex-start'}}><Text style={{fontSize:11,color:C.green,fontWeight:'800'}}>↓ Save to gallery</Text></Btn>:null}
          <Text style={{textAlign:'right',fontSize:9,color:C.muted,marginTop:5}}>
            {timeLabel(item.created_at)}{item.pending?' · Queued':item.mine ? " · " + (showReadReceipts && peerLastReadAt && new Date(peerLastReadAt).getTime() >= new Date(item.created_at).getTime() ? "✓✓ Read" : deliveredByMessage[item.id] ? "✓✓ Delivered" : "✓ Sent") : ""}
          </Text>
        </TouchableOpacity>}/>
      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined}>
        <View style={{flexDirection:'row',alignItems:'center',padding:11,gap:8,backgroundColor:C.white}}>
          <Btn disabled={sending} onPress={sendMedia} style={{width:42,height:42,borderRadius:15,backgroundColor:C.paper,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:23,color:C.green}}>＋</Text></Btn>
          <Btn disabled={sending||recordingBusy} onPress={recording?stopVoiceRecording:startVoiceRecording} style={{width:42,height:42,borderRadius:15,backgroundColor:recording?'#fde8e8':C.paper,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:18,color:recording?C.red:C.green}}>{recording?'■':'🎙'}</Text></Btn>
          <TextInput value={draft} onChangeText={setDraft} placeholder={recording?'Recording… tap ■ to send':'Write a message...'} multiline maxLength={4000} style={{flex:1,maxHeight:110,backgroundColor:C.paper,borderRadius:16,paddingHorizontal:15,paddingVertical:12,color:C.ink}}/>
          <Btn disabled={!draft.trim()||sending} onPress={sendMessage} style={{backgroundColor:C.green,width:46,height:46,borderRadius:16,alignItems:'center',justifyContent:'center'}}>
            {sending?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontSize:20}}>➤</Text>}
          </Btn>
        </View>
      </KeyboardAvoidingView>
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

    </SafeAreaView>;
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
              <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{fontWeight:'800',color:C.ink,fontSize:14}}>{item.name}</Text><Text style={{fontSize:10,color:C.muted}}>{item.time}</Text></View>
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
          <Text style={{fontWeight:'900',color:C.ink}}>{status.user_id===session.user.id?'You':status.display_name}{status.username?'  @'+status.username:''}</Text>
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
      {([['Chats','▤'],['Updates','◉'],['Calls','⌕'],['You','●']] as string[][]).map(([t,icon])=><Btn key={t} onPress={()=>setTab(t)} style={{alignItems:'center',minWidth:64}}><Text style={{fontSize:19,color:tab===t?C.green:C.muted}}>{icon}</Text><Text style={{fontSize:10,fontWeight:tab===t?'900':'600',color:tab===t?C.green:C.muted,marginTop:3}}>{t}</Text></Btn>)}
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
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Show online status</Text><Text style={{color:C.muted,fontSize:11}}>Let contacts see when you are online</Text></View><Switch value={onlineVisibility} onValueChange={setOnlineVisibility} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Read receipts</Text><Text style={{color:C.muted,fontSize:11}}>Show seen status on messages</Text></View><Switch value={showReadReceipts} onValueChange={setShowReadReceipts} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Push notifications on this phone</Text><Text style={{color:C.muted,fontSize:11}}>Messages, status likes/views, and incoming call alerts with Accept/Decline</Text></View><Switch value={pushEnabled} disabled={pushBusy} onValueChange={enabled=>enabled?void enablePushNotifications():void disablePushNotifications()} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Automatic message sync</Text><Text style={{color:C.muted,fontSize:11}}>Refresh while Guftin is open</Text></View><Switch value={autoSync} onValueChange={setAutoSync} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Auto-save incoming photos/videos</Text><Text style={{color:C.muted,fontSize:11}}>Save new media to your gallery automatically</Text></View><Switch value={mediaAutoDownload} onValueChange={setMediaAutoDownload} trackColor={{true:C.green}}/></View>
        <Text style={{color:C.ink,fontWeight:'800',marginTop:12}}>App theme</Text>
        <View style={{flexDirection:'row',flexWrap:'wrap',gap:8,marginTop:10}}>
          {([['emerald','#087e6c','Emerald'],['ocean','#2476d2','Ocean'],['violet','#7950c8','Violet'],['sunset','#d45b42','Sunset'],['night','#101a2b','Night']] as any[]).map(([name,color,label])=><Btn key={name} onPress={()=>setThemeName(name)} style={{paddingHorizontal:13,paddingVertical:10,borderRadius:13,backgroundColor:color,borderWidth:themeName===name?3:0,borderColor:'#f2c75c'}}><Text style={{color:'#fff',fontWeight:'900',fontSize:11}}>{label}</Text></Btn>)}
        </View>
        <Text style={{fontSize:10,color:C.muted,marginTop:10}}>Gallery access is requested only when you save media or enable auto-save.</Text>
        <Text style={{color:C.ink,fontWeight:'800',marginTop:10}}>Sync interval</Text><View style={{flexDirection:'row',gap:8,marginTop:10}}>{[3,5,10].map(seconds=><Btn key={seconds} onPress={()=>setSyncIntervalSeconds(seconds)} style={{flex:1,padding:12,borderRadius:12,backgroundColor:syncIntervalSeconds===seconds?C.green:C.paper,alignItems:'center'}}><Text style={{color:syncIntervalSeconds===seconds?'#fff':C.ink,fontWeight:'800'}}>{seconds}s</Text></Btn>)}</View>
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
