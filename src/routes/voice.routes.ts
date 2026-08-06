import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
import { initSessionContext } from "../services/session-context.service.js";
import { generateRoomToken, LiveKitNotConfiguredError } from "../services/livekit-token.service.js";
import { WHISPER_VOICES } from "../data/voices.js";
import { logger } from "../utils/logger.js";

const StartVoiceSessionSchema = z.object({
  user_id: z.string().min(1),
  character_id: z.string().min(1),
});

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/voice/voices — public catalog for onboarding (S07) and settings
  app.get("/voices", async (_request, reply) => {
    return reply.send({ success: true, data: WHISPER_VOICES });
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

    const { user_id, character_id } = parsed.data;

    if (!Types.ObjectId.isValid(character_id)) {
      return reply.status(400).send({ success: false, error: "Invalid character_id" });
    }

    const character = await Character.findById(character_id).select("_id user_id").lean();
    if (!character) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

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
