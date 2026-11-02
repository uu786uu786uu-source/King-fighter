import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator, Alert, AppState, FlatList, Image, KeyboardAvoidingView, Modal,
  Platform, RefreshControl, SafeAreaView, ScrollView, StatusBar, Switch, Text,
  TextInput, TouchableOpacity, View
} from 'react-native';
import { supabase } from './src/lib/supabase';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { File, Paths } from 'expo-file-system';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as ExpoCrypto from 'expo-crypto';
import { DeviceIdentity, E2EE_MEDIA_PREFIX, E2EE_PREFIX, decryptMediaForDevice, decryptMessageForDevice, encryptMediaForDevices, encryptMessageForDevices, loadOrCreateDeviceIdentity } from './src/lib/e2ee';
import { AudioSession, LiveKitRoom, VideoTrack, isTrackReference, registerGlobals, useTracks } from '@livekit/react-native';
import { Track } from 'livekit-client';

WebBrowser.maybeCompleteAuthSession();
registerGlobals();

const C = { ink:'#102b27', muted:'#82938e', green:'#087e6c', mint:'#e5f5ee', paper:'#f5f8f6', white:'#fff', line:'#e9efec', red:'#b94e48' };
type Chat = { id:string; name:string; avatar:string; avatarUrl?:string; color:string; last:string; time:string; unread:number; online:boolean; kind:string; lastAt:number };
type Message = { id:string; conversation_id:string; sender_id:string|null; body:string|null; message_type:string; attachment_url?:string|null; created_at:string; mine:boolean };
const AUTH_REDIRECT_URL = 'kingchat://auth/callback';
const palette = ['#d49a91','#8796c7','#81ad98','#bd8aa8','#c4a47c','#9a91bd'];
const initials = (s:string) => s.trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || 'KC';
const colorFor = (s:string) => { let n=0; for(let i=0;i<s.length;i++) n=(n*31+s.charCodeAt(i))>>>0; return palette[n%palette.length]; };
const timeLabel = (value:string) => {
  if(!value) return '';
  const d=new Date(value), now=new Date();
  if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const yesterday=new Date(now); yesterday.setDate(now.getDate()-1);
  return d.toDateString()===yesterday.toDateString()?'Yesterday':d.toLocaleDateString([], {day:'numeric',month:'short'});
};
function Btn({children,onPress,style,disabled}:any) {
  return <TouchableOpacity disabled={disabled} onPress={onPress} activeOpacity={.75} style={[style,disabled?{opacity:.55}:null]}>{children}</TouchableOpacity>;
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

export default function App() {
  const [tab,setTab]=useState('Chats');
  const [session,setSession]=useState<any>(null);
  const [profile,setProfile]=useState<any>(null);
  const [profileReady,setProfileReady]=useState(false);
  const [chats,setChats]=useState<Chat[]>([]);
  const [active,setActive]=useState<Chat|null>(null);
  const [messages,setMessages]=useState<Record<string,Message[]>>({});
  const [peerLastReadAt,setPeerLastReadAt]=useState<string|null>(null);
  const activeConversationIdRef=useRef<string|null>(null);
  const loadMessagesRef=useRef<((id:string)=>Promise<void>)|null>(null);
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
  const joiningCallIds=useRef(new Set<string>());

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

  const [profileName,setProfileName]=useState('');
  const [profileUsername,setProfileUsername]=useState('');
  const [about,setAbout]=useState('');
  const [savingProfile,setSavingProfile]=useState(false);
  const handledAuthUrls=useRef(new Set<string>());

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
        }catch{ /* Ignore an outdated or malformed local preferences record. */ }
      }
      setSettingsLoaded(true);
    }).catch(()=>{if(active)setSettingsLoaded(true);});
    return ()=>{active=false;};
  },[]);

  useEffect(()=>{
    if(!settingsLoaded)return;
    void AsyncStorage.setItem('guftin-preferences',JSON.stringify({showReadReceipts,onlineVisibility,autoSync,syncIntervalSeconds,mediaAutoDownload}));
  },[settingsLoaded,showReadReceipts,onlineVisibility,autoSync,syncIntervalSeconds,mediaAutoDownload]);

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
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));
    const linkSub=Linking.addEventListener('url',({url})=>{void completeAuthUrl(url);});
    Linking.getInitialURL().then(url=>{if(url) void completeAuthUrl(url);});
    return ()=>{subscription.unsubscribe();linkSub.remove();};
  },[completeAuthUrl]);

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
    const {data,error}=await supabase.from('kc_profiles')
      .select('id,display_name,username,about,avatar_url,is_online')
      .eq('id',session.user.id).maybeSingle();
    if(error){console.warn('Profile load:',error.message);setProfileReady(true);return;}
    setProfile(data);
    setProfileName(data?.display_name||session.user.user_metadata?.display_name||'');
    setProfileUsername(data?.username||session.user.user_metadata?.username||'');
    setAbout(data?.about||'');
    setProfileAvatarPath(data?.avatar_url||'');
    if(data?.avatar_url){const {data:avatarData}=await supabase.storage.from('chat-media').createSignedUrl(data.avatar_url,60*60*24);setProfileAvatarUrl(avatarData?.signedUrl||'');}
    else setProfileAvatarUrl('');
    setProfileReady(true);
  },[session]);

  const loadInbox=useCallback(async()=>{
    if(!session) return;
    setLoading(true);
    try{
      const {data:memberships,error}=await supabase.from('kc_conversation_members')
        .select('conversation_id,joined_at,last_read_at,conversation:kc_conversations!inner(id,kind,title,updated_at)')
        .eq('user_id',session.user.id);
      if(error) throw error;
      const rows=(memberships||[]) as any[];
      const ids=rows.map(r=>r.conversation_id).filter(Boolean);
      if(ids.length===0){setChats([]);return;}
      const [memberResult,profileResult,messageResult]=await Promise.all([
        supabase.from('kc_conversation_members').select('conversation_id,user_id,last_read_at,joined_at').in('conversation_id',ids),
        supabase.from('kc_profiles').select('id,display_name,avatar_url,is_online').neq('id',session.user.id),
        supabase.from('kc_messages').select('id,conversation_id,sender_id,body,message_type,created_at')
          .in('conversation_id',ids).is('deleted_at',null).order('created_at',{ascending:false}).limit(500)
      ]);
      if(memberResult.error) throw memberResult.error;
      if(messageResult.error) throw messageResult.error;
      const members=(memberResult.data||[]) as any[];
      const peerIds=[...new Set(members.filter(m=>m.user_id!==session.user.id).map(m=>m.user_id))];
      const profiles=(profileResult.error?[]:(profileResult.data||[])) as any[];
      const profileMap=new Map(profiles.filter(p=>peerIds.includes(p.id)).map(p=>[p.id,p]));
      const latest=new Map<string,any>();
      for(const message of (messageResult.data||[]) as any[]) if(!latest.has(message.conversation_id)) latest.set(message.conversation_id,message);
      const mapped:Chat[]=(await Promise.all(rows.map(async row=>{
        const conv=row.conversation||{};
        const peers=members.filter(m=>m.conversation_id===row.conversation_id&&m.user_id!==session.user.id);
        const peer=peers.length?profileMap.get(peers[0].user_id):null;
        const name=conv.kind==='group'?(conv.title||'Group chat'):(peer?.display_name||'Guftin member');
        const avatarUrl=peer?.avatar_url?(await supabase.storage.from('chat-media').createSignedUrl(peer.avatar_url,60*60*24)).data?.signedUrl||undefined:undefined;
        const last=latest.get(row.conversation_id);
        const readThrough=Math.max(
          row.last_read_at?new Date(row.last_read_at).getTime():0,
          row.joined_at?new Date(row.joined_at).getTime():0
        );
        const unread=(messageResult.data||[]).filter((message:any)=>
          message.conversation_id===row.conversation_id &&
          message.sender_id!==session.user.id &&
          new Date(message.created_at).getTime()>readThrough
        ).length;
        let preview='No messages yet';
        if(last){
          if(last.message_type==='image')preview='Photo';
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
    }catch(e:any){
      Alert.alert('Inbox could not load',e?.message||'Please check your connection and try again.');
    }finally{setLoading(false);}
  },[session,deviceIdentity]);

  const resolveMessage=useCallback(async(raw:any):Promise<Message>=>{
    let attachment_url=raw.attachment_url||null;
    if(attachment_url){
      const {data,error}=await supabase.storage.from('chat-media').createSignedUrl(attachment_url,60*60*24);
      attachment_url=error?null:(data?.signedUrl||null);
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
    return {...raw,body,attachment_url,mine:raw.sender_id===session?.user?.id};
  },[session,deviceIdentity]);

  const joinCall=useCallback(async(call:any)=>{
    if(!call?.id||joiningCallIds.current.has(call.id))return;
    joiningCallIds.current.add(call.id);
    try{
      const {data,error}=await supabase.functions.invoke('livekit-token',{body:{call_id:call.id}});
      if(error)throw error;
      if(!data?.server_url||!data?.participant_token)throw new Error(data?.error||'The LiveKit token endpoint is not ready.');
      setLiveCall({id:call.id,callType:call.call_type,serverUrl:data.server_url,token:data.participant_token});
      setIncomingCall(null);
      setOutgoingCall(null);
    }catch(e:any){
      Alert.alert('Call could not connect',e?.message||'LiveKit credentials are missing or the call is no longer active.');
      await supabase.from('kc_call_logs').update({status:'ended',ended_at:new Date().toISOString()}).eq('id',call.id);
      setIncomingCall(null);
      setOutgoingCall(null);
    }finally{
      joiningCallIds.current.delete(call.id);
    }
  },[]);

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
      if(state==='active'){void loadInbox();if(activeConversationIdRef.current)void loadMessagesRef.current?.(activeConversationIdRef.current);void loadProfile();}
    });
    const channel=supabase.channel('kingchat-user-'+session.user.id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'kc_messages'},async payload=>{
        const m=payload.new as any;
        const item=await resolveMessage(m);
        setMessages(prev=>{
          const old=prev[m.conversation_id]||[];
          return {...prev,[m.conversation_id]:old.some(x=>x.id===m.id)?old:[...old,item]};
        });
        if(showReadReceipts&&activeConversationIdRef.current===m.conversation_id && m.sender_id!==session.user.id){
          void supabase.rpc('kc_mark_conversation_read',{p_conversation_id:m.conversation_id});
        }
        void loadInbox();
      })
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'kc_conversation_members'},payload=>{
        const member=payload.new as any;
        if(member.conversation_id===activeConversationIdRef.current && member.user_id!==session.user.id){
          setPeerLastReadAt(member.last_read_at||null);
        }
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
      }).subscribe();
    const syncTimer=setInterval(()=>{if(autoSync&&AppState.currentState==='active'){void loadInbox();if(activeConversationIdRef.current)void loadMessagesRef.current?.(activeConversationIdRef.current);}},Math.max(3,syncIntervalSeconds)*1000);
    return ()=>{
      clearInterval(syncTimer);
      appState.remove();
      void supabase.removeChannel(channel);
      setIncomingCall(null);setOutgoingCall(null);setLiveCall(null);
      void supabase.from('kc_profiles').update({is_online:false,last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    };
  },[session,loadProfile,loadInbox,resolveMessage,joinCall,respondToCall,onlineVisibility,autoSync,syncIntervalSeconds,showReadReceipts]);

  const loadMessages=useCallback(async(conversationId:string)=>{
    if(!session) return;
    const {data,error}=await supabase.from('kc_messages')
      .select('id,conversation_id,sender_id,body,message_type,attachment_url,created_at')
      .eq('conversation_id',conversationId).is('deleted_at',null)
      .order('created_at',{ascending:true}).limit(200);
    if(error){Alert.alert('Messages could not load',error.message);return;}
    const resolved=await Promise.all((data||[]).map((m:any)=>resolveMessage(m)));
    setMessages(prev=>({...prev,[conversationId]:resolved}));
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
    await loadMessages(chat.id);
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
      const item:Message={...data,body,mine:true};
      setMessages(prev=>{
        const old=prev[conversationId]||[];
        return {...prev,[conversationId]:old.some(x=>x.id===item.id)?old:[...old,item]};
      });
      void loadInbox();
    }catch(e:any){
      Alert.alert('Secure message not sent',e?.message||'Please try again.');
    }finally{
      setSending(false);
    }
  };

  const uploadVoiceMessage=async(uri:string)=>{
    if(!active||!session||!deviceIdentity||e2eeStatus!=='ready')throw new Error('Secure chat is not ready.');
    const file=new File(uri);if(file.size>20*1024*1024)throw new Error('Voice message is too large.');
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
      if(file.size>20*1024*1024){
        Alert.alert('File too large','Encrypted media is currently limited to 20 MB per photo or video.');
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
    if(active.kind!=='direct'){
      Alert.alert('Direct calls only','Group calls are not enabled in this first calling build.');
      return;
    }
    setCallBusy(true);
    try{
      const {data:members,error:memberError}=await supabase.from('kc_conversation_members')
        .select('user_id').eq('conversation_id',active.id);
      if(memberError)throw memberError;
      const peers=[...new Set((members||[]).map((row:any)=>row.user_id).filter((id:string)=>id!==session.user.id))] as string[];
      if(peers.length!==1)throw new Error('This call needs exactly one other member in the direct chat.');
      const {data,error}=await supabase.from('kc_call_logs').insert({
        conversation_id:active.id,
        caller_id:session.user.id,
        callee_id:peers[0],
        call_type:callType,
        status:'ringing'
      }).select('id,conversation_id,caller_id,callee_id,call_type,status').single();
      if(error)throw error;
      setOutgoingCall(data);
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
      const {data}=await supabase.storage.from('chat-media').createSignedUrl(objectPath,60*60*24);
      setProfileAvatarPath(objectPath);setProfileAvatarUrl(data?.signedUrl||asset.uri);
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
        const file=new File(statusAsset.uri);if(file.size>20*1024*1024)throw new Error('Status media must be under 20 MB.');
        const bytes=new Uint8Array(await file.arrayBuffer()),ext=statusAsset.type==='video'?'mp4':'jpg',path=session.user.id+'/status/'+Date.now()+'_'+ExpoCrypto.randomUUID()+'.'+ext;
        const mime=statusAsset.mimeType||(statusAsset.type==='video'?'video/mp4':'image/jpeg');
        const {error:uploadError}=await supabase.storage.from('chat-media').upload(path,bytes,{contentType:mime,upsert:false});bytes.fill(0);
        if(uploadError)throw uploadError;media_url=path;
      }catch(e:any){setPublishingStatus(false);Alert.alert('Status upload failed',e?.message||'Please try again.');return;}
    }
    const {error}=await supabase.from('kc_status_updates').insert({user_id:session.user.id,caption:caption||null,media_url});
    setPublishingStatus(false);
    if(error){
      Alert.alert('Status not posted',error.message);
      return;
    }
    setStatusComposer(false);
    setStatusText('');setStatusAsset(null);
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

  const googleSignIn=async()=>{
    setAuthBusy(true);setAuthError('');
    try{
      const redirectTo=AUTH_REDIRECT_URL;
      const {data,error}=await supabase.auth.signInWithOAuth({
        provider:'google',options:{redirectTo,skipBrowserRedirect:true}
      });
      if(error) throw error;
      if(!data?.url) throw new Error('Google sign-in link could not be created.');
      const result=await WebBrowser.openAuthSessionAsync(data.url,redirectTo);
      if(result.type==='success') await completeAuthUrl(result.url);
    }catch(e:any){
      setAuthError(e?.message||'Google sign-in did not complete. Check Google provider settings.');
    }finally{setAuthBusy(false);}
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
    const {error:aboutError}=await supabase.from('kc_profiles').update({about:about.trim().slice(0,160),avatar_url:profileAvatarPath||null}).eq('id',session.user.id);
    setSavingProfile(false);
    if(aboutError){Alert.alert('About text not saved',aboutError.message);return;}
    await loadProfile();
    Alert.alert('Saved','Your Guftin profile has been updated.');
  };

  const loadStatuses=useCallback(async()=>{
    if(!session)return;
    const {data,error}=await supabase.from('kc_status_updates')
      .select('id,user_id,caption,media_url,created_at,expires_at')
      .gt('expires_at',new Date().toISOString())
      .order('created_at',{ascending:false}).limit(100);
    if(error){
      Alert.alert('Statuses could not load',error.message);
      return;
    }
    const rows=(data||[]) as any[];
    const ids=[...new Set(rows.map(row=>row.user_id))];
    if(!ids.length){setStatuses([]);return;}
    const {data:people}=await supabase.from('kc_profiles')
      .select('id,display_name,username').in('id',ids);
    const personMap=new Map((people||[]).map((person:any)=>[person.id,person]));
    const mapped=await Promise.all(rows.map(async row=>({
      ...row,
      display_name:(personMap.get(row.user_id) as any)?.display_name||'Guftin member',
      username:(personMap.get(row.user_id) as any)?.username||'',
      media_signed_url:row.media_url?(await supabase.storage.from('chat-media').createSignedUrl(row.media_url,60*60*24)).data?.signedUrl||null:null
    })));
    setStatuses(mapped);
  },[session]);

  useEffect(()=>{
    if(tab==='Updates'&&session)void loadStatuses();
  },[tab,session,loadStatuses]);

  const visible=useMemo(()=>chats.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())),[chats,search]);
  const pageTitle=tab==='Chats'?'Messages':tab==='Updates'?'Updates':tab==='Calls'?'Calls':'You';

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
        <View style={{flexDirection:'row',alignItems:'center',gap:10,marginVertical:17}}>
          <View style={{height:1,backgroundColor:C.line,flex:1}}/><Text style={{color:C.muted,fontSize:12}}>OR</Text><View style={{height:1,backgroundColor:C.line,flex:1}}/>
        </View>
        <Btn disabled={authBusy} onPress={googleSignIn} style={{backgroundColor:C.white,borderWidth:1,borderColor:C.line,padding:16,borderRadius:16,alignItems:'center',flexDirection:'row',justifyContent:'center',gap:10}}>
          <Text style={{fontWeight:'900',fontSize:18,color:'#4285F4'}}>G</Text><Text style={{color:C.ink,fontWeight:'800'}}>Continue with Google</Text>
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
    return <LiveKitRoom
      serverUrl={liveCall.serverUrl}
      token={liveCall.token}
      connect={true}
      audio={true}
      video={liveCall.callType==='video'}
      onDisconnected={()=>void endCall(liveCall.id)}
    >
      <CallRoomScreen callType={liveCall.callType} onHangUp={()=>void endCall(liveCall.id)}/>
    </LiveKitRoom>;
  }

  if(active){
    const list=messages[active.id]||[];
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper}}>
      <StatusBar barStyle="dark-content"/>
      <View style={{height:72,backgroundColor:C.white,flexDirection:'row',alignItems:'center',paddingHorizontal:15,borderBottomWidth:1,borderColor:C.line}}>
        <Btn onPress={()=>setActive(null)} style={{padding:10}}><Text style={{fontSize:24,color:C.ink}}>‹</Text></Btn>
        <Avatar label={active.avatar} color={active.color} size={43} online={active.online} uri={active.avatarUrl}/>
        <View style={{flex:1,marginLeft:11}}>
          <Text style={{fontWeight:'900',fontSize:15,color:C.ink}}>{active.name}</Text>
          <Text style={{fontSize:11,color:e2eeStatus==='ready'?C.green:C.muted}}>{active.online?'● online · ':''}{outgoingCall?'Calling…':e2eeStatus==='ready'?'🔒 Encrypted text & media · unverified keys':'Setting up secure chat…'}</Text>
        </View>
        <Btn disabled={callBusy||!!outgoingCall} onPress={()=>void startCall('voice')} style={{backgroundColor:C.mint,borderRadius:14,width:52,height:52,alignItems:'center',justifyContent:'center',opacity:callBusy?0.5:1}}><Text style={{fontSize:20,color:C.green}}>☎</Text><Text style={{fontSize:10,fontWeight:'900',color:C.green}}>Call</Text></Btn>
        <Btn disabled={callBusy||!!outgoingCall} onPress={()=>void startCall('video')} style={{backgroundColor:C.mint,borderRadius:14,width:52,height:52,alignItems:'center',justifyContent:'center',opacity:callBusy?0.5:1}}><Text style={{fontSize:19,color:C.green}}>▣</Text><Text style={{fontSize:10,fontWeight:'900',color:C.green}}>Video</Text></Btn>
      </View>
      <FlatList data={list} keyExtractor={m=>m.id} contentContainerStyle={{padding:18,gap:12,flexGrow:1,justifyContent:list.length?'flex-end':'center'}}
        ListEmptyComponent={<Text style={{textAlign:'center',color:C.muted}}>No messages yet. Send the first message.</Text>}
        renderItem={({item})=><View style={{alignSelf:item.mine?'flex-end':'flex-start',maxWidth:'84%',backgroundColor:item.mine?'#dff4e8':C.white,padding:13,borderRadius:17,borderTopRightRadius:item.mine?5:17,borderTopLeftRadius:item.mine?17:5}}>
          {item.message_type==='image'&&item.attachment_url?<Image source={{uri:item.attachment_url}} style={{width:210,height:210,borderRadius:12}} resizeMode="cover"/>:item.message_type==='video'&&item.attachment_url?<VideoBubble uri={item.attachment_url}/>:item.message_type==='audio'&&item.attachment_url?<AudioBubble uri={item.attachment_url}/>:<Text style={{color:C.ink,fontSize:14,lineHeight:21}}>{item.body||'Attachment'}</Text>}
          <Text style={{textAlign:'right',fontSize:9,color:C.muted,marginTop:5}}>
            {timeLabel(item.created_at)}{item.mine ? " · " + (showReadReceipts && peerLastReadAt && new Date(peerLastReadAt).getTime() >= new Date(item.created_at).getTime() ? "✓✓ Seen" : "✓ Sent") : ""}
          </Text>
        </View>}/>
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
    </SafeAreaView>;
  }

  return <SafeAreaView style={{flex:1,backgroundColor:C.white}}>
    <StatusBar barStyle="dark-content"/>
    <View style={{paddingHorizontal:22,paddingTop:10,paddingBottom:15,flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}>
      <View><Heading>{pageTitle}</Heading><Text style={{color:C.muted,fontSize:12,marginTop:4}}>{tab==='Chats'?'Your real conversations':tab==='You'?'Your Guftin ID':'Guftin'}</Text></View>
      <View style={{flexDirection:'row',gap:9}}>
        <Btn onPress={()=>setSettingsOpen(true)} style={{backgroundColor:C.paper,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:19,color:C.green}}>⚙</Text></Btn>
        {tab==='Chats'?<Btn onPress={()=>setSearching(!searching)} style={{backgroundColor:C.paper,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:19}}>⌕</Text></Btn>:null}
        {tab==='Chats'?<Btn onPress={()=>setAddOpen(true)} style={{backgroundColor:C.green,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:24,color:'#fff'}}>＋</Text></Btn>:null}
      </View>
    </View>
    {tab==='Chats'?<>
      {searching?<TextInput value={search} onChangeText={setSearch} placeholder="Search your conversations..." autoFocus style={{marginHorizontal:20,marginBottom:12,padding:14,backgroundColor:C.paper,borderRadius:14,color:C.ink}}/>:null}
      {loading&&chats.length===0?<View style={{flex:1,alignItems:'center',justifyContent:'center'}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:10}}>Loading your conversations…</Text></View>:
        <FlatList data={visible} keyExtractor={x=>x.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.green}/>} contentContainerStyle={{paddingHorizontal:13,paddingBottom:25,flexGrow:1}}
          ListEmptyComponent={<View style={{alignItems:'center',padding:35,marginTop:50}}><Avatar label="K" color={C.green} size={64}/><Text style={{fontSize:17,fontWeight:'900',color:C.ink,marginTop:15}}>No conversations yet</Text><Text style={{color:C.muted,textAlign:'center',marginTop:7,lineHeight:20}}>Tap ＋ and search by a person's unique username to start a real chat.</Text><Btn onPress={()=>setAddOpen(true)} style={{backgroundColor:C.green,paddingHorizontal:22,paddingVertical:13,borderRadius:14,marginTop:18}}><Text style={{color:'#fff',fontWeight:'800'}}>Find by username</Text></Btn></View>}
          renderItem={({item})=><Btn onPress={()=>openChat(item)} style={{flexDirection:'row',alignItems:'center',padding:10,gap:12,borderRadius:17}}>
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
      <Text style={{fontSize:16,fontWeight:'900',color:C.ink,marginBottom:10}}>Recent updates</Text>
      {statuses.length===0?<Text style={{color:C.muted,textAlign:'center',padding:30}}>No active statuses from your contacts yet.</Text>:statuses.map((status:any)=><View key={status.id} style={{padding:14,borderBottomWidth:1,borderColor:C.line,flexDirection:'row',gap:12}}>
        <Avatar label={initials(status.display_name)} color={colorFor(status.user_id)} size={46}/>
        <View style={{flex:1}}>
          <Text style={{fontWeight:'900',color:C.ink}}>{status.user_id===session.user.id?'You':status.display_name}{status.username?'  @'+status.username:''}</Text>
          {status.media_signed_url?(status.media_url?.toLowerCase().match(/\.(mp4|mov|m4v)$/)?<VideoBubble uri={status.media_signed_url}/>:<Image source={{uri:status.media_signed_url}} style={{width:210,height:190,borderRadius:14,marginTop:8}} resizeMode="cover"/>):null}
          {status.caption?<Text style={{color:C.ink,lineHeight:20,marginTop:5}}>{status.caption}</Text>:null}
          <Text style={{color:C.muted,fontSize:10,marginTop:5}}>{timeLabel(status.created_at)}</Text>
        </View>
      </View>)}
    </ScrollView>:null}
    {tab==='Calls'?<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:32}}><Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>Guftin calls</Text><Text style={{textAlign:'center',color:C.muted,marginTop:8,lineHeight:20}}>Open a direct chat and tap the phone or video icon to invite the other member. Both phones must be online. LiveKit server credentials are required to connect the media stream.</Text></View>:null}
    {tab==='You'?<ScrollView contentContainerStyle={{padding:22}}>
      <View style={{alignItems:'center',padding:25,backgroundColor:C.paper,borderRadius:22}}>
        <Btn onPress={chooseProfilePhoto} style={{alignItems:'center'}}><Avatar label={initials(profile?.display_name||session.user.email||'KC')} color={C.green} size={88} uri={profileAvatarUrl}/><Text style={{color:C.green,fontWeight:'800',fontSize:12,marginTop:8}}>{profileUploading?'Uploading…':'Change profile photo'}</Text></Btn>
        <Text style={{fontSize:20,fontWeight:'900',color:C.ink,marginTop:12}}>{profile?.display_name||'Your profile'}</Text>
        <Text style={{color:C.muted,fontSize:12,marginTop:4}}>{session.user.email||'Verified account'}</Text>
        <Text style={{color:C.green,fontSize:13,fontWeight:'800',marginTop:6}}>@{profile?.username}</Text>
      </View>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:25,marginBottom:8}}>Display name</Text>
      <TextInput value={profileName} onChangeText={setProfileName} placeholder="Your name" maxLength={40} style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:15,marginBottom:8}}>Username</Text>
      <TextInput value={profileUsername} onChangeText={v=>setProfileUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} placeholder="Your unique username" autoCapitalize="none" maxLength={24} style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:15,marginBottom:8}}>About</Text>
      <TextInput value={about} onChangeText={setAbout} placeholder="A little about you" maxLength={160} multiline style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink,minHeight:75,textAlignVertical:'top'}}/>
      <Btn disabled={savingProfile||profileUploading} onPress={saveProfile} style={{backgroundColor:C.green,padding:15,borderRadius:14,alignItems:'center',marginTop:10}}>{savingProfile?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Save profile</Text>}</Btn>
      <View style={{padding:15,backgroundColor:C.mint,borderRadius:14,marginTop:18}}>
        <Text style={{fontWeight:'900',color:C.green}}>🔒 Message encryption</Text>
        <Text style={{color:C.ink,fontSize:12,lineHeight:18,marginTop:6}}>{e2eeStatus==='ready'?'This device has a private key stored locally. New text messages are encrypted for each registered conversation device before upload.':'This device encryption key is not available yet. Secure text sending is paused.'}</Text>
        <Text style={{color:C.muted,fontSize:10,lineHeight:15,marginTop:6}}>This is an early encryption implementation: it has no forward secrecy or verified safety numbers, and private keys cannot be recovered after reinstalling Android. Status updates and calls are not encrypted.</Text>
      </View>
      <Btn onPress={()=>Alert.alert('Privacy','New text messages and photo/video attachments are encrypted on the sending device before upload. Public keys are not yet verified with safety numbers, forward secrecy is not implemented, and this version has not had an independent security audit. Status and calls are not end-to-end encrypted.')} style={{padding:18,borderBottomWidth:1,borderColor:C.line,marginTop:12}}><Text style={{color:C.ink,fontWeight:'700'}}>Privacy and security　›</Text></Btn>
      <Btn onPress={()=>supabase.auth.signOut()} style={{padding:18}}><Text style={{color:C.red,fontWeight:'800'}}>Sign out</Text></Btn>
    </ScrollView>:null}
    <View style={{height:69,borderTopWidth:1,borderColor:C.line,flexDirection:'row',alignItems:'center',justifyContent:'space-around',backgroundColor:C.white}}>
      {([['Chats','▤'],['Updates','◉'],['Calls','⌕'],['You','●']] as string[][]).map(([t,icon])=><Btn key={t} onPress={()=>setTab(t)} style={{alignItems:'center',minWidth:64}}><Text style={{fontSize:19,color:tab===t?C.green:C.muted}}>{icon}</Text><Text style={{fontSize:10,fontWeight:tab===t?'900':'600',color:tab===t?C.green:C.muted,marginTop:3}}>{t}</Text></Btn>)}
    </View>

    <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={()=>setSettingsOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'flex-end'}}><View style={{backgroundColor:C.white,borderTopLeftRadius:24,borderTopRightRadius:24,padding:22}}>
        <Text style={{fontSize:21,fontWeight:'900',color:C.ink}}>Guftin settings</Text>
        <Text style={{color:C.muted,fontSize:12,marginTop:5,marginBottom:15}}>Privacy and connection preferences</Text>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Show online status</Text><Text style={{color:C.muted,fontSize:11}}>Let contacts see when you are online</Text></View><Switch value={onlineVisibility} onValueChange={setOnlineVisibility} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Read receipts</Text><Text style={{color:C.muted,fontSize:11}}>Show seen status on messages</Text></View><Switch value={showReadReceipts} onValueChange={setShowReadReceipts} trackColor={{true:C.green}}/></View>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingVertical:12}}><View style={{flex:1,paddingRight:12}}><Text style={{color:C.ink,fontWeight:'800'}}>Automatic message sync</Text><Text style={{color:C.muted,fontSize:11}}>Refresh while Guftin is open</Text></View><Switch value={autoSync} onValueChange={setAutoSync} trackColor={{true:C.green}}/></View>
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
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:18}}>
            <Btn onPress={()=>setAddOpen(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={adding} onPress={addContact} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>{adding?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Find and add</Text>}</Btn>
          </View>
        </View>
      </View>
    </Modal>
  </SafeAreaView>;
}
