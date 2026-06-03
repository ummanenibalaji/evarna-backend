import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Character } from "../models/character.model.js";
import { Memory } from "../models/memory.model.js";
import {
  createCompanion,
  CompanionValidationError,
} from "../services/character.service.js";

const CreateBodySchema = z.object({
  user_id: z.string().min(1),
  archetype: z.enum(["mentor", "bestfriend", "challenger", "partner"]),
  gender: z.enum(["male", "female", "nonbinary"]),
  voice_id: z.string().min(1),
  name: z.string().min(1).max(30),
});

export async function characterRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/characters/create — standalone companion creation
  // (post-onboarding "Add companion" flow). Shape mirrors the companion block
  // of /users/onboard but lives independent of user creation.
  app.post("/create", async (request, reply) => {
    const parsed = CreateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const character = await createCompanion(parsed.data);
      return reply.status(201).send({ success: true, data: character });
    } catch (err) {
      if (err instanceof CompanionValidationError) {
        return reply.status(400).send({
          success: false,
          error: err.message,
          code: "VALIDATION_ERROR",
          field: err.field,
        });
      }
      throw err;
    }
  });

  // GET /api/v1/characters/user/:user_id — list active companions for a user
  // with each character's latest memory snippet for the home screen card.
  // Registered before /:id so Fastify matches the literal "user" segment.
  app.get<{ Params: { user_id: string } }>(
    "/user/:user_id",
    async (request, reply) => {
      const characters = await Character.find({
        user_id: request.params.user_id,
        mode: "companion",
        is_active: true,
      })
        .sort({ last_interaction_at: -1 })
        .lean();

      // For each character, fetch the highest-signal non-deleted memory.
      // `last_accessed_at` defaults to creation time, so a single sort
      // satisfies "most recently accessed, or most recently created if none
      // has been accessed."
      const withHighlights = await Promise.all(
        characters.map(async (c) => {
          const highlight = await Memory.findOne({
            character_id: c._id,
            is_deleted: false,
          })
            .sort({ last_accessed_at: -1, created_at: -1 })
            .select("content")
            .lean();

          return {
            _id: c._id.toString(),
            name: c.name,
            archetype: c.archetype,
            gender: c.gender,
            voice_id: c.voice_id,
            is_active: c.is_active,
            last_interaction_at: c.last_interaction_at,
            total_sessions: c.total_sessions,
            memory_highlight: highlight?.content ?? null,
          };
        }),
      );

      return reply.send({
        success: true,
        data: { characters: withHighlights },
      });
    },
  );

  // GET /api/v1/characters/:id
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const character = await Character.findById(request.params.id).lean();
    if (!character) {
      return reply
        .status(404)
        .send({ success: false, error: "Character not found" });
    }
    return reply.send({ success: true, data: character });
  });
}
