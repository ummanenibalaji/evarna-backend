import { Schema, model, type Types } from "mongoose";
import { logger } from "../utils/logger.js";
import type {
  IFollowUp,
  FollowUpType,
  RawFollowUpHint,
} from "../types/follow-up.types.js";

/**
 * Why a flat collection when MemorySummary.follow_up_hints[] already exists.
 *
 * The scheduler asks one question: "which hints are pending and due right now?"
 * Against an embedded array that means $unwind over every summary document —
 * an index on the parent cannot cover the status/date of an array element, so
 * the query degrades to a collection scan that grows with total summaries
 * rather than with pending work. A flat doc with { status, trigger_date } is a
 * single indexed range scan.
 *
 * The embedded array stays exactly where it is: it is the summariser's own
 * record of what it produced for that window. This collection is the work
 * queue. Two different jobs — duplicating a few strings is cheaper than
 * contorting either structure into doing both.
 */
const followUpSchema = new Schema<IFollowUp>(
  {
    user_id: { type: String, required: true, index: true },
    character_id: { type: Schema.Types.ObjectId, ref: "Character", required: true },
    // Where this hint came from — extraction knows the session directly, the
    // summariser attributes it to the last session in the window it covered.
    session_id: { type: Schema.Types.ObjectId, ref: "Session", required: true },
    hint: { type: String, required: true },
    trigger_date: { type: Date, required: true },
    type: {
      type: String,
      enum: ["event_follow_up", "check_in", "milestone"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "expired", "suppressed"],
      default: "pending",
    },
    sent_at: { type: Date, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// The scheduler's only query: pending and due.
followUpSchema.index({ status: 1, trigger_date: 1 });
followUpSchema.index({ user_id: 1, status: 1 });

export const FollowUp = model<IFollowUp>("FollowUp", followUpSchema);

const VALID_TYPES: FollowUpType[] = ["event_follow_up", "check_in", "milestone"];
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DELAY_MS = 24 * HOUR_MS;
const MAX_HORIZON_MS = 30 * 24 * HOUR_MS;
/** More than three follow-ups out of one conversation is the model padding. */
const MAX_PER_SESSION = 3;

/**
 * trigger_date arrives as whatever the model felt like emitting: absent, "next
 * week", a date in 2023, or a valid ISO string. Trusting it means the hint
 * either fires the instant the scheduler next runs (past date) or never
 * (unparseable → Invalid Date → never matches a $lte). Both failure modes are
 * silent, so anything not a real future date becomes +24h, and anything absurdly
 * far out is clamped to +30d.
 */
function normalizeTriggerDate(raw: string | undefined, now: number): Date {
  const parsed = raw ? Date.parse(raw) : NaN;
  if (Number.isNaN(parsed) || parsed <= now) return new Date(now + DEFAULT_DELAY_MS);
  return new Date(Math.min(parsed, now + MAX_HORIZON_MS));
}

/**
 * ponytail: this write helper lives next to the model instead of a
 * follow-up.service.ts — it is one insert with input scrubbing and has two
 * callers. Move it out when something needs to read or transition follow-ups
 * (the scheduler will).
 */
export async function saveFollowUps(
  hints: RawFollowUpHint[] | undefined,
  ctx: {
    user_id: string;
    character_id: Types.ObjectId;
    session_id: Types.ObjectId;
  }
): Promise<void> {
  // Never break the job we are embedded in — these are best-effort writes.
  try {
    if (!Array.isArray(hints)) return;

    const now = Date.now();
    const docs = hints
      .filter((h) => typeof h?.hint === "string" && h.hint.trim().length > 0)
      .slice(0, MAX_PER_SESSION)
      .map((h) => ({
        ...ctx,
        hint: h.hint!.trim(),
        trigger_date: normalizeTriggerDate(h.trigger_date, now),
        // Coerce rather than drop or throw: an unknown type is still a usable
        // hint, and enum validation failing inside a background job loses all
        // of them.
        type: (VALID_TYPES.includes(h.type as FollowUpType)
          ? h.type
          : "check_in") as FollowUpType,
        status: "pending" as const,
        sent_at: null,
        created_at: new Date(now),
      }));

    if (docs.length === 0) return;

    await FollowUp.insertMany(docs, { ordered: false });
    logger.info(
      { sessionId: String(ctx.session_id), count: docs.length },
      "Follow-ups queued"
    );
  } catch (err) {
    logger.error(
      { err, sessionId: String(ctx.session_id) },
      "Failed to queue follow-ups"
    );
  }
}
