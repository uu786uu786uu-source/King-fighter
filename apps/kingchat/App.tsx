import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, FlatList, KeyboardAvoidingView, Modal,
  Platform, RefreshControl, SafeAreaView, ScrollView, StatusBar, Text,
  TextInput, TouchableOpacity, View
} from 'react-native';
import { supabase } from './src/lib/supabase';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const C = { ink:'#102b27', muted:'#82938e', green:'#087e6c', mint:'#e5f5ee', paper:'#f5f8f6', white:'#fff', line:'#e9efec', red:'#b94e48' };
type Chat = { id:string; name:string; avatar:string; color:string; last:string; time:string; unread:number; online:boolean; kind:string; lastAt:number };
type Message = { id:string; conversation_id:string; sender_id:string|null; body:string; message_type:string; created_at:string; mine:boolean };
const palette = ['#d49a91','#8796c7','#81ad98','#bd8aa8','#c4a47c','#9a91bd'];
const initials = (s:string) => s.trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || 'KC';
const colorFor = (s:string) => { let n=0; for(let i=0;i<s.length;i++) n=(n*31+s.charCodeAt(i))>>>0; return palette[n%palette.length]; };
const phoneE164 = (raw:string) => {
  const v=raw.trim().replace(/[^\d+]/g,'');
  if(v.startsWith('+')) return v;
  if(v.startsWith('00')) return '+'+v.slice(2);
  if(v.startsWith('92')) return '+'+v;
  if(v.startsWith('0')) return '+92'+v.slice(1);
  return '+92'+v;
};
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
function Avatar({label,color,size=52,online=false}:any) {
  return <View style={{width:size,height:size,borderRadius:size*.34,backgroundColor:color,alignItems:'center',justifyContent:'center'}}>
    <Text style={{color:'#fff',fontWeight:'900',fontSize:size*.25}}>{label}</Text>
    {online?<View style={{position:'absolute',right:-1,bottom:-1,width:13,height:13,borderRadius:8,backgroundColor:'#29b77e',borderWidth:2,borderColor:C.white}}/>:null}
  </View>;
}
function Heading({children}:any) { return <Text style={{fontSize:25,fontWeight:'900',color:C.ink,letterSpacing:-.6}}>{children}</Text>; }

export default function App() {
  const [tab,setTab]=useState('Chats');
  const [session,setSession]=useState<any>(null);
  const [profile,setProfile]=useState<any>(null);
  const [chats,setChats]=useState<Chat[]>([]);
  const [active,setActive]=useState<Chat|null>(null);
  const [messages,setMessages]=useState<Record<string,Message[]>>({});
  const [draft,setDraft]=useState('');
  const [search,setSearch]=useState('');
  const [searching,setSearching]=useState(false);
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [sending,setSending]=useState(false);
  const [authBusy,setAuthBusy]=useState(false);
  const [authMode,setAuthMode]=useState<'login'|'signup'>('signup');
  const [fullName,setFullName]=useState('');
  const [username,setUsername]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [authError,setAuthError]=useState('');
  const [profileReady,setProfileReady]=useState(false);
  const [addOpen,setAddOpen]=useState(false);
  const [contactUsername,setContactUsername]=useState('');
  const [adding,setAdding]=useState(false);
  const [profileName,setProfileName]=useState('');
  const [profileUsername,setProfileUsername]=useState('');
  const [about,setAbout]=useState('');
  const [savingProfile,setSavingProfile]=useState(false);

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));
    return ()=>subscription.unsubscribe();
  },[]);

  const loadProfile=useCallback(async()=>{
    if(!session) return;
    const {data,error}=await supabase.from('kc_profiles').select('id,display_name,username,email,about,avatar_url,is_online').eq('id',session.user.id).maybeSingle();
    if(error){console.warn('Profile load:',error.message);setProfileReady(true);return;}
    setProfile(data);
    setProfileName(data?.display_name||session.user.user_metadata?.display_name||'');
    setProfileUsername(data?.username||session.user.user_metadata?.username||'');
    setAbout(data?.about||'');
    setProfileReady(true);
  },[session]);

  const loadInbox=useCallback(async()=>{
    if(!session) return;
    setLoading(true);
    try {
      const {data:memberships,error}=await supabase.from('kc_conversation_members')
        .select('conversation_id,joined_at,conversation:kc_conversations!inner(id,kind,title,updated_at)')
        .eq('user_id',session.user.id);
      if(error) throw error;
      const rows=(memberships||[]) as any[];
      const ids=rows.map(r=>r.conversation_id).filter(Boolean);
      if(ids.length===0){setChats([]);setLoading(false);return;}
      const [memberResult,profileResult,messageResult]=await Promise.all([
        supabase.from('kc_conversation_members').select('conversation_id,user_id').in('conversation_id',ids),
        supabase.from('kc_profiles').select('id,display_name,avatar_url,is_online').neq('id',session.user.id),
        supabase.from('kc_messages').select('id,conversation_id,sender_id,body,message_type,created_at').in('conversation_id',ids).is('deleted_at',null).order('created_at',{ascending:false}).limit(500)
      ]);
      if(memberResult.error) throw memberResult.error;
      if(messageResult.error) throw messageResult.error;
      const allMemberRows=(memberResult.data||[]) as any[];
      const peerIds=[...new Set(allMemberRows.filter(m=>m.user_id!==session.user.id).map(m=>m.user_id))];
      const profiles=(profileResult.error?[]:(profileResult.data||[])) as any[];
      const profileMap=new Map(profiles.filter(p=>peerIds.includes(p.id)).map(p=>[p.id,p]));
      const latest=new Map<string,any>();
      for(const m of (messageResult.data||[]) as any[]) if(!latest.has(m.conversation_id)) latest.set(m.conversation_id,m);
      const mapped:Chat[]=rows.map(row=>{
        const conv=row.conversation||{};
        const peers=allMemberRows.filter(m=>m.conversation_id===row.conversation_id&&m.user_id!==session.user.id);
        const peer=peers.length?profileMap.get(peers[0].user_id):null;
        const name=conv.kind==='group'?(conv.title||'Group chat'):(peer?.display_name||'King Chat member');
        const last=latest.get(row.conversation_id);
        const preview=last?(last.message_type==='image'?'Photo':last.message_type==='video'?'Video':last.message_type==='audio'?'Voice message':(last.body||'Attachment')):'No messages yet';
        return {id:row.conversation_id,name,avatar:initials(name),color:colorFor(name),last:preview,time:last?timeLabel(last.created_at):'',unread:0,online:!!peer?.is_online,kind:conv.kind||'direct',lastAt:last?new Date(last.created_at).getTime():new Date(conv.updated_at||row.joined_at).getTime()};
      }).sort((a,b)=>b.lastAt-a.lastAt);
      setChats(mapped);
    } catch(e:any) {
      Alert.alert('Inbox could not load',e?.message||'Please check your connection and try again.');
    } finally { setLoading(false); }
  },[session]);

  useEffect(()=>{
    if(!session){
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper,padding:25,justifyContent:'center'}}>
      <StatusBar barStyle="dark-content"/>
      <ScrollView contentContainerStyle={{flexGrow:1,justifyContent:'center'}}>
        <View style={{alignItems:'center',marginBottom:34}}>
          <Avatar label="K" color={C.green} size={78}/>
          <Heading>King Chat</Heading>
          <Text style={{color:C.muted,marginTop:8}}>Your world. Your people. One place.</Text>
        </View>
        <Text style={{fontSize:23,fontWeight:'900',color:C.ink,marginBottom:8}}>{authMode==='signup'?'Create your King Chat ID':'Welcome back'}</Text>
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
          <Text style={{color:C.green,fontWeight:'800'}}>{authMode==='signup'?'Already have an account? Sign in':'New to King Chat? Create account'}</Text>
        </Btn>
        <Text style={{color:C.muted,fontSize:10,textAlign:'center',marginTop:8,lineHeight:16}}>A unique username lets other King Chat members find and add you. Email verification may be required before first sign-in.</Text>
      </ScrollView>
    </SafeAreaView>;
  }

  if(!profileReady){
    return <SafeAreaView style={{flex:1,alignItems:'center',justifyContent:'center',backgroundColor:C.paper}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:10}}>Loading your account…</Text></SafeAreaView>;
  }

  if(!profile?.username){
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper,padding:24,justifyContent:'center'}}>
      <StatusBar barStyle="dark-content"/>
      <View style={{alignItems:'center',marginBottom:28}}><Avatar label="K" color={C.green} size={70}/><Heading>Set your King Chat ID</Heading></View>
      <Text style={{fontSize:22,fontWeight:'900',color:C.ink,marginBottom:8}}>Complete your profile</Text>
      <Text style={{color:C.muted,lineHeight:20,marginBottom:18}}>Choose a username that people can search to find and add you.</Text>
      <TextInput value={profileName} onChangeText={setProfileName} placeholder="Your display name" autoCapitalize="words" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
      <TextInput value={profileUsername} onChangeText={v=>setProfileUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} placeholder="Username (3-24 characters)" autoCapitalize="none" style={{backgroundColor:C.white,borderRadius:15,padding:16,marginBottom:10,color:C.ink}}/>
      <Text style={{fontSize:11,color:C.muted,marginBottom:14}}>Allowed: lowercase letters, numbers and underscore.</Text>
      <Btn disabled={savingProfile} onPress={finishProfile} style={{backgroundColor:C.green,padding:17,borderRadius:16,alignItems:'center'}}>{savingProfile?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'900'}}>Save and continue</Text>}</Btn>
      <Btn onPress={()=>supabase.auth.signOut()} style={{padding:15,alignItems:'center'}}><Text style={{color:C.red,fontWeight:'700'}}>Sign out</Text></Btn>
    </SafeAreaView>;
  }

  if(active){
    const list=messages[active.id]||[];
    return <SafeAreaView style={{flex:1,backgroundColor:C.paper}}>
      <StatusBar barStyle="dark-content"/>
      <View style={{height:72,backgroundColor:C.white,flexDirection:'row',alignItems:'center',paddingHorizontal:15,borderBottomWidth:1,borderColor:C.line}}>
        <Btn onPress={()=>setActive(null)} style={{padding:10}}><Text style={{fontSize:24,color:C.ink}}>‹</Text></Btn>
        <Avatar label={active.avatar} color={active.color} size={43} online={active.online}/>
        <View style={{flex:1,marginLeft:11}}>
          <Text style={{fontWeight:'900',fontSize:15,color:C.ink}}>{active.name}</Text>
          <Text style={{fontSize:11,color:active.online?C.green:C.muted}}>{active.online?'● online':'King Chat'}</Text>
        </View>
        <Btn onPress={()=>Alert.alert('Voice calls','Live calling is not enabled yet. A calling/signaling service is still required.')} style={{padding:9}}><Text style={{fontSize:20}}>☎</Text></Btn>
        <Btn onPress={()=>Alert.alert('Video calls','Video calling needs WebRTC, signaling and TURN infrastructure.')} style={{padding:9}}><Text style={{fontSize:20}}>▣</Text></Btn>
      </View>
      <FlatList data={list} keyExtractor={m=>m.id} contentContainerStyle={{padding:18,gap:12,flexGrow:1,justifyContent:list.length?'flex-end':'center'}}
        ListEmptyComponent={<Text style={{textAlign:'center',color:C.muted}}>No messages yet. Send the first message.</Text>}
        renderItem={({item})=><View style={{alignSelf:item.mine?'flex-end':'flex-start',maxWidth:'84%',backgroundColor:item.mine?'#dff4e8':C.white,padding:13,borderRadius:17,borderTopRightRadius:item.mine?5:17,borderTopLeftRadius:item.mine?17:5}}>
          <Text style={{color:C.ink,fontSize:14,lineHeight:21}}>{item.body||'Attachment'}</Text>
          <Text style={{textAlign:'right',fontSize:9,color:C.muted,marginTop:5}}>{timeLabel(item.created_at)}</Text>
        </View>}/>
      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined}>
        <View style={{flexDirection:'row',alignItems:'center',padding:11,gap:8,backgroundColor:C.white}}>
          <TextInput value={draft} onChangeText={setDraft} placeholder="Write a message..." multiline maxLength={4000} style={{flex:1,maxHeight:110,backgroundColor:C.paper,borderRadius:16,paddingHorizontal:15,paddingVertical:12,color:C.ink}}/>
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
      <View><Heading>{title}</Heading><Text style={{color:C.muted,fontSize:12,marginTop:4}}>{tab==='Chats'?'Your real conversations':tab==='You'?'Account and profile':'King Chat'}</Text></View>
      <View style={{flexDirection:'row',gap:9}}>
        {tab==='Chats'?<Btn onPress={()=>setSearching(!searching)} style={{backgroundColor:C.paper,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:19}}>⌕</Text></Btn>:null}
        {tab==='Chats'?<Btn onPress={()=>setAddOpen(true)} style={{backgroundColor:C.green,width:42,height:42,borderRadius:15,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:24,color:'#fff'}}>＋</Text></Btn>:null}
      </View>
    </View>
    {tab==='Chats'?<>
      {searching?<TextInput value={search} onChangeText={setSearch} placeholder="Search your conversations..." autoFocus style={{marginHorizontal:20,marginBottom:12,padding:14,backgroundColor:C.paper,borderRadius:14,color:C.ink}}/>:null}
      {loading&&chats.length===0?<View style={{flex:1,alignItems:'center',justifyContent:'center'}}><ActivityIndicator color={C.green}/><Text style={{color:C.muted,marginTop:10}}>Loading your conversations…</Text></View>:
        <FlatList data={visible} keyExtractor={x=>x.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.green}/>} contentContainerStyle={{paddingHorizontal:13,paddingBottom:25,flexGrow:1}}
          ListEmptyComponent={<View style={{alignItems:'center',padding:35,marginTop:50}}><Avatar label="K" color={C.green} size={64}/><Text style={{fontSize:17,fontWeight:'900',color:C.ink,marginTop:15}}>No conversations yet</Text><Text style={{color:C.muted,textAlign:'center',marginTop:7,lineHeight:20}}>Tap ＋ to add someone by their registered phone number and start a real chat.</Text><Btn onPress={()=>setAddOpen(true)} style={{backgroundColor:C.green,paddingHorizontal:22,paddingVertical:13,borderRadius:14,marginTop:18}}><Text style={{color:'#fff',fontWeight:'800'}}>Add a contact</Text></Btn></View>}
          renderItem={({item})=><Btn onPress={()=>openChat(item)} style={{flexDirection:'row',alignItems:'center',padding:10,gap:12,borderRadius:17}}>
            <Avatar label={item.avatar} color={item.color} online={item.online}/>
            <View style={{flex:1,borderBottomWidth:1,borderColor:C.line,paddingBottom:14,paddingTop:2}}>
              <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{fontWeight:'800',color:C.ink,fontSize:14}}>{item.name}</Text><Text style={{fontSize:10,color:C.muted}}>{item.time}</Text></View>
              <Text numberOfLines={1} style={{fontSize:12,color:C.muted,marginTop:6}}>{item.last}</Text>
            </View>
          </Btn>}/>
      }
    </>:null}
    {tab==='Updates'?<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:32}}><Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>No updates yet</Text><Text style={{textAlign:'center',color:C.muted,marginTop:8,lineHeight:20}}>Status publishing and media uploads are not enabled in this release.</Text></View>:null}
    {tab==='Calls'?<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:32}}><Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>Calling is not enabled yet</Text><Text style={{textAlign:'center',color:C.muted,marginTop:8,lineHeight:20}}>Voice and video calls need a WebRTC calling service, signaling and TURN servers. The call buttons are not simulated.</Text></View>:null}
    {tab==='You'?<ScrollView contentContainerStyle={{padding:22}}>
      <View style={{alignItems:'center',padding:25,backgroundColor:C.paper,borderRadius:22}}>
        <Avatar label={initials(profile?.display_name||session.user.phone||'KC')} color={C.green} size={76}/>
        <Text style={{fontSize:20,fontWeight:'900',color:C.ink,marginTop:12}}>{profile?.display_name||'Your profile'}</Text>
        <Text style={{color:C.muted,fontSize:12,marginTop:4}}>{profile?.email||session.user.email||'Verified account'}</Text>
        <Text style={{color:C.green,fontSize:13,fontWeight:'800',marginTop:6}}>@{profile?.username}</Text>
      </View>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:25,marginBottom:8}}>Display name</Text>
      <TextInput value={profileName} onChangeText={setProfileName} placeholder="Your name" maxLength={40} style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:15,marginBottom:8}}>Username</Text>
      <TextInput value={profileUsername} onChangeText={v=>setProfileUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} placeholder="Your unique username" autoCapitalize="none" maxLength={24} style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
      <Text style={{fontWeight:'800',color:C.ink,marginTop:15,marginBottom:8}}>About</Text>
      <TextInput value={about} onChangeText={setAbout} placeholder="A little about you" maxLength={160} multiline style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink,minHeight:75,textAlignVertical:'top'}}/>
      <Btn disabled={savingProfile} onPress={saveProfile} style={{backgroundColor:C.green,padding:15,borderRadius:14,alignItems:'center',marginTop:10}}>{savingProfile?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Save profile</Text>}</Btn>
      <Btn onPress={()=>Alert.alert('Privacy','Your chats are protected by database access rules. End-to-end encryption is not implemented in this release.')} style={{padding:18,borderBottomWidth:1,borderColor:C.line,marginTop:12}}><Text style={{color:C.ink,fontWeight:'700'}}>Privacy and security　›</Text></Btn>
      <Btn onPress={()=>supabase.auth.signOut()} style={{padding:18}}><Text style={{color:C.red,fontWeight:'800'}}>Sign out</Text></Btn>
    </ScrollView>:null}
    <View style={{height:69,borderTopWidth:1,borderColor:C.line,flexDirection:'row',alignItems:'center',justifyContent:'space-around',backgroundColor:C.white}}>
      {([['Chats','▤'],['Updates','◉'],['Calls','⌕'],['You','●']] as string[][]).map(([t,icon])=><Btn key={t} onPress={()=>setTab(t)} style={{alignItems:'center',minWidth:64}}><Text style={{fontSize:19,color:tab===t?C.green:C.muted}}>{icon}</Text><Text style={{fontSize:10,fontWeight:tab===t?'900':'600',color:tab===t?C.green:C.muted,marginTop:3}}>{t}</Text></Btn>)}
    </View>

    <Modal visible={addOpen} transparent animationType="fade" onRequestClose={()=>setAddOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:22}}>
        <View style={{backgroundColor:C.white,borderRadius:22,padding:22}}>
          <Text style={{fontSize:20,fontWeight:'900',color:C.ink}}>Add a King Chat contact</Text>
          <Text style={{color:C.muted,lineHeight:19,marginTop:7,marginBottom:16}}>Enter a King Chat username to find and save that person. Example: ali_786</Text>
          <TextInput value={contactUsername} onChangeText={v=>setContactUsername(v.toLowerCase().replace(/[^a-z0-9_]/g,''))} autoCapitalize="none" placeholder="Username (without @)" style={{backgroundColor:C.paper,borderRadius:14,padding:15,color:C.ink}}/>
          <View style={{flexDirection:'row',justifyContent:'flex-end',gap:10,marginTop:18}}>
            <Btn onPress={()=>setAddOpen(false)} style={{padding:13}}><Text style={{color:C.muted,fontWeight:'700'}}>Cancel</Text></Btn>
            <Btn disabled={adding} onPress={addContact} style={{backgroundColor:C.green,paddingHorizontal:18,paddingVertical:13,borderRadius:13}}>{adding?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Find contact</Text>}</Btn>
          </View>
        </View>
      </View>
    </Modal>
  </SafeAreaView>;
}
