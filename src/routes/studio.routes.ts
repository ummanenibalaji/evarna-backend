import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Character } from "../models/character.model.js";
import { SCENARIOS, SCENARIO_IDS } from "../data/scenarios.js";
import {
  createStudioCharacter,
  CompanionValidationError,
} from "../services/character.service.js";
import { getUserId } from "../middleware/auth.js";

/**
 * Studio characters count separately from companions — filling your companion
 * slots must not lock you out of Studio, which is a paid feature in its own
 * right.
 *
 * ponytail: one flat cap rather than per-tier numbers. The tier limits belong
 * to the entitlement service (Sanjeev's lane) and do not exist yet; this is
 * only here so a script cannot create ten thousand characters in the meantime.
 * When the entitlement gate lands, this check moves behind it and this constant
 * goes away.
 */
const STUDIO_CHARACTER_CAP = 20;

// The client picks a scenario and answers its questions. It never sends prompt
// text — buildPersona() on the server turns these into a persona.
const CreateStudioSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scenario"),
    scenario_id: z.enum(SCENARIO_IDS as [string, ...string[]]),
    // Values are validated per-scenario in createStudioCharacter, which is the
    // only place that knows which keys a given scenario expects.
    params: z.record(z.string()).default({}),
    voice_id: z.string().min(1),
    gender: z.enum(["male", "female", "nonbinary"]),
  }),
  z.object({
    kind: z.literal("custom"),
    name: z.string().min(1).max(30),
    backstory: z.string().max(500).optional(),
    voice_id: z.string().min(1),
    gender: z.enum(["male", "female", "nonbinary"]),
    personality_sliders: z
      .object({
        warmth: z.number().min(0).max(100).optional(),
        humor: z.number().min(0).max(100).optional(),
        directness: z.number().min(0).max(100).optional(),
        energy: z.number().min(0).max(100).optional(),
        formality: z.number().min(0).max(100).optional(),
      })
      .optional(),
  }),
]);

export async function studioRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/studio/scenarios — the catalog and each scenario's setup fields.
  //
  // Served rather than hardcoded in the app so the setup form and the persona
  // that consumes it can never drift apart: both come from the same definition.
  app.get("/scenarios", async (_request, reply) => {
    const data = Object.values(SCENARIOS).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      params: s.params,
    }));
    return reply.send({ success: true, data });
  });

  // GET /api/v1/studio/characters — the caller's studio characters.
  app.get("/characters", async (request, reply) => {
    const userId = getUserId(request);

    const characters = await Character.find({
      user_id: userId,
      mode: "studio",
      is_active: true,
    })
      .sort({ last_interaction_at: -1 })
      .select("name voice_id gender studio_config last_interaction_at total_sessions")
      .lean();

    return reply.send({
      success: true,
      data: {
        characters: characters.map((c) => ({
          _id: c._id.toString(),
          name: c.name,
          gender: c.gender,
          voice_id: c.voice_id,
          kind: c.studio_config?.kind ?? "custom",
          scenario_id: c.studio_config?.scenario_id ?? null,
          last_interaction_at: c.last_interaction_at,
          total_sessions: c.total_sessions,
        })),
      },
    });
  });

  // POST /api/v1/studio/characters — create a scenario run or a custom character.
  app.post("/characters", async (request, reply) => {
    const userId = getUserId(request);

    const parsed = CreateStudioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
        code: "VALIDATION_ERROR",
      });
    }

    const existing = await Character.countDocuments({
      user_id: userId,
      mode: "studio",
      is_active: true,
    });
    if (existing >= STUDIO_CHARACTER_CAP) {
      return reply.status(403).send({
        success: false,
        error: `You can have up to ${STUDIO_CHARACTER_CAP} Studio characters. Delete one to make room.`,
        code: "STUDIO_LIMIT_REACHED",
      });
    }

    try {
      const character = await createStudioCharacter({ ...parsed.data, user_id: userId });
      return reply.status(201).send({
        success: true,
        data: {
          character_id: character._id.toString(),
          name: character.name,
          mode: character.mode,
          kind: character.studio_config?.kind,
        },
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
}
