import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Supabase publishable key is designed for use in client apps; protect data with RLS.
const url=process.env.EXPO_PUBLIC_SUPABASE_URL||'https://oyjemlbsmffvofefgxvd.supabase.co';
const key=process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY||'sb_publishable_cJwVyQs551sviwX7hPzDHQ_mhla0wDr';
export const isBackendConfigured=Boolean(url&&key);
export const supabase=createClient(url,key,{auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
