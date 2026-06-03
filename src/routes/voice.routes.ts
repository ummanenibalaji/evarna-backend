import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { WebhookReceiver } from "livekit-server-sdk";
import { env } from "../config/env.js";
import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
import { initSessionContext } from "../services/session-context.service.js";
import { generateRoomToken, LiveKitNotConfiguredError } from "../services/livekit-token.service.js";
import { enqueueMemoryExtraction } from "../queues/memory.queue.js";
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

  // POST /api/v1/voice/webhook — LiveKit Cloud sends room.finished and friends here
  // Signed via LIVEKIT_API_SECRET; we verify with WebhookReceiver.
  app.post("/webhook", { config: { rawBody: true } }, async (request, reply) => {
    if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      return reply
        .status(503)
        .send({ success: false, error: "LiveKit not configured", code: "LIVEKIT_NOT_CONFIGURED" });
    }

    const auth = request.headers.authorization;
    const body =
      typeof (request as unknown as { rawBody?: string }).rawBody === "string"
        ? (request as unknown as { rawBody: string }).rawBody
        : typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);

    const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

    let event;
    try {
      event = await receiver.receive(body, auth);
    } catch (err) {
      logger.warn({ err }, "LiveKit webhook verification failed");
      return reply.status(401).send({ success: false, error: "Invalid signature" });
    }

    if (event.event === "room_finished") {
      const sessionId = event.room?.name;
      if (sessionId && Types.ObjectId.isValid(sessionId)) {
        await finalizeSession(sessionId);
      }
    }

    return reply.send({ success: true });
  });
}

async function finalizeSession(sessionId: string): Promise<void> {
  const session = await Session.findById(sessionId);
  if (!session || session.status !== "active") return;

  const endedAt = new Date();
  const duration_seconds = Math.floor(
    (endedAt.getTime() - session.started_at.getTime()) / 1000
  );
  session.ended_at = endedAt;
  session.duration_seconds = duration_seconds;
  session.voice_minutes_consumed = Math.ceil(duration_seconds / 60);
  session.status = "completed";
  await session.save();

  void enqueueMemoryExtraction({
    sessionId: session._id.toString(),
    characterId: session.character_id.toString(),
    userId: session.user_id,
  }).catch((err) =>
    logger.error({ err, sessionId }, "Webhook fallback failed to enqueue memory extraction")
  );
}
