import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
import { initSessionContext } from "../services/session-context.service.js";
import { generateRoomToken, LiveKitNotConfiguredError } from "../services/livekit-token.service.js";
import { canStart, refuse } from "../services/entitlement.service.js";
import { EVARNA_VOICES } from "../data/voices.js";
import { bearerToken, getUserId } from "../middleware/auth.js";
import { issueClmToken, verifyClmToken } from "../services/auth.service.js";
import { clmChunk, EviNotConfiguredError, getHumeAccessToken } from "../services/hume-evi.service.js";
import { streamConversation } from "../services/conversation.service.js";
import { User } from "../models/user.model.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { assertCanStartCall, voiceSecondsRemaining, VOICE_LIMIT_LINE } from "../services/usage.service.js";

// No user_id: the owner is whoever holds the token.
const StartVoiceSessionSchema = z.object({
  character_id: z.string().min(1),
});

// What EVI posts. Only `messages` matters; anything else Hume adds is ignored.
// `models.prosody.scores` is its tone-of-voice measurement for that utterance.
const ClmRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.string().nullable().optional(),
        models: z.object({ prosody: z.object({ scores: z.record(z.unknown()) }).partial().nullable().optional() })
          .partial().nullable().optional(),
      }).passthrough(),
    )
    .min(1),
}).passthrough();

// Spoken if the pipeline fails. Mirrors voice-llm.service.ts: on a call, an
// error has to be something the caller hears, not a silent turn.
const SPOKEN_FALLBACK = "Sorry, I lost my train of thought there. Could you say that again?";

type StartResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; error: string };

/**
 * Shared by the LiveKit and EVI start routes: ownership check, session row,
 * Redis context, engagement count. Scoped by user_id in the query, so someone
 * else's companion is indistinguishable from one that does not exist.
 */
async function createVoiceSession(user_id: string, character_id: string): Promise<StartResult> {
  if (!Types.ObjectId.isValid(character_id)) return { ok: false, status: 404, error: "Character not found" };

  const character = await Character.findOne({ _id: character_id, user_id }).select("_id").lean();
  if (!character) return { ok: false, status: 404, error: "Character not found" };

  const session = await Session.create({
    user_id,
    character_id: new Types.ObjectId(character_id),
    session_type: "voice_call",
    mode: "companion",
    status: "active",
    started_at: new Date(),
  });

  const sessionId = session._id.toString();
  await initSessionContext(sessionId);

  // FIX 12: track engagement counts
  void Character.updateOne(
    { _id: new Types.ObjectId(character_id) },
    { $inc: { total_sessions: 1 } },
  ).catch((err) => logger.error({ err }, "Voice: failed to increment character total_sessions"));

  return { ok: true, sessionId };
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/voice/voices — public catalog for onboarding (S07) and settings
  app.get("/voices", async (_request, reply) => {
    return reply.send({ success: true, data: EVARNA_VOICES });
  });

  // POST /api/v1/voice/sessions/start
  app.post("/sessions/start", async (request, reply) => {
    const parsed = StartVoiceSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const user_id = getUserId(request);

    // The plan first, then the abuse ceiling. A voice minute is roughly $0.085
    // all-in and the largest variable cost in the product, so this is the one
    // refusal the app turns into a paywall rather than an apology.
    const gate = await canStart(user_id, "voice");
    if (!gate.allowed) return refuse(reply, gate);
    await assertCanStartCall(user_id);

    const started = await createVoiceSession(user_id, parsed.data.character_id);
    if (!started.ok) return reply.status(started.status).send({ success: false, error: started.error });
    const { sessionId } = started;

    try {
      const { token, livekit_url, room_name } = await generateRoomToken({
        roomName: sessionId,
        participantIdentity: user_id,
      });

      return reply.status(201).send({
        success: true,
        data: {
          session_id: sessionId,
          livekit_token: token,
          livekit_url,
          room_name,
        },
      });
    } catch (err) {
      if (err instanceof LiveKitNotConfiguredError) {
        logger.warn({ sessionId }, "Voice session started but LiveKit not configured");
        return reply.status(503).send({
          success: false,
          error: err.message,
          code: "LIVEKIT_NOT_CONFIGURED",
        });
      }
      throw err;
    }
  });

  // POST /api/v1/voice/evi/sessions/start
  //
  // Everything the app needs to open a Hume EVI call: a Hume access token for
  // the socket, the config to connect with, and a token for Hume to call our
  // model endpoint with. The app sends the last two in session_settings as
  // custom_session_id and language_model_api_key.
  app.post("/evi/sessions/start", async (request, reply) => {
    const parsed = StartVoiceSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const user_id = getUserId(request);

    // Same gate as the LiveKit path: EVI calls cost the same minutes, so a
    // route that bypassed it would be a hole in the meter.
    const gate = await canStart(user_id, "voice");
    if (!gate.allowed) return refuse(reply, gate);
    await assertCanStartCall(user_id);

    // Before creating the session, so a misconfigured server does not leave an
    // orphaned "active" call behind for every attempt.
    let humeAccessToken: string;
    try {
      humeAccessToken = await getHumeAccessToken();
    } catch (err) {
      if (err instanceof EviNotConfiguredError) {
        return reply.status(503).send({ success: false, error: err.message, code: "EVI_NOT_CONFIGURED" });
      }
      logger.error({ err }, "voice: could not obtain a Hume access token");
      return reply.status(502).send({ success: false, error: "Voice is unavailable right now. Please try again." });
    }

    const started = await createVoiceSession(user_id, parsed.data.character_id);
    if (!started.ok) return reply.status(started.status).send({ success: false, error: started.error });

    const user = await User.findById(user_id).select("token_version").lean();
    return reply.status(201).send({
      success: true,
      data: {
        session_id: started.sessionId,
        hume_access_token: humeAccessToken,
        hume_config_id: env.HUME_EVI_CONFIG_ID,
        clm_token: await issueClmToken(user_id, started.sessionId, user?.token_version ?? 0),
      },
    });
  });

  // POST /api/v1/voice/clm/chat/completions
  //
  // Called by Hume, not the app — so it is skipped by the global auth hook and
  // verifies its own per-call token FIRST, before touching the database.
  //
  // EVI sends the whole conversation every turn. Only the latest user message
  // is used: history is owned by the Redis session context inside
  // streamConversation(), exactly as on the LiveKit path, and sending both
  // would duplicate it in the prompt.
  app.post<{ Querystring: { custom_session_id?: string } }>("/clm/chat/completions", async (request, reply) => {
    const unauthorized = () =>
      reply.status(401).send({ success: false, error: "Authentication required", code: "UNAUTHENTICATED" });

    const token = bearerToken(request);
    if (!token) return unauthorized();
    let claims;
    try {
      claims = await verifyClmToken(token);
    } catch {
      return unauthorized();
    }

    // The token names the session; Hume echoes the one the app set. A mismatch
    // is a token being used for a call it was not issued for.
    const echoed = request.query.custom_session_id;
    if (echoed && echoed !== claims.sessionId) {
      return reply.status(403).send({ success: false, error: "Token is not valid for this session", code: "SESSION_MISMATCH" });
    }

    const parsed = ClmRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "Expected an OpenAI-style messages array" });
    }
    const latest = [...parsed.data.messages].reverse().find((m) => m.role === "user" && m.content?.trim());
    if (!latest?.content) {
      return reply.status(400).send({ success: false, error: "No user message to respond to" });
    }

    // Revocation and ownership, same rules as the app token.
    const [user, session] = await Promise.all([
      User.findById(claims.userId).select("token_version").lean(),
      Types.ObjectId.isValid(claims.sessionId)
        ? Session.findOne({ _id: claims.sessionId, user_id: claims.userId }).select("character_id status session_type").lean()
        : null,
    ]);
    if (!user || (user.token_version ?? 0) !== claims.tokenVersion) return unauthorized();
    if (!session || session.session_type !== "voice_call") {
      return reply.status(404).send({ success: false, error: "Session not found" });
    }
    if (session.status !== "active") {
      return reply.status(409).send({ success: false, error: "This call has ended", code: "SESSION_ENDED" });
    }

    // Checked every turn: EVI has no call timer of ours, so this is where a call
    // that runs past the day's minutes ends. Nothing is generated or stored.
    const outOfMinutes = (await voiceSecondsRemaining(claims.userId)) <= 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // As on the text route, generation continues if Hume drops the request:
    // the turn is persisted either way.
    let gone = false;
    res.on("close", () => { gone = true; });
    const send = (chunk: string) => { if (!gone) res.write(chunk); };

    if (outOfMinutes) {
      send(clmChunk(claims.sessionId, VOICE_LIMIT_LINE));
      send(clmChunk(claims.sessionId, null, "stop"));
      send("data: [DONE]\n\n");
      res.end();
      return;
    }

    let spoke = false;
    try {
      for await (const event of streamConversation({
        sessionId: claims.sessionId,
        characterId: session.character_id.toString(),
        userId: claims.userId,
        message: latest.content,
        isVoiceMode: true,
        prosody: latest.models?.prosody?.scores ?? null,
      })) {
        if (event.type === "chunk" || event.type === "crisis") {
          spoke = true;
          send(clmChunk(claims.sessionId, event.content));
        } else if (event.type === "error") {
          logger.error({ sessionId: claims.sessionId, message: event.message }, "voice: EVI turn failed");
          if (!spoke) send(clmChunk(claims.sessionId, SPOKEN_FALLBACK));
          spoke = true;
        }
      }
    } catch (err) {
      logger.error({ err, sessionId: claims.sessionId }, "voice: EVI pipeline threw unexpectedly");
      if (!spoke) send(clmChunk(claims.sessionId, SPOKEN_FALLBACK));
    }
    send(clmChunk(claims.sessionId, null, "stop"));
    send("data: [DONE]\n\n");
    res.end();
  });

  // NOTE: POST /api/v1/voice/webhook was removed.
  //
  // It never worked: verification needs the raw request body, which requires
  // the `fastify-raw-body` plugin. That plugin was never installed, so
  // `{ config: { rawBody: true } }` was inert, WebhookReceiver.receive() was
  // handed a re-serialized body, and every call failed signature verification
  // with a 401. Session finalization is now handled where it belongs — in the
  // voice worker, on RoomEvent.ParticipantDisconnected / Disconnected (see
  // voice.service.ts) — which is server-side and survives the app being killed.
  // The 30-minute stale-session sweep remains the last-resort backstop.
}
