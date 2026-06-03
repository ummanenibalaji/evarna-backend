import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { Memory } from "../models/memory.model.js";

const TypeFilterSchema = z.object({
  type: z.enum(["fact", "emotion", "event", "preference"]).optional(),
});

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/memories/:character_id
  // Returns all non-deleted memories for a character, optionally filtered by type.
  // Embedding vectors are excluded from the response (1536 floats, not useful to clients).
  app.get<{ Params: { character_id: string } }>(
    "/:character_id",
    async (request, reply) => {
      if (!Types.ObjectId.isValid(request.params.character_id)) {
        return reply.status(400).send({ success: false, error: "Invalid character_id" });
      }

      const qParsed = TypeFilterSchema.safeParse(request.query);
      const typeFilter = qParsed.success ? qParsed.data.type : undefined;

      const filter: Record<string, unknown> = {
        character_id: new Types.ObjectId(request.params.character_id),
        is_deleted: false,
      };
      if (typeFilter) filter["type"] = typeFilter;

      const memories = await Memory.find(filter)
        .select("-embedding")
        .sort({ created_at: -1 })
        .lean();

      return reply.send({ success: true, data: memories });
    }
  );

  // DELETE /api/v1/memories/character/:character_id — bulk soft delete
  // Registered before /:memory_id so Fastify's router matches the literal "character" segment first.
  app.delete<{ Params: { character_id: string } }>(
    "/character/:character_id",
    async (request, reply) => {
      if (!Types.ObjectId.isValid(request.params.character_id)) {
        return reply.status(400).send({ success: false, error: "Invalid character_id" });
      }

      const result = await Memory.updateMany(
        {
          character_id: new Types.ObjectId(request.params.character_id),
          is_deleted: false,
        },
        { $set: { is_deleted: true } }
      );

      return reply.send({
        success: true,
        data: { deleted_count: result.modifiedCount },
      });
    }
  );

  // DELETE /api/v1/memories/:memory_id — individual soft delete
  app.delete<{ Params: { memory_id: string } }>(
    "/:memory_id",
    async (request, reply) => {
      if (!Types.ObjectId.isValid(request.params.memory_id)) {
        return reply.status(400).send({ success: false, error: "Invalid memory_id" });
      }

      const memory = await Memory.findByIdAndUpdate(
        request.params.memory_id,
        { $set: { is_deleted: true } },
        { new: true }
      ).lean();

      if (!memory) {
        return reply.status(404).send({ success: false, error: "Memory not found" });
      }

      return reply.send({
        success: true,
        data: { memory_id: memory._id.toString() },
      });
    }
  );
}
