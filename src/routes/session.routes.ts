import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
import { initSessionContext } from "../services/session-context.service.js";
import { endSessionById } from "../services/session.service.js";
import { findOwnedCharacter, findOwnedSession } from "../services/account.service.js";
import { getUserId } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";

// No user_id: the owner is whoever holds the token.
const StartBodySchema = z.object({
  character_id: z.string().min(1),
  session_type: z.enum(["text", "voice_call", "voice_note"]),
  // Studio offers this per session. Absent means remember, which is what every
  // companion session wants and what the old behaviour was.
  remember: z.boolean().default(true),
});

const EndBodySchema = z.object({
  ended_at: z.string().optional(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/sessions/start
  app.post("/start", async (request, reply) => {
    const parsed = StartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const { character_id, session_type, remember } = parsed.data;
    const user_id = getUserId(request);

    // You cannot start a session against someone else's companion. Without
    // this the character_id was an unchecked parameter that would have written
    // turns and memories into another user's relationship.
    const owned = await findOwnedCharacter(user_id, character_id);
    if (!owned) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

    const session = await Session.create({
      user_id,
      character_id: new Types.ObjectId(character_id),
      session_type,
      // Copied from the character rather than accepted from the client: a
      // client-supplied mode would let a companion session be labelled studio
      // and vice versa, which would misfile its memories.
      mode: owned.mode,
      memory_enabled: remember,
      status: "active",
      started_at: new Date(),
    });

    await initSessionContext(session._id.toString());

    // FIX 12: track engagement counts
    void Character.updateOne(
      { _id: new Types.ObjectId(character_id) },
      { $inc: { total_sessions: 1 } },
    ).catch((err) => logger.error({ err }, "Failed to increment character total_sessions"));

    return reply.status(201).send({
      success: true,
      data: { session_id: session._id.toString() },
    });
  });

  // POST /api/v1/sessions/:id/end
  app.post<{ Params: { id: string } }>("/:id/end", async (request, reply) => {
    const parsed = EndBodySchema.safeParse(request.body);
    const endedAt = parsed.success && parsed.data.ended_at
      ? new Date(parsed.data.ended_at)
      : new Date();

    if (!(await findOwnedSession(getUserId(request), request.params.id))) {
      return reply.status(404).send({ success: false, error: "Session not found or already ended" });
    }

    const duration_seconds = await endSessionById(request.params.id, "completed", endedAt);

    if (duration_seconds === null) {
      return reply.status(404).send({ success: false, error: "Session not found or already ended" });
    }

    return reply.send({
      success: true,
      data: { session_id: request.params.id, duration_seconds },
    });
  });

  // GET /api/v1/sessions/character/:character_id
  app.get<{ Params: { character_id: string } }>(
    "/character/:character_id",
    async (request, reply) => {
      const userId = getUserId(request);
      if (!(await findOwnedCharacter(userId, request.params.character_id))) {
        return reply.status(404).send({ success: false, error: "Character not found" });
      }

      const qParsed = PaginationSchema.safeParse(request.query);
      const { page, limit } = qParsed.success
        ? qParsed.data
        : { page: 1, limit: 20 };

      const character_id = new Types.ObjectId(request.params.character_id);
      const skip = (page - 1) * limit;

      const [sessions, total] = await Promise.all([
        Session.find({ character_id })
          .sort({ started_at: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Session.countDocuments({ character_id }),
      ]);

      return reply.send({
        success: true,
        data: {
          sessions,
          pagination: { page, limit, total, has_more: skip + sessions.length < total },
        },
      });
    }
  );
}
