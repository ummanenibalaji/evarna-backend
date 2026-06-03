import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { streamConversation } from "../services/conversation.service.js";
import { logger } from "../utils/logger.js";

const SendBodySchema = z.object({
  session_id: z.string().min(1),
  character_id: z.string().min(1),
  user_id: z.string().min(1),
  message: z.string().min(1).max(2000),
});

const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/conversations/send — SSE streaming response
  app.post("/send", async (request, reply) => {
    const parsed = SendBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const { session_id, character_id, user_id, message } = parsed.data;

    // Take ownership of the raw response for SSE
    reply.hijack();
    const res = reply.raw;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",   // disable nginx buffering
    });

    try {
      const gen = streamConversation({
        sessionId: session_id,
        characterId: character_id,
        userId: user_id,
        message,
      });

      for await (const event of gen) {
        switch (event.type) {
          case "chunk":
            res.write(sseEvent("chunk", { content: event.content }));
            break;
          case "crisis":
            res.write(sseEvent("crisis", { content: event.content }));
            break;
          case "done":
            res.write(
              sseEvent("done", {
                turn_id: event.turn_id,
                tokens_used: event.tokens_used,
              })
            );
            break;
          case "error":
            res.write(sseEvent("error", { message: event.message }));
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, session_id }, `Conversation stream error: ${message}`);
      res.write(sseEvent("error", { message }));
    } finally {
      res.end();
    }
  });

  // GET /api/v1/conversations/:session_id — paginated turn history
  app.get<{ Params: { session_id: string } }>(
    "/:session_id",
    async (request, reply) => {
      const qParsed = PaginationSchema.safeParse(request.query);
      const { page, limit } = qParsed.success
        ? qParsed.data
        : { page: 1, limit: 20 };

      const session_id = new Types.ObjectId(request.params.session_id);
      const skip = (page - 1) * limit;

      const [turns, total] = await Promise.all([
        ConversationTurn.find({ session_id })
          .sort({ created_at: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        ConversationTurn.countDocuments({ session_id }),
      ]);

      return reply.send({
        success: true,
        data: {
          turns,
          pagination: {
            page,
            limit,
            total,
            has_more: skip + turns.length < total,
          },
        },
      });
    }
  );
}
