import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { User } from "../models/user.model.js";
import { Character } from "../models/character.model.js";
import { Session } from "../models/session.model.js";
import { Memory } from "../models/memory.model.js";
import { getArchetypeConfig } from "../data/archetypes.js";
import {
  createCompanion,
  CompanionValidationError,
} from "../services/character.service.js";
import { deleteAccount, exportAccount } from "../services/account.service.js";
import { revokeAllSessions } from "../services/auth.service.js";
import { getUserId } from "../middleware/auth.js";
import { isMinorNow, isUnderMinimumAge, MIN_AGE_YEARS } from "../utils/age.js";
import { logger } from "../utils/logger.js";
import type { OnboardResponse } from "../types/user.types.js";

// Note there is no `user_id` here any more. Identity comes from the verified
// token, never from the request body — a user id the client supplies is not a
// claim we can check, it is just a parameter for reading someone else's data.
const OnboardBodySchema = z.object({
  display_name: z.string().min(1).max(50),
  gender: z.enum(["male", "female", "nonbinary", "undisclosed"]),
  date_of_birth: z.string().refine((v) => !isNaN(Date.parse(v)), {
    message: "date_of_birth must be a valid ISO date string",
  }),
  communication_style: z.enum(["warm", "direct", "funny", "calm"]),
  intent: z.string().min(1),
  companion: z.object({
    name: z.string().min(1).max(30),
    archetype: z.enum(["mentor", "bestfriend", "challenger", "partner"]),
    gender: z.enum(["male", "female", "nonbinary"]),
    voice_id: z.string().min(1),
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
});

const UpdateMeSchema = z.object({
  display_name: z.string().min(1).max(50).optional(),
  communication_style: z.enum(["warm", "direct", "funny", "calm"]).optional(),
  gender: z.enum(["male", "female", "nonbinary", "undisclosed"]).optional(),
});

// Deleting an account is irreversible and cascades across six collections, so
// it takes an explicit confirmation string rather than being a bare DELETE that
// a mis-wired button could fire.
const DeleteMeSchema = z.object({ confirm: z.literal("DELETE") });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/users/onboard
  //
  // The user document already exists — sign-in created it. This completes the
  // profile and creates the first companion. Calling it twice is rejected
  // rather than silently creating a second companion.
  app.post("/onboard", async (request, reply) => {
    const userId = getUserId(request);

    const parsed = OnboardBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors.map((e) => e.message).join(", "),
      });
    }

    const body = parsed.data;
    const dob = new Date(body.date_of_birth);

    if (isUnderMinimumAge(dob)) {
      return reply.status(403).send({
        success: false,
        error: `You must be at least ${MIN_AGE_YEARS} to use Evarna.`,
        code: "UNDER_MINIMUM_AGE",
      });
    }

    const existing = await User.findById(userId).select("onboarding_completed").lean();
    if (!existing) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }
    if (existing.onboarding_completed) {
      return reply.status(409).send({
        success: false,
        error: "Onboarding is already complete",
        code: "ALREADY_ONBOARDED",
      });
    }

    const isMinor = isMinorNow(dob);

    // Profile is written first so createCompanion's minor check reads the real
    // date of birth rather than the empty stub.
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          display_name: body.display_name,
          gender: body.gender,
          date_of_birth: dob,
          is_minor: isMinor,
          communication_style: body.communication_style,
        },
      },
    );

    const archetypeDef = getArchetypeConfig(body.companion.archetype);

    // Onboard preserves its archetype-tuned defaults (different from the
    // flat 50/50/50/50/50 the standalone /characters/create uses).
    const sliders = {
      ...archetypeDef.default_sliders,
      ...body.companion.personality_sliders,
    };

    try {
      const character = await createCompanion({
        user_id: userId,
        archetype: body.companion.archetype,
        gender: body.companion.gender,
        voice_id: body.companion.voice_id || archetypeDef.default_voice_id,
        name: body.companion.name,
        personality_sliders: sliders,
      });

      // Only now is onboarding complete. If companion creation failed we leave
      // the flag false so the client can retry, rather than rolling back the
      // profile — the profile is valid data and there is no user to delete any
      // more now that sign-in owns creation.
      await User.updateOne({ _id: userId }, { $set: { onboarding_completed: true } });

      const response: OnboardResponse = {
        user_id: userId,
        character_id: character._id.toString(),
        is_minor: isMinor,
      };

      return reply.status(201).send({ success: true, data: response });
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

  // GET /api/v1/users/me/stats — aggregate counts across the user's companions
  app.get("/me/stats", async (request, reply) => {
    const userId = getUserId(request);

    const user = await User.findById(userId).select("created_at").lean();
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }

    const [total_companions, sessionAgg, total_memories] = await Promise.all([
      Character.countDocuments({
        user_id: userId,
        mode: "companion",
        is_active: true,
      }),
      Session.aggregate<{ total_sessions: number; total_voice_minutes: number }>([
        { $match: { user_id: userId } },
        {
          $group: {
            _id: null,
            total_sessions: { $sum: 1 },
            total_voice_minutes: { $sum: "$voice_minutes_consumed" },
          },
        },
      ]),
      Memory.countDocuments({ user_id: userId, is_deleted: false }),
    ]);

    const totals = sessionAgg[0] ?? { total_sessions: 0, total_voice_minutes: 0 };

    return reply.send({
      success: true,
      data: {
        total_companions,
        total_sessions: totals.total_sessions,
        total_voice_minutes: totals.total_voice_minutes,
        total_memories,
        member_since: user.created_at.toISOString(),
      },
    });
  });

  // GET /api/v1/users/me/export — everything we hold, as JSON.
  // Google requires a data export path; Apple expects one for the same reasons.
  app.get("/me/export", async (request, reply) => {
    const data = await exportAccount(getUserId(request));
    return reply
      .header("Content-Disposition", 'attachment; filename="evarna-export.json"')
      .send({ success: true, data });
  });

  // PATCH /api/v1/users/me
  app.patch("/me", async (request, reply) => {
    const userId = getUserId(request);
    const parsed = UpdateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.status(400).send({ success: false, error: "Nothing to update" });
    }

    // date_of_birth is deliberately not editable. It gates access and content
    // restrictions, so letting a user change it at will would make both
    // meaningless. Corrections are a support path, not a self-serve one.
    const updated = await User.findByIdAndUpdate(
      userId,
      { $set: parsed.data },
      { new: true },
    )
      .select("display_name gender communication_style email onboarding_completed")
      .lean();

    if (!updated) return reply.status(404).send({ success: false, error: "User not found" });
    return reply.send({ success: true, data: updated });
  });

  // DELETE /api/v1/users/me — in-app account deletion (App Store 5.1.1(v))
  app.delete("/me", async (request, reply) => {
    const userId = getUserId(request);
    const parsed = DeleteMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: 'Send { "confirm": "DELETE" } to confirm.',
        code: "CONFIRMATION_REQUIRED",
      });
    }

    // Revoke before deleting so a token that races the delete cannot be used
    // against a half-deleted account.
    await revokeAllSessions(userId).catch((err) =>
      logger.error({ err, userId }, "deleteAccount: revoke before delete failed"),
    );

    const counts = await deleteAccount(userId);
    return reply.send({ success: true, data: { deleted: true, ...counts } });
  });

  // GET /api/v1/users/me
  app.get("/me", async (request, reply) => {
    const userId = getUserId(request);
    const user = await User.findById(userId).select("-provider_sub -token_version").lean();
    if (!user) {
      return reply.status(404).send({ success: false, error: "User not found" });
    }
    // is_minor on the document is a stale snapshot; the derived value is the
    // one anything should act on.
    return reply.send({
      success: true,
      data: { ...user, is_minor: isMinorNow(user.date_of_birth) },
    });
  });
}
