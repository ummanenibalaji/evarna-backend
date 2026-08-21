import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { Report } from "../models/report.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { getUserId } from "../middleware/auth.js";
import { logger } from "../utils/logger.js";

const CreateBodySchema = z.object({
  turn_id: z.string().min(1),
  reason: z.enum(["harmful", "sexual", "inappropriate_minor", "inaccurate", "other"]),
  note: z.string().max(1000).optional(),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/reports — report a generated message (App Store Guideline 1.2)
  app.post("/", async (request, reply) => {
    const parsed = CreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    const { turn_id, reason, note } = parsed.data;

    if (!Types.ObjectId.isValid(turn_id)) {
      return reply.status(400).send({ success: false, error: "Invalid turn_id" });
    }

    const userId = getUserId(request);

    // 404 rather than 403 when the turn belongs to someone else: a 403 would
    // confirm the id exists.
    const turn = await ConversationTurn.findById(turn_id)
      .select("user_id session_id character_id content_text")
      .lean();
    if (!turn || turn.user_id !== userId) {
      return reply.status(404).send({ success: false, error: "Turn not found" });
    }

    const report = await Report.create({
      user_id: userId,
      turn_id: new Types.ObjectId(turn_id),
      session_id: turn.session_id,
      character_id: turn.character_id,
      reason,
      note: note ?? "",
      content_snapshot: turn.content_text,
      status: "open",
    });

    // ponytail: log aggregation is v1's "reaches a human". Upgrade path is a
    // real moderation queue/inbox reading { status: "open" } newest first.
    logger.warn(
      { report_id: report._id.toString(), reason, turn_id },
      "content report created"
    );

    return reply.status(201).send({
      success: true,
      data: { report_id: report._id.toString() },
    });
  });
}
