import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!url || !serviceKey || !jwt) return json({ error: "Push service is not configured." }, 503);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(jwt);
  const actor = authData?.user;
  if (authError || !actor) return json({ error: "A valid signed-in session is required." }, 401);

  let body: { kind?: string; message_id?: string; call_id?: string; status_id?: string };
  try { body = await req.json(); } catch { return json({ error: "A JSON body is required." }, 400); }

  let recipientIds: string[] = [];
  let title = "Guftin";
  let message = "You have a new update.";
  let data: Record<string, unknown> = {};

  if (body.kind === "message" && body.message_id) {
    const { data: row, error } = await admin.from("kc_messages")
      .select("id,conversation_id,sender_id,message_type")
      .eq("id", body.message_id).maybeSingle();
    if (error || !row || row.sender_id !== actor.id) return json({ error: "Message not found or not owned by this account." }, 404);
    const { data: memberships } = await admin.from("kc_conversation_members")
      .select("user_id").eq("conversation_id", row.conversation_id).neq("user_id", actor.id);
    recipientIds = (memberships || []).map((item: any) => item.user_id);
    title = "New Guftin message";
    message = row.message_type === "image" ? "You received a photo." :
      row.message_type === "video" ? "You received a video." :
      row.message_type === "audio" ? "You received a voice message." : "You received a new message.";
    data = { type: "message", conversation_id: row.conversation_id };
  } else if (body.kind === "call" && body.call_id) {
    const { data: row, error } = await admin.from("kc_call_logs")
      .select("id,conversation_id,caller_id,callee_id,call_type,status")
      .eq("id", body.call_id).maybeSingle();
    if (error || !row || row.caller_id !== actor.id || row.status !== "ringing") return json({ error: "Call not found or not owned by this account." }, 404);
    recipientIds = [row.callee_id].filter(Boolean);
    title = row.call_type === "video" ? "Incoming Guftin video call" : "Incoming Guftin voice call";
    message = "A Guftin contact is calling you.";
    data = { type: "incoming_call", call_id: row.id, conversation_id: row.conversation_id, call_type: row.call_type };
  } else if (body.kind === "status" && body.status_id) {
    const { data: row, error } = await admin.from("kc_status_updates")
      .select("id,user_id,expires_at")
      .eq("id", body.status_id).maybeSingle();
    if (error || !row || row.user_id !== actor.id || new Date(row.expires_at).getTime() <= Date.now()) {
      return json({ error: "Active status not found or not owned by this account." }, 404);
    }
    const { data: contacts, error: contactsError } = await admin.from("kc_contacts")
      .select("owner_id,contact_id")
      .or("owner_id.eq." + actor.id + ",contact_id.eq." + actor.id);
    if (contactsError) return json({ error: "Could not load status contacts." }, 500);
    recipientIds = [...new Set((contacts || []).map((item: any) =>
      item.owner_id === actor.id ? item.contact_id : item.owner_id
    ).filter((id: string) => id && id !== actor.id))];
    const { data: profile } = await admin.from("kc_profiles")
      .select("display_name").eq("id", actor.id).maybeSingle();
    title = (profile?.display_name || "A Guftin contact") + " shared a status";
    message = "Tap to view the new status. It expires after 24 hours.";
    data = { type: "status", status_id: row.id };
  } else {
    return json({ error: "kind and a valid message_id, call_id, or status_id are required." }, 400);
  }

  if (!recipientIds.length) return json({ sent: 0, reason: "No recipient devices." });
  const { data: devices, error: tokenError } = await admin.from("kc_device_tokens")
    .select("token").in("user_id", recipientIds);
  if (tokenError) return json({ error: "Could not load recipient devices." }, 500);

  const tokens = [...new Set((devices || []).map((item: any) => item.token)
    .filter((token: string) => typeof token === "string" && token.startsWith("ExponentPushToken[")))];
  if (!tokens.length) return json({ sent: 0, reason: "Recipients have not enabled push notifications on this build." });

  const notifications = tokens.map((to) => ({
    to, title, body: message, sound: "default", priority: "high",
    channelId: "messages", data,
  }));
  let sent = 0;
  for (let offset = 0; offset < notifications.length; offset += 100) {
    const batch = notifications.slice(offset, offset + 100);
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(batch),
    });
    if (!response.ok) continue;
    const result = await response.json();
    sent += (result.data || []).filter((ticket: any) => ticket.status === "ok").length;
  }
  return json({ sent, attempted: tokens.length });
});
