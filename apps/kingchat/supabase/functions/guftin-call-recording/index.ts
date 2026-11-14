import { createClient } from "npm:@supabase/supabase-js@2";
import { AccessToken, EgressClient } from "npm:livekit-server-sdk@2.19.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, "Content-Type": "application/json" },
});
const activeStates = ["awaiting_consent", "switching_to_recording", "starting", "recording", "stopping"];
const envFirst = (names: string[]) => names.map((name) => (Deno.env.get(name) || "").trim()).find(Boolean) || "";
const httpUrl = (raw: string) => raw.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://").replace(/\/+$/, "");
const validUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function livekitConfig() {
  const raw = envFirst(["LIVEKIT_URL", "LIVEKIT_WEBSOCKET_URL", "WEBSOCKET_URL", "Websocket URL", "WebSocket URL"]);
  const apiKey = envFirst(["LIVEKIT_API_KEY", "LIVEKIT_KEY", "API_KEY", "API key", "API KEY"]);
  const apiSecret = envFirst(["LIVEKIT_API_SECRET", "LIVEKIT_SECRET", "API_SECRET", "API secret", "API SECRET"]);
  if (!raw || !apiKey || !apiSecret) throw new Error("LiveKit Egress is not configured.");
  const host = httpUrl(raw);
  if (new URL(host).protocol !== "https:") throw new Error("LiveKit must use HTTPS.");
  return { host, apiKey, apiSecret };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const userJwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!supabaseUrl || !serviceKey || !userJwt) return json({ error: "Recording service is not configured." }, 503);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: authData, error: authError } = await admin.auth.getUser(userJwt);
  const actor = authData?.user;
  if (authError || !actor) return json({ error: "A valid signed-in Guftin session is required." }, 401);

  let body: { action?: string; call_id?: string; recording_id?: string; decision?: string };
  try { body = await req.json(); } catch { return json({ error: "A JSON request body is required." }, 400); }
  const action = String(body.action || "");
  const callId = String(body.call_id || "");
  if (!validUuid(callId)) return json({ error: "A valid call_id is required." }, 400);

  const { data: call, error: callError } = await admin.from("kc_call_logs")
    .select("id,conversation_id,caller_id,callee_id,call_type,status,call_scope")
    .eq("id", callId).maybeSingle();
  if (callError || !call) return json({ error: "The call was not found." }, 404);

  let participantIds: string[] = [];
  if ((call.call_scope || "direct") === "group") {
    const { data, error } = await admin.from("kc_call_participants").select("user_id,status").eq("call_id", callId);
    if (error) return json({ error: "Could not verify group participants." }, 500);
    participantIds = [...new Set((data || []).filter((row: any) =>
      action === "request" ? row.status === "accepted" : ["accepted", "left", "declined"].includes(row.status)
    ).map((row: any) => row.user_id).filter(Boolean))];
  } else {
    participantIds = [...new Set([call.caller_id, call.callee_id].filter(Boolean))] as string[];
  }
  if (!participantIds.includes(actor.id)) return json({ error: "You are not a participant in this call." }, 403);
  if (["request", "consent", "ready"].includes(action) && call.status !== "accepted") {
    return json({ error: "Recording can only be started while the call is active." }, 409);
  }

  const selectFields = "id,call_id,requested_by,status,media_type,egress_id,storage_path,error_message,created_at,ended_at";
  const getLatest = async () => {
    const { data, error } = await admin.from("kc_call_recordings").select(selectFields)
      .eq("call_id", callId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data;
  };
  const responseFor = async (recording: any) => {
    if (!recording) return { recording: null, own_decision: null, own_e2ee_disabled: false, counts: { accepted: 0, ready: 0, total: 0 } };
    const { data, error } = await admin.from("kc_call_recording_consents")
      .select("user_id,decision,e2ee_disabled_at").eq("recording_id", recording.id);
    if (error) throw error;
    const consents = data || [];
    const own = consents.find((row: any) => row.user_id === actor.id);
    return {
      recording,
      own_decision: own?.decision || null,
      own_e2ee_disabled: !!own?.e2ee_disabled_at,
      counts: {
        accepted: consents.filter((row: any) => row.decision === "accepted").length,
        ready: consents.filter((row: any) => row.decision === "accepted" && row.e2ee_disabled_at).length,
        total: consents.length,
      },
    };
  };
  const completeIfUploaded = async (recording: any) => {
    if (!recording || recording.status !== "stopping" || !recording.storage_path) return recording;
    const slash = recording.storage_path.lastIndexOf("/");
    const folder = recording.storage_path.slice(0, slash);
    const filename = recording.storage_path.slice(slash + 1);
    const { data } = await admin.storage.from("call-recordings").list(folder, { limit: 100, search: filename });
    if ((data || []).some((item: any) => item.name === filename)) {
      const { data: updated } = await admin.from("kc_call_recordings").update({
        status: "complete", ended_at: new Date().toISOString(), error_message: null,
      }).eq("id", recording.id).eq("status", "stopping").select(selectFields).maybeSingle();
      return updated || { ...recording, status: "complete" };
    }
    return recording;
  };
  const stopEgress = async (recording: any) => {
    if (!recording?.egress_id) return;
    const { host, apiKey, apiSecret } = livekitConfig();
    try { await new EgressClient(host, apiKey, apiSecret).stopEgress(recording.egress_id); }
    catch (error: any) {
      // The room may have closed first and Egress may already be finalizing.
      console.warn("Guftin Egress stop:", String(error?.message || error).slice(0, 160));
    }
  };

  try {
    if (action === "request") {
      if (call.status !== "accepted") return json({ error: "Recording can only be requested in an active call." }, 409);
      const { data: active, error } = await admin.from("kc_call_recordings")
        .select("id").eq("call_id", callId).in("status", activeStates).limit(1).maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (active) return json({ error: "A recording request is already active for this call." }, 409);
      const { data: recording, error: insertError } = await admin.from("kc_call_recordings").insert({
        call_id: callId, requested_by: actor.id, status: "awaiting_consent",
        media_type: call.call_type === "video" ? "video" : "voice",
      }).select(selectFields).single();
      if (insertError || !recording) return json({ error: "Could not create the recording request." }, 409);
      const rows = participantIds.map((userId) => ({
        recording_id: recording.id, user_id: userId,
        decision: userId === actor.id ? "accepted" : "pending",
      }));
      const { error: consentError } = await admin.from("kc_call_recording_consents").insert(rows);
      if (consentError) {
        await admin.from("kc_call_recordings").update({ status: "failed", error_message: "Could not prepare participant consent." }).eq("id", recording.id);
        return json({ error: "Could not prepare participant consent." }, 500);
      }
      return json(await responseFor(recording), 201);
    }

    let recording = await getLatest();
    if (!recording) return json({ error: "No recording request exists for this call." }, 404);
    if (body.recording_id && body.recording_id !== recording.id) return json({ error: "This recording request is no longer current." }, 409);

    if (action === "status") {
      if (recording.status === "recording" && call.status !== "accepted") {
        await stopEgress(recording);
        const { data } = await admin.from("kc_call_recordings").update({
          status: "stopping", ended_at: new Date().toISOString(),
        }).eq("id", recording.id).eq("status", "recording").select(selectFields).maybeSingle();
        recording = data || { ...recording, status: "stopping" };
      }
      recording = await completeIfUploaded(recording);
      return json(await responseFor(recording));
    }

    if (action === "consent") {
      if (recording.status !== "awaiting_consent") return json({ error: "The consent period has closed." }, 409);
      if (body.decision !== "accepted" && body.decision !== "declined") return json({ error: "Choose Accept or Decline." }, 400);
      const { error } = await admin.from("kc_call_recording_consents").update({
        decision: body.decision, updated_at: new Date().toISOString(),
      }).eq("recording_id", recording.id).eq("user_id", actor.id).eq("decision", "pending");
      if (error) return json({ error: "Could not save your recording decision." }, 500);
      if (body.decision === "declined") {
        const { data } = await admin.from("kc_call_recordings").update({
          status: "declined", ended_at: new Date().toISOString(),
        }).eq("id", recording.id).eq("status", "awaiting_consent").select(selectFields).maybeSingle();
        return json(await responseFor(data || { ...recording, status: "declined" }));
      }
      const { data: decisions, error: decisionError } = await admin.from("kc_call_recording_consents")
        .select("decision").eq("recording_id", recording.id);
      if (decisionError) return json({ error: "Could not verify participant decisions." }, 500);
      if ((decisions || []).length === participantIds.length &&
          (decisions || []).every((row: any) => row.decision === "accepted")) {
        const { data } = await admin.from("kc_call_recordings").update({ status: "switching_to_recording" })
          .eq("id", recording.id).eq("status", "awaiting_consent").select(selectFields).maybeSingle();
        recording = data || { ...recording, status: "switching_to_recording" };
      }
      return json(await responseFor(recording));
    }

    if (action === "ready") {
      if (recording.status !== "switching_to_recording") return json(await responseFor(recording), 409);
      const { error } = await admin.from("kc_call_recording_consents").update({
        e2ee_disabled_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("recording_id", recording.id).eq("user_id", actor.id).eq("decision", "accepted");
      if (error) return json({ error: "Could not confirm your media-encryption transition." }, 500);
      const { data: readyRows, error: readyError } = await admin.from("kc_call_recording_consents")
        .select("decision,e2ee_disabled_at").eq("recording_id", recording.id);
      if (readyError) return json({ error: "Could not verify participant readiness." }, 500);
      const ready = (readyRows || []).length === participantIds.length &&
        (readyRows || []).every((row: any) => row.decision === "accepted" && !!row.e2ee_disabled_at);
      if (!ready) return json(await responseFor(recording));

      const { data: claimed, error: claimError } = await admin.from("kc_call_recordings").update({
        status: "starting", error_message: null,
      }).eq("id", recording.id).eq("status", "switching_to_recording").select(selectFields).maybeSingle();
      if (claimError) return json({ error: "Could not start the recording state." }, 500);
      if (!claimed) return json(await responseFor(recording));

      try {
        const { host, apiKey, apiSecret } = livekitConfig();
        const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
        const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
        if (!anonKey) throw new Error("Supabase S3 uploads need SUPABASE_ANON_KEY in Edge Function secrets.");
        const storagePath = actor.id + "/" + callId + "/" + recording.id + ".mp4";
        const roomName = "kc-call-" + callId;
        const token = new AccessToken(apiKey, apiSecret, { identity: "guftin-recorder-" + recording.id, ttl: "5m" });
        token.addGrant({ roomRecord: true, room: roomName });
        const egressJwt = await token.toJwt();
        const request: Record<string, unknown> = {
          room_name: roomName,
          audio_only: recording.media_type === "voice",
          file: {
            filepath: storagePath,
            file_type: "MP4",
            s3: {
              access_key: projectRef,
              secret: anonKey,
              session_token: userJwt,
              region: "ap-northeast-1",
              endpoint: "https://" + projectRef + ".storage.supabase.co/storage/v1/s3",
              bucket: "call-recordings",
              force_path_style: true,
            },
          },
        };
        if (recording.media_type === "video") {
          request.layout = "grid";
          request.advanced = { width: 1280, height: 720, framerate: 30, video_bitrate: 3000, audio_bitrate: 128 };
        }
        const startResponse = await fetch(host + "/twirp/livekit.Egress/StartRoomCompositeEgress", {
          method: "POST",
          headers: { Authorization: "Bearer " + egressJwt, "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const startBody = await startResponse.json().catch(() => ({}));
        if (!startResponse.ok) {
          const message = String((startBody as any)?.msg || (startBody as any)?.message || "LiveKit Egress rejected this recording.");
          throw new Error(message.slice(0, 220));
        }
        const egressId = String((startBody as any)?.egressId || (startBody as any)?.egress_id || "");
        if (!egressId) throw new Error("LiveKit returned no Egress ID.");
        const { data: activeRecording } = await admin.from("kc_call_recordings").update({
          status: "recording", egress_id: egressId, storage_path: storagePath,
        }).eq("id", recording.id).eq("status", "starting").select(selectFields).maybeSingle();
        if (!activeRecording) {
          await fetch(host + "/twirp/livekit.Egress/StopEgress", {
            method: "POST",
            headers: { Authorization: "Bearer " + egressJwt, "Content-Type": "application/json" },
            body: JSON.stringify({ egress_id: egressId }),
          }).catch(() => {});
          return json({ error: "The call changed before recording could start." }, 409);
        }
        recording = activeRecording;
      } catch (error: any) {
        const message = String(error?.message || "LiveKit could not start the recording.").slice(0, 220);
        const { data: failed } = await admin.from("kc_call_recordings").update({
          status: "failed", error_message: message, ended_at: new Date().toISOString(),
        }).eq("id", recording.id).eq("status", "starting").select(selectFields).maybeSingle();
        return json({ error: message, recording: failed || { ...recording, status: "failed", error_message: message } }, 503);
      }
      return json(await responseFor(recording), 201);
    }

    if (action === "stop") {
      if (["awaiting_consent", "switching_to_recording", "starting"].includes(recording.status)) {
        if (recording.egress_id) await stopEgress(recording);
        const { data } = await admin.from("kc_call_recordings").update({
          status: "cancelled", ended_at: new Date().toISOString(),
        }).eq("id", recording.id).in("status", ["awaiting_consent", "switching_to_recording", "starting"])
          .select(selectFields).maybeSingle();
        return json(await responseFor(data || { ...recording, status: "cancelled" }));
      }
      if (recording.status === "recording" && recording.egress_id) {
        await stopEgress(recording);
        const { data } = await admin.from("kc_call_recordings").update({
          status: "stopping", ended_at: new Date().toISOString(),
        }).eq("id", recording.id).eq("status", "recording").select(selectFields).maybeSingle();
        recording = data || { ...recording, status: "stopping" };
      }
      recording = await completeIfUploaded(recording);
      return json(await responseFor(recording));
    }
    return json({ error: "Unsupported recording action." }, 400);
  } catch (error: any) {
    console.error("guftin-call-recording", String(error?.message || error).slice(0, 220));
    return json({ error: "The call recording request could not be completed." }, 500);
  }
});
