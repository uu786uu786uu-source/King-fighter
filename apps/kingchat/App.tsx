import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
type Message = { id:string; conversation_id:string; sender_id:string|null; body:string|null; message_type:string; created_at:string; mine:boolean };
const palette = ['#d49a91','#8796c7','#81ad98','#bd8aa8','#c4a47c','#9a91bd'];
const initials = (s:string) => s.trim().split(/\\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || 'KC';
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
  const [profileReady,setProfileReady]=useState(false);
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

  const [addOpen,setAddOpen]=useState(false);
  const [contactUsername,setContactUsername]=useState('');
  const [adding,setAdding]=useState(false);

  const [profileName,setProfileName]=useState('');
  const [profileUsername,setProfileUsername]=useState('');
  const [about,setAbout]=useState('');
  const [savingProfile,setSavingProfile]=useState(false);
  const handledAuthUrls=useRef(new Set<string>());

  const completeAuthUrl=useCallback(async(url:string)=>{
    if(!url||handledAuthUrls.current.has(url)) return;
    handledAuthUrls.current.add(url);
    const query=url.includes('?')?url.split('?')[1].split('#')[0]:'';
    const fragment=url.split('#')[1]||'';
    const read=(source:string,key:string)=>{
      const match=source.match(new RegExp('(?:^|&)'+key+'=([^&]+)'));
      return match?decodeURIComponent(match[1].replace(/\\+/g,' ')):'';
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
    setProfileReady(true);
  },[session]);

  const loadInbox=useCallback(async()=>{
    if(!session) return;
    setLoading(true);
    try{
      const {data:memberships,error}=await supabase.from('kc_conversation_members')
        .select('conversation_id,joined_at,conversation:kc_conversations!inner(id,kind,title,updated_at)')
        .eq('user_id',session.user.id);
      if(error) throw error;
      const rows=(memberships||[]) as any[];
      const ids=rows.map(r=>r.conversation_id).filter(Boolean);
      if(ids.length===0){setChats([]);return;}
      const [memberResult,profileResult,messageResult]=await Promise.all([
        supabase.from('kc_conversation_members').select('conversation_id,user_id').in('conversation_id',ids),
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
      const mapped:Chat[]=rows.map(row=>{
        const conv=row.conversation||{};
        const peers=members.filter(m=>m.conversation_id===row.conversation_id&&m.user_id!==session.user.id);
        const peer=peers.length?profileMap.get(peers[0].user_id):null;
        const name=conv.kind==='group'?(conv.title||'Group chat'):(peer?.display_name||'King Chat member');
        const last=latest.get(row.conversation_id);
        const preview=last?(last.message_type==='image'?'Photo':last.message_type==='video'?'Video':last.message_type==='audio'?'Voice message':(last.body||'Attachment')):'No messages yet';
        return {id:row.conversation_id,name,avatar:initials(name),color:colorFor(name),last:preview,
          time:last?timeLabel(last.created_at):'',unread:0,online:!!peer?.is_online,kind:conv.kind||'direct',
          lastAt:last?new Date(last.created_at).getTime():new Date(conv.updated_at||row.joined_at).getTime()};
      }).sort((a,b)=>b.lastAt-a.lastAt);
      setChats(mapped);
    }catch(e:any){
      Alert.alert('Inbox could not load',e?.message||'Please check your connection and try again.');
    }finally{setLoading(false);}
  },[session]);

  useEffect(()=>{
    if(!session){
      setLoading(false);setChats([]);setProfile(null);setProfileReady(false);setActive(null);return;
    }
    setProfileReady(false);
    void loadProfile();
    void loadInbox();
    void supabase.from('kc_profiles').update({is_online:true,last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    const appState=AppState.addEventListener('change',(state)=>{
      void supabase.from('kc_profiles').update({is_online:state==='active',last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    });
    const channel=supabase.channel('kingchat-user-'+session.user.id)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'kc_messages'},payload=>{
        const m=payload.new as any;
        const item:Message={...m,mine:m.sender_id===session.user.id};
        setMessages(prev=>{
          const old=prev[m.conversation_id]||[];
          return {...prev,[m.conversation_id]:old.some(x=>x.id===m.id)?old:[...old,item]};
        });
        void loadInbox();
      }).subscribe();
    return ()=>{
      appState.remove();
      void supabase.removeChannel(channel);
      void supabase.from('kc_profiles').update({is_online:false,last_seen_at:new Date().toISOString()}).eq('id',session.user.id);
    };
  },[session,loadProfile,loadInbox]);

  const loadMessages=useCallback(async(conversationId:string)=>{
    if(!session) return;
    const {data,error}=await supabase.from('kc_messages')
      .select('id,conversation_id,sender_id,body,message_type,created_at')
      .eq('conversation_id',conversationId).is('deleted_at',null)
      .order('created_at',{ascending:true}).limit(200);
    if(error){Alert.alert('Messages could not load',error.message);return;}
    setMessages(prev=>({...prev,[conversationId]:(data||[]).map((m:any)=>({...m,mine:m.sender_id===session.user.id}))}));
  },[session]);

  const refresh=async()=>{
    setRefreshing(true);
    await Promise.all([loadInbox(),loadProfile()]);
    setRefreshing(false);
  };

  const openChat=async(chat:Chat)=>{
    setActive(chat);
    await loadMessages(chat.id);
  };

  const sendMessage=async()=>{
    const body=draft.trim();
    if(!body||!active||!session||sending) return;
    setSending(true);
    const conversationId=active.id;
    const {data,error}=await supabase.from('kc_messages').insert({
      conversation_id:conversationId,sender_id:session.user.id,body,message_type:'text'
    }).select('id,conversation_id,sender_id,body,message_type,created_at').single();
    setSending(false);
    if(error){Alert.alert('Message not sent',error.message);return;}
    setDraft('');
    const item:Message={...data,mine:true};
    setMessages(prev=>{
      const old=prev[conversationId]||[];
      return {...prev,[conversationId]:old.some(x=>x.id===item.id)?old:[...old,item]};
    });
    void loadInbox();
  };

  const signUpEmail=async()=>{
    const cleanEmail=email.trim().toLowerCase();
    const cleanUsername=username.trim().toLowerCase().replace(/^@/,'');
    const cleanName=fullName.trim();
    if(cleanName.length<2||cleanName.length>40){setAuthError('Enter your display name (2-40 characters).');return;}
    if(!/^[a-z0-9_]{3,24}$/.test(cleanUsername)){setAuthError('Username must be 3-24 characters using letters, numbers or underscore.');return;}
    if(!/^\\S+@\\S+\\.\\S+$/.test(cleanEmail)){setAuthError('Enter a valid email address.');return;}
    if(password.length<8){setAuthError('Password must be at least 8 characters.');return;}
    setAuthBusy(true);setAuthError('');
    const {data,error}=await supabase.auth.signUp({
      email:cleanEmail,password,
      options:{emailRedirectTo:Linking.createURL('auth/callback'),data:{display_name:cleanName,username:cleanUsername}}
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
      const redirectTo=Linking.createURL('auth/callback');
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
    if(!row?.conversation_id){Alert.alert('Contact not found','No King Chat account uses this username yet.');return;}
    setAddOpen(false);setContactUsername('');
    const name=row.display_name||row.username||'King Chat member';
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
    Alert.alert('Saved','Your King Chat profile has been updated.');
  };

  const visible=useMemo(()=>chats.filter(c=>c.name.toLowerCase().includes(search.toLowerCase())),[chats,search]);
  const pageTitle=tab==='Chats'?'Messages':tab==='Updates'?'Updates':tab==='Calls'?'Calls':'You';

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
        <Text style={{color:C.muted,fontSize:10,textAlign:'center',marginTop:8,lineHeight:16}}>Your username is your King Chat ID. Other members can search it to add you. Email confirmation may be required.</Text>
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
        <Btn onPress={()=>Alert.alert('Voice calls','Live calling is not enabled in this version yet.')} style={{padding:9}}><Text style={{fontSize:20}}>☎</Text></Btn>
        <Btn onPress={()=>Alert.alert('Video calls','Video calling requires a WebRTC calling service and signaling infrastructure.')} style={{padding:9}}><Text style={{fontSize:20}}>▣</Text></Btn>
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
      <View><Heading>{pageTitle}</Heading><Text style={{color:C.muted,fontSize:12,marginTop:4}}>{tab==='Chats'?'Your real conversations':tab==='You'?'Your King Chat ID':'King Chat'}</Text></View>
      <View style={{flexDirection:'row',gap:9}}>
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
            <Avatar label={item.avatar} color={item.color} online={item.online}/>
            <View style={{flex:1,borderBottomWidth:1,borderColor:C.line,paddingBottom:14,paddingTop:2}}>
              <View style={{flexDirection:'row',justifyContent:'space-between'}}><Text style={{fontWeight:'800',color:C.ink,fontSize:14}}>{item.name}</Text><Text style={{fontSize:10,color:C.muted}}>{item.time}</Text></View>
              <Text numberOfLines={1} style={{fontSize:12,color:C.muted,marginTop:6}}>{item.last}</Text>
            </View>
          </Btn>}/>
      }
    </>:null}
    {tab==='Updates'?<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:32}}><Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>No updates yet</Text><Text style={{textAlign:'center',color:C.muted,marginTop:8,lineHeight:20}}>Status publishing and media uploads are not enabled in this release.</Text></View>:null}
    {tab==='Calls'?<View style={{flex:1,alignItems:'center',justifyContent:'center',padding:32}}><Text style={{fontSize:18,fontWeight:'900',color:C.ink}}>Calling is not enabled yet</Text><Text style={{textAlign:'center',color:C.muted,marginTop:8,lineHeight:20}}>Voice and video calls need a WebRTC calling service, signaling and TURN servers.</Text></View>:null}
    {tab==='You'?<ScrollView contentContainerStyle={{padding:22}}>
      <View style={{alignItems:'center',padding:25,backgroundColor:C.paper,borderRadius:22}}>
        <Avatar label={initials(profile?.display_name||session.user.email||'KC')} color={C.green} size={76}/>
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
      <Btn disabled={savingProfile} onPress={saveProfile} style={{backgroundColor:C.green,padding:15,borderRadius:14,alignItems:'center',marginTop:10}}>{savingProfile?<ActivityIndicator color="#fff"/>:<Text style={{color:'#fff',fontWeight:'800'}}>Save profile</Text>}</Btn>
      <Btn onPress={()=>Alert.alert('Privacy','Your profile exposes your username and display name to people you chat with. Email addresses are not displayed in public contact search. End-to-end encryption is not implemented in this release.')} style={{padding:18,borderBottomWidth:1,borderColor:C.line,marginTop:12}}><Text style={{color:C.ink,fontWeight:'700'}}>Privacy and security　›</Text></Btn>
      <Btn onPress={()=>supabase.auth.signOut()} style={{padding:18}}><Text style={{color:C.red,fontWeight:'800'}}>Sign out</Text></Btn>
    </ScrollView>:null}
    <View style={{height:69,borderTopWidth:1,borderColor:C.line,flexDirection:'row',alignItems:'center',justifyContent:'space-around',backgroundColor:C.white}}>
      {([['Chats','▤'],['Updates','◉'],['Calls','⌕'],['You','●']] as string[][]).map(([t,icon])=><Btn key={t} onPress={()=>setTab(t)} style={{alignItems:'center',minWidth:64}}><Text style={{fontSize:19,color:tab===t?C.green:C.muted}}>{icon}</Text><Text style={{fontSize:10,fontWeight:tab===t?'900':'600',color:tab===t?C.green:C.muted,marginTop:3}}>{t}</Text></Btn>)}
    </View>

    <Modal visible={addOpen} transparent animationType="fade" onRequestClose={()=>setAddOpen(false)}>
      <View style={{flex:1,backgroundColor:'#0008',justifyContent:'center',padding:22}}>
        <View style={{backgroundColor:C.white,borderRadius:22,padding:22}}>
          <Text style={{fontSize:20,fontWeight:'900',color:C.ink}}>Find a King Chat user</Text>
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
