import { createClient } from "npm:@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2.19.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getPublishableKey(): string | null {
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (legacy) return legacy;

  const mapValue = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (mapValue) {
    try {
      const parsed = JSON.parse(mapValue);
      if (typeof parsed.default === "string") return parsed.default;
    } catch {
      // Ignore malformed optional environment value; return unavailable below.
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = getPublishableKey();
  const authorization = req.headers.get("Authorization") || "";
  const jwt = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!supabaseUrl || !publishableKey || !jwt) {
    return json({ error: "Authentication service is not configured." }, 503);
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const { data: userResult, error: userError } = await supabase.auth.getUser(jwt);
  const user = userResult?.user;
  if (userError || !user) {
    return json({ error: "A valid signed-in King Chat session is required." }, 401);
  }

  let body: { call_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "A JSON request body is required." }, 400);
  }

  const callId = typeof body.call_id === "string" ? body.call_id : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
    return json({ error: "A valid call_id is required." }, 400);
  }

  const { data: call, error: callError } = await supabase
    .from("kc_call_logs")
    .select("id, conversation_id, caller_id, callee_id, call_type, status")
    .eq("id", callId)
    .maybeSingle();

  if (callError || !call) {
    return json({ error: "Call was not found or you are not a participant." }, 404);
  }
  if (call.caller_id !== user.id && call.callee_id !== user.id) {
    return json({ error: "You are not a participant in this call." }, 403);
  }
  if (call.status !== "accepted") {
    return json({ error: "The call must be accepted before joining." }, 409);
  }

  // Read the three server-only LiveKit secrets. Never return their values.
  const rawLivekitUrl = (Deno.env.get("LIVEKIT_URL") || "").trim();
  const apiKey = (Deno.env.get("LIVEKIT_API_KEY") || "").trim();
  const apiSecret = (Deno.env.get("LIVEKIT_API_SECRET") || "").trim();
  const missing = [
    !rawLivekitUrl ? "LIVEKIT_URL" : null,
    !apiKey ? "LIVEKIT_API_KEY" : null,
    !apiSecret ? "LIVEKIT_API_SECRET" : null,
  ].filter(Boolean) as string[];
  if (missing.length) {
    return json({
      error: "LiveKit credentials are missing from Supabase Edge Function secrets.",
      missing,
      action: "Add the missing names under Project Settings > Edge Functions > Secrets. Save, then retry the call.",
    }, 503);
  }

  let livekitUrl: string;
  try {
    // LiveKit React Native expects a WebSocket URL. Accept https:// from the
    // dashboard too, and normalize it to wss:// before returning it to clients.
    const normalized = rawLivekitUrl.replace(/^https:\/\//i, "wss://").replace(/\/+$/, "");
    const parsed = new URL(normalized);
    if (parsed.protocol !== "wss:" || !parsed.host) {
      return json({
        error: "LIVEKIT_URL must be a valid LiveKit secure WebSocket URL (wss://...).",
      }, 503);
    }
    livekitUrl = parsed.toString().replace(/\/+$/, "");
  } catch {
    return json({ error: "LIVEKIT_URL is not a valid URL. Use the wss:// address from your LiveKit project." }, 503);
  }

  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      name: "King Chat participant",
      ttl: "10m",
    });
    token.addGrant({
      roomJoin: true,
      room: `kc-call-${call.id}`,
      canPublish: true,
      canSubscribe: true,
    });

    const participantToken = await token.toJwt();
    return json({
      server_url: livekitUrl,
      participant_token: participantToken,
      room_name: `kc-call-${call.id}`,
      call_type: call.call_type,
    }, 201);
  } catch {
    return json({ error: "Could not create a LiveKit room token." }, 500);
  }
});
