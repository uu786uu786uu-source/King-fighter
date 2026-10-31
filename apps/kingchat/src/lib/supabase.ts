import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
const url=process.env.EXPO_PUBLIC_SUPABASE_URL||''; const key=process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY||'';
export const isBackendConfigured=Boolean(url&&key);
export const supabase=createClient(url||'https://example.supabase.co',key||'public-anon-key',{auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
