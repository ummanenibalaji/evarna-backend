import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Types } from "mongoose";
import { Character } from "../models/character.model.js";
import { Memory } from "../models/memory.model.js";
import {
  createCompanion,
  CompanionValidationError,
} from "../services/character.service.js";
import { invalidateCharacterConfig } from "../services/session-context.service.js";
import { getVoice } from "../data/voices.js";
import { getUserId } from "../middleware/auth.js";
import { getSuggestion, resolveSuggestion } from "../services/adaptation.service.js";

// No `user_id` field: the owner is whoever holds the token.
const CreateBodySchema = z.object({
  archetype: z.enum(["mentor", "bestfriend", "challenger", "partner"]),
  gender: z.enum(["male", "female", "nonbinary"]),
  voice_id: z.string().min(1),
  name: z.string().min(1).max(30),
});

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(30).optional(),
  voice_id: z.string().min(1).optional(),
  personality_sliders: z
    .object({
      warmth: z.number().min(0).max(100).optional(),
      humor: z.number().min(0).max(100).optional(),
      directness: z.number().min(0).max(100).optional(),
      energy: z.number().min(0).max(100).optional(),
      formality: z.number().min(0).max(100).optional(),
    })
    .optional(),
});

const ResolveSuggestionSchema = z.object({
  memory_id: z.string().min(1),
  action: z.enum(["apply", "dismiss"]),
});

export async function characterRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/characters/create — standalone companion creation
  // (post-onboarding "Add companion" flow).
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
      const character = await createCompanion({
        ...parsed.data,
        user_id: getUserId(request),
      });
      return reply.status(201).send({
        success: true,
        data: { character_id: character._id.toString(), ...character },
      });
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

  // GET /api/v1/characters — the caller's active companions, with each one's
  // highest-signal memory snippet for the home screen card.
  //
  // This replaces GET /characters/user/:user_id. A user id in the path was a
  // parameter for reading someone else's companions; the only correct value is
  // the one already in the token, so the segment is gone rather than checked.
  app.get("/", async (request, reply) => {
    const userId = getUserId(request);

    const characters = await Character.find({
      user_id: userId,
      mode: "companion",
      is_active: true,
    })
      .sort({ last_interaction_at: -1 })
      .lean();

    // `last_accessed_at` defaults to creation time, so a single sort satisfies
    // "most recently accessed, or most recently created if none has been
    // accessed."
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
          // The edit screen initialised its sliders to hardcoded defaults
          // because this was never sent. Any edit then saved those defaults
          // over the companion's real personality.
          personality_sliders: c.personality_sliders,
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
  });

  // GET /api/v1/characters/:id
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params;
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

    // Scoped by user_id in the query itself rather than fetched-then-checked:
    // there is no window in which the wrong document is in memory, and someone
    // else's id is indistinguishable from a nonexistent one.
    const character = await Character.findOne({ _id: id, user_id: userId }).lean();
    if (!character) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }
    return reply.send({ success: true, data: character });
  });

  // PATCH /api/v1/characters/:id — rename, change voice, retune personality.
  //
  // Archetype is deliberately not editable: it determines persona_config, and
  // swapping it under an existing companion would rewrite its personality while
  // keeping all the memories of the old one, which reads as the companion
  // having been replaced by a stranger.
  app.patch<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params;
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

    const parsed = UpdateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
        code: "VALIDATION_ERROR",
      });
    }

    const { name, voice_id, personality_sliders } = parsed.data;
    if (!name && !voice_id && !personality_sliders) {
      return reply.status(400).send({ success: false, error: "Nothing to update" });
    }

    if (voice_id && !getVoice(voice_id)) {
      return reply.status(400).send({
        success: false,
        error: "voice_id does not exist in the voice catalog",
        code: "VALIDATION_ERROR",
        field: "voice_id",
      });
    }

    // Sliders are merged field-by-field so a partial update does not silently
    // reset the four values the client did not send.
    const update: Record<string, unknown> = {};
    if (name) update["name"] = name.trim();
    if (voice_id) update["voice_id"] = voice_id;
    for (const [key, value] of Object.entries(personality_sliders ?? {})) {
      if (value !== undefined) update[`personality_sliders.${key}`] = value;
    }

    const updated = await Character.findOneAndUpdate(
      { _id: id, user_id: userId },
      { $set: update },
      { new: true },
    ).lean();

    if (!updated) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

    // The conversation pipeline caches persona_config and sliders in Redis, so
    // without this the change would not reach the model until the cache expired.
    await invalidateCharacterConfig(id);

    return reply.send({ success: true, data: updated });
  });

  // GET /api/v1/characters/:id/suggestion — the one adjustment worth offering,
  // or null. See adaptation.service.ts for why this is an offer and not a drift.
  //
  // Reading is what starts the weekly cooldown, so a client must not poll this
  // speculatively — it is fetched when the user opens the companion profile.
  app.get<{ Params: { id: string } }>("/:id/suggestion", async (request, reply) => {
    const suggestion = await getSuggestion(getUserId(request), request.params.id);
    return reply.send({ success: true, data: { suggestion } });
  });

  // POST /api/v1/characters/:id/suggestion — answer it.
  //
  // One route for both answers rather than two: "apply" and "dismiss" differ
  // only in whether the slider moves, and both retire the memory.
  app.post<{ Params: { id: string } }>("/:id/suggestion", async (request, reply) => {
    const parsed = ResolveSuggestionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
        code: "VALIDATION_ERROR",
      });
    }

    const result = await resolveSuggestion(
      getUserId(request),
      request.params.id,
      parsed.data.memory_id,
      parsed.data.action,
    );

    // No outstanding offer matching that memory — a stale screen, or a second
    // tap. 409 rather than 200 so the client knows to refetch instead of
    // believing a change happened.
    if (!result) {
      return reply.status(409).send({
        success: false,
        error: "That suggestion is no longer outstanding",
        code: "SUGGESTION_STALE",
      });
    }

    return reply.send({
      success: true,
      data: { personality_sliders: result.sliders },
    });
  });

  // DELETE /api/v1/characters/:id — soft delete.
  //
  // Soft, unlike account deletion: the memories and transcripts belong to a
  // relationship the user may want back, and "delete this companion" is not the
  // same request as "forget me". Account deletion still hard-deletes everything.
  app.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params;
    if (!Types.ObjectId.isValid(id)) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

    const updated = await Character.findOneAndUpdate(
      { _id: id, user_id: userId, is_active: true },
      { $set: { is_active: false } },
      { new: true },
    )
      .select("_id")
      .lean();

    if (!updated) {
      return reply.status(404).send({ success: false, error: "Character not found" });
    }

    await invalidateCharacterConfig(id);
    return reply.send({ success: true, data: { character_id: id, is_active: false } });
  });
}
