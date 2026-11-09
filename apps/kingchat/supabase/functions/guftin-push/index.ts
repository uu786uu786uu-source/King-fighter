import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

type PushBody = {
  kind?: "test" | "message" | "call" | "status" | "status_like" | "status_view";
  message_id?: string;
  call_id?: string;
  status_id?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!url || !serviceKey || !jwt) return json({ error: "Push service is not configured." }, 503);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(jwt);
  const actor = authData?.user;
  if (authError || !actor) return json({ error: "A valid signed-in session is required." }, 401);

  let body: PushBody;
  try { body = await req.json(); } catch { return json({ error: "A JSON body is required." }, 400); }

  const { data: actorProfile } = await admin.from("kc_profiles")
    .select("display_name").eq("id", actor.id).maybeSingle();
  const actorName = actorProfile?.display_name || "A Guftin contact";

  let recipientIds: string[] = [];
  let title = "Guftin";
  let message = "You have a new update.";
  let data: Record<string, unknown> = {};
  let channelId = "messages";
  let categoryId: string | undefined;
  let ttl = 60 * 60 * 24;

  if (body.kind === "test") {
    recipientIds = [actor.id];
    title = "Guftin notification test";
    message = "Push notifications are connected to this phone.";
    data = { type: "test" };
    ttl = 60;
  } else if (body.kind === "message" && body.message_id) {
    const { data: row, error } = await admin.from("kc_messages")
      .select("id,conversation_id,sender_id,message_type,deleted_at")
      .eq("id", body.message_id).maybeSingle();
    if (error || !row || row.sender_id !== actor.id || row.deleted_at) {
      return json({ error: "Message not found or not owned by this account." }, 404);
    }
    const { data: memberships, error: membershipError } = await admin.from("kc_conversation_members")
      .select("user_id").eq("conversation_id", row.conversation_id).neq("user_id", actor.id);
    if (membershipError) return json({ error: "Could not load conversation recipients." }, 500);
    recipientIds = (memberships || []).map((item: any) => item.user_id).filter(Boolean);
    title = actorName;
    message = row.message_type === "image" ? "sent you a photo." :
      row.message_type === "video" ? "sent you a video." :
      row.message_type === "audio" ? "sent you a voice message." :
      row.message_type === "file" ? "sent you an attachment." :
      "sent you a message.";
    data = { type: "message", conversation_id: row.conversation_id, message_id: row.id };
  } else if (body.kind === "call" && body.call_id) {
    const { data: row, error } = await admin.from("kc_call_logs")
      .select("id,conversation_id,caller_id,callee_id,call_type,status")
      .eq("id", body.call_id).maybeSingle();
    if (error || !row || row.caller_id !== actor.id || row.status !== "ringing") {
      return json({ error: "Call not found or not owned by this account." }, 404);
    }
    recipientIds = [row.callee_id].filter(Boolean);
    title = row.call_type === "video" ? "Incoming video call" : "Incoming voice call";
    message = actorName + " is calling you. Tap Accept to answer.";
    data = {
      type: "incoming_call",
      call_id: row.id,
      conversation_id: row.conversation_id,
      call_type: row.call_type,
      caller_name: actorName,
    };
    channelId = "calls";
    categoryId = "guftin_incoming_call";
    ttl = 60;
  } else if (body.kind === "status" && body.status_id) {
    const { data: row, error } = await admin.from("kc_status_updates")
      .select("id,user_id,expires_at").eq("id", body.status_id).maybeSingle();
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
    title = actorName + " shared a status";
    message = "Tap to view the new status. It expires after 24 hours.";
    data = { type: "status", status_id: row.id };
  } else if ((body.kind === "status_like" || body.kind === "status_view") && body.status_id) {
    const { data: row, error } = await admin.from("kc_status_updates")
      .select("id,user_id,expires_at").eq("id", body.status_id).maybeSingle();
    if (error || !row || row.user_id === actor.id || new Date(row.expires_at).getTime() <= Date.now()) {
      return json({ error: "Active contact status not found." }, 404);
    }

    if (body.kind === "status_like") {
      const { data: event, error: eventError } = await admin.from("kc_status_likes")
        .select("status_id,user_id").eq("status_id", row.id).eq("user_id", actor.id).maybeSingle();
      if (eventError || !event) return json({ error: "Status like was not found for this account." }, 404);
      message = "liked your status.";
      data = { type: "status_like", status_id: row.id };
    } else {
      const { data: event, error: eventError } = await admin.from("kc_status_views")
        .select("status_id,viewer_id").eq("status_id", row.id).eq("viewer_id", actor.id).maybeSingle();
      if (eventError || !event) return json({ error: "Status view was not found for this account." }, 404);
      message = "viewed your status.";
      data = { type: "status_view", status_id: row.id };
    }

    recipientIds = [row.user_id];
    title = actorName;
  } else {
    return json({ error: "kind and a valid message_id, call_id, or status_id are required." }, 400);
  }

  recipientIds = [...new Set(recipientIds.filter((id) => id && (body.kind === "test" || id !== actor.id)))];
  if (!recipientIds.length) return json({ sent: 0, reason: "No recipients." });

  const { data: devices, error: tokenError } = await admin.from("kc_device_tokens")
    .select("token").in("user_id", recipientIds);
  if (tokenError) return json({ error: "Could not load recipient devices." }, 500);

  const tokens = [...new Set((devices || []).map((item: any) => item.token)
    .filter((token: string) => typeof token === "string" && token.startsWith("ExponentPushToken[")))];
  if (!tokens.length) return json({ sent: 0, reason: "Recipients have not enabled push notifications on a device." });

  const notifications = tokens.map((to) => ({
    to,
    title,
    body: message,
    sound: "default",
    priority: "high",
    channelId,
    ...(categoryId ? { categoryId } : {}),
    ...(body.kind === "call" && typeof data.call_id === "string"
      ? { tag: "guftin-call-" + data.call_id }
      : {}),
    ...(ttl ? { ttl } : {}),
    data,
  }));

  let sent = 0;
  const deliveryErrors: string[] = [];
  for (let offset = 0; offset < notifications.length; offset += 100) {
    const batch = notifications.slice(offset, offset + 100);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const expoAccessToken = Deno.env.get("EXPO_ACCESS_TOKEN");
    if (expoAccessToken) headers.Authorization = "Bearer " + expoAccessToken;

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      deliveryErrors.push("Expo push service returned HTTP " + response.status);
      continue;
    }

    const result = await response.json();
    const tickets = result.data || [];
    sent += tickets.filter((ticket: any) => ticket.status === "ok").length;

    const invalidTokens = tickets
      .map((ticket: any, index: number) => ticket.status === "error" &&
        ticket.details?.error === "DeviceNotRegistered" ? batch[index]?.to : null)
      .filter(Boolean);
    if (invalidTokens.length) {
      await admin.from("kc_device_tokens").delete().in("token", invalidTokens);
    }
    for (const ticket of tickets) {
      if (ticket.status === "error") deliveryErrors.push(ticket.details?.error || ticket.message || "Push ticket error");
    }
  }

  const warnings = [...new Set(deliveryErrors)].slice(0, 5);
  console.log("guftin-push-dispatch", JSON.stringify({
    kind: body.kind,
    recipient_count: recipientIds.length,
    attempted: tokens.length,
    sent,
    warnings,
  }));
  return json({
    sent,
    attempted: tokens.length,
    ...(warnings.length ? { warnings } : {}),
  });
});
