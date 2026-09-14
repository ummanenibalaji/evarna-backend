/**
 * One gate for everything that costs money.
 *
 * Until now nothing was metered or enforced: `voice_minutes_consumed` was
 * written at session end and never read as a limit, and there was no free-tier
 * cap anywhere in the codebase. A voice minute costs roughly $0.085 all-in, so
 * a single account talking continuously outruns any subscription price we
 * could charge. `canStart(userId, kind)` is the one function that decides, and
 * both session-start routes and the chat send route call it.
 *
 * Two halves, deliberately separated:
 *
 *   - Pure functions (periods, tiers, the decision itself). No database, no
 *     clock of their own — every one takes `now`. `check:entitlement` exercises
 *     these offline, which is where the expensive mistakes live: a period that
 *     drifts, or an allowance that resets twice in a month.
 *   - The I/O half, which gathers a snapshot and hands it to `decide()`.
 *
 * Usage in this step is DERIVED from session and turn rows rather than counted
 * incrementally. Deriving is slower but it cannot silently disagree with the
 * source data, and the counters that replace it land in the next step — at
 * which point only `getEntitlementSnapshot` changes.
 */
import { Subscription } from "../models/subscription.model.js";
import { Session } from "../models/session.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { User } from "../models/user.model.js";
import { PLANS, TIERS, TOPUP_PACKS } from "../data/tiers.js";
import { localDayKey, shiftDay } from "./activity.service.js";
import { logger } from "../utils/logger.js";
import type { FastifyReply } from "fastify";
import type {
  BillingPeriod,
  CanStartRefused,
  CanStartResult,
  EntitlementSnapshot,
  EntitlementView,
  ISubscription,
  StartKind,
  Tier,
  TierAllowance,
} from "../types/billing.types.js";

/** A read that outlives this is a database in trouble; the gate fails open. */
const READ_DEADLINE_MS = 2_000;

/**
 * Ceiling on what ONE session can bill: the time that has actually elapsed
 * since it started.
 *
 * `/sessions/:id/end` takes `ended_at` from the client and uses it verbatim, so
 * a forged future timestamp can claim any duration at all. `started_at` is
 * server-set and the clock is ours, so elapsed time is a true upper bound on
 * how long anyone can have been talking — and unlike a flat ceiling it does not
 * hand out a free allowance to whoever stays on the longest call. A flat hour
 * here meant one never-ended call billed 60 minutes no matter how long it ran,
 * which is roughly $51 of TTS for an eight-minute free tier.
 */
const elapsedSecondsExpr = (now: Date): object => ({
  $max: [0, { $floor: { $divide: [{ $subtract: [now, "$started_at"] }, 1000] } }],
});

/**
 * How much of a sweep-closed session's duration is assumed to be idle.
 *
 * The 30-minute stale sweep is the last-resort backstop: it closes a session
 * that is still `active` and has had no turn for half an hour, so its
 * `duration_seconds` is never a measurement of how long anyone talked — it
 * includes at least that idle half hour. Billing the whole thing would zero an
 * 8-minute free allowance because our own worker restarted; billing a flat
 * token amount would let someone talk for an hour, force-quit the app, and pay
 * five minutes for it — repeatedly.
 *
 * So subtract the idle window and bill the rest: a 31-minute swept session
 * (a 1-minute call, then silence) bills a minute, and a 45-minute one bills
 * fifteen. Errs toward the user on data we know is untrustworthy, without
 * making abandonment a discount.
 *
 * MIRRORS stale-session.service.ts's IDLE_TIMEOUT_MS. If that changes, change
 * this: too small over-bills abandoned calls, too large under-bills real ones.
 * All of it goes away when Lane A lands M-03 (an accurate duration on every
 * exit path), at which point `interrupted` bills like `completed`.
 */
const SWEEP_IDLE_SECONDS = 30 * 60;

/**
 * Ceiling on a call still connected.
 *
 * Generous on purpose: a live call should burn the balance in real time, so
 * that the NEXT one is refused. It exists only so a session wrongly left
 * `active` cannot accrue without limit — and the stale sweep closes one of
 * those within about 35 minutes anyway, after which it bills as a swept call.
 */
const MAX_IN_FLIGHT_SECONDS = 6 * 60 * 60;

/**
 * How far back the usage query looks for calls that are still connected. A live
 * call that began before this period started still burns minutes now, but an
 * unbounded lower bound would scan a heavy user's entire session history on
 * every call start.
 */
const ACTIVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure: billing periods
//
// Everything here is UTC. Periods are contractual and both stores report in
// UTC, and anchoring them to a device timezone would hand anyone who flies east
// a second allowance. (The DAILY message cap is the opposite case — see
// localDayBounds — because "today" is a human experience, not a contract.)
// ─────────────────────────────────────────────────────────────────────────────

export function daysInUTCMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `anchor` plus `months`, clamped to the length of the target month, keeping the
 * anchor's time of day.
 *
 * Always measured from the ORIGINAL anchor, never by stepping month to month:
 * clamping 31 January to 28 February and then adding a month again would give
 * 28 March and the billing day would creep earlier forever. From the anchor,
 * 31 Jan → 28 Feb → 31 Mar.
 */
export function addMonthsClamped(anchor: Date, months: number): Date {
  // Date.UTC normalises a month index outside 0-11, so no year maths is needed.
  const target = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1));
  const day = Math.min(
    anchor.getUTCDate(),
    daysInUTCMonth(target.getUTCFullYear(), target.getUTCMonth()),
  );
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** Whole billing months between `anchor` and `now`. Arithmetic, not a loop. */
export function monthsElapsed(anchor: Date, now: Date): number {
  let months =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  // The calendar month difference overshoots when `now` has not yet reached the
  // anchor's day-of-month (clamped) within that month.
  if (now.getTime() < addMonthsClamped(anchor, months).getTime()) months -= 1;
  return Math.max(0, months);
}

/**
 * The period containing `now`, counted from `anchor`.
 *
 * Contiguous by construction — one period's end is the next one's start — so
 * there is never a gap that grants a free minute, nor an overlap that takes one.
 */
export function currentPeriod(anchor: Date, now: Date): { start: Date; end: Date } {
  const elapsed = monthsElapsed(anchor, now);
  return {
    start: addMonthsClamped(anchor, elapsed),
    end: addMonthsClamped(anchor, elapsed + 1),
  };
}

type SubscriptionLike = Pick<
  ISubscription,
  "tier" | "status" | "expires_at" | "period_start" | "topup_seconds"
>;

/**
 * The tier actually in force right now.
 *
 * `cancelled` still gets the tier: auto-renew is off but the period they paid
 * for has not ended, and taking it away early is theft. `grace` gets it too —
 * that is the store retrying a payment, not a lapse. A null `expires_at` on an
 * active row means a perpetual grant (only the dev script makes those).
 */
export function effectiveTier(sub: SubscriptionLike | null | undefined, now: Date): Tier {
  if (!sub || sub.tier === "free") return "free";
  // A tier this build does not know about is not a tier. Enums are validated on
  // write, so a row from another build can carry anything, and honouring it
  // would mean an unpriced allowance.
  if (!Object.hasOwn(TIERS, sub.tier)) {
    logger.error({ tier: sub.tier }, "entitlement: subscription has an unknown tier — free");
    return "free";
  }
  const entitledStatus =
    sub.status === "active" || sub.status === "grace" || sub.status === "cancelled";
  if (!entitledStatus) return "free";
  if (sub.expires_at && sub.expires_at.getTime() <= now.getTime()) return "free";
  return sub.tier;
}

/**
 * Which window the allowance is measured over.
 *
 * A paid subscription is anchored to its purchase instant, so the allowance
 * rolls monthly from the day they bought it. Note that this deliberately does
 * NOT use the store's `period_end`: an annual plan's store period is a year
 * long, but 400 minutes is a MONTHLY allowance, and honouring the store window
 * would hand an annual subscriber twelve months of minutes on day one.
 *
 * Everyone else — never purchased, or lapsed — is anchored to their signup
 * instant, which is the only date we have that does not move.
 */
export function resolvePeriod(
  sub: SubscriptionLike | null | undefined,
  userCreatedAt: Date,
  now: Date,
): BillingPeriod {
  const paid = effectiveTier(sub, now) !== "free";
  const candidate = paid && sub?.period_start ? sub.period_start : userCreatedAt;
  // An anchor in the future would put `now` before the period it belongs to, so
  // the usage query would match nothing and the allowance would look untouched.
  // A store row with a future period_start, or a clock-skewed created_at, is
  // enough to cause it.
  const anchor = candidate.getTime() > now.getTime() ? now : candidate;
  const { start, end } = currentPeriod(anchor, now);
  return { start, end, source: paid && sub?.period_start ? "subscription" : "signup_anniversary" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the user's local day, for the message cap
// ─────────────────────────────────────────────────────────────────────────────

/** Wall-clock offset from UTC in `timezone` at `at`, in milliseconds. */
export function offsetMsAt(timezone: string | null | undefined, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
    // Hour 24 appears in some locales' rendering of midnight.
    const hour = get("hour") % 24;
    const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    // Compared against whole seconds: the parts above have no millisecond
    // field, so subtracting the raw instant would report an offset up to 999ms
    // short for any `at` that carries milliseconds.
    return asUTC - (at.getTime() - at.getMilliseconds());
  } catch {
    // An unknown zone must not refuse someone their messages.
    return 0;
  }
}

/**
 * The instant range covering the user's current local day.
 *
 * The cap resets at the user's own midnight, not the server's: the pricing
 * decision says a hundred messages a day, and for someone in Kolkata a
 * UTC-midnight reset lands at 5:30 in the morning and cuts an evening short.
 *
 * Each boundary is computed with the offset in force at that boundary, so a DST
 * shift inside the day does not move it. The pathological case is a zone where
 * local midnight itself does not exist (clocks jump forward at 00:00, as in
 * Chile); there the boundary lands an hour out, which for a daily cap is
 * invisible.
 */
export function localDayBounds(
  timezone: string | null | undefined,
  now: Date,
): { start: Date; end: Date } {
  const midnight = (key: string): Date => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number];
    const naive = Date.UTC(y, m - 1, d);
    // Midday is far from any DST edge, so it gives a reliable first guess.
    const guess = offsetMsAt(timezone, new Date(Date.UTC(y, m - 1, d, 12)));
    const candidate = naive - guess;
    // Re-measure at the candidate instant and correct once if the zone was
    // mid-transition between the two.
    const actual = offsetMsAt(timezone, new Date(candidate));
    return new Date(actual === guess ? candidate : naive - actual);
  };

  const today = localDayKey(timezone, now);
  return { start: midnight(today), end: midnight(shiftDay(today, 1)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The allowance for a tier, tolerating a tier this build does not know.
 *
 * Mongoose validates an enum on write, not on read, so a row written by a
 * different build (or edited by hand) can carry anything. `TIERS[tier]` would
 * then be undefined and every call and message for that user would 500 —
 * outside the try/catch that is supposed to make this gate fail open.
 */
export function allowanceFor(tier: Tier): TierAllowance {
  // hasOwn, not `in` or a truthy check: `TIERS["constructor"]` is inherited
  // from Object.prototype, and treating that as an allowance would make every
  // limit NaN — which compares false against everything and fails OPEN.
  if (Object.hasOwn(TIERS, tier)) return TIERS[tier];
  logger.error({ tier }, "entitlement: unknown tier on a subscription — treating as free");
  return TIERS.free;
}

/**
 * Remaining voice seconds in this period.
 *
 * The top-up wallet is deliberately NOT added yet. Usage in this step is
 * derived per period, so it resets at every renewal — and a wallet added on top
 * of a resetting counter is re-granted every month, which would turn one $4.99
 * pack into an unlimited subscription. Making the wallet spendable needs a
 * record of what has been spent out of it, which is a write at session end and
 * arrives with the usage counters in the next step. Until then the balance is
 * carried and reported but not honoured, and nothing can buy one.
 */
export function remainingVoiceSeconds(snap: {
  tier: Tier;
  topup_seconds: number;
  voice_seconds_used: number;
}): number {
  return Math.max(0, allowanceFor(snap.tier).voice_seconds - snap.voice_seconds_used);
}

export function remainingMessagesToday(snap: {
  tier: Tier;
  messages_used_today: number;
}): number {
  return Math.max(0, allowanceFor(snap.tier).daily_messages - snap.messages_used_today);
}

export function decide(
  snap: EntitlementSnapshot,
  kind: StartKind,
  now: Date = new Date(),
): CanStartResult {
  const voice_seconds_remaining = remainingVoiceSeconds(snap);
  const messages_remaining_today = remainingMessagesToday(snap);
  const allow: CanStartResult = {
    allowed: true,
    tier: snap.tier,
    voice_seconds_remaining,
    messages_remaining_today,
  };

  // Numbers we could not read are not grounds to refuse. A Mongo blip would
  // otherwise stop every call and every message in the product at once, and the
  // downside here is a handful of free minutes.
  if (snap.degraded) return allow;

  if (kind === "voice") {
    // Concurrency is deliberately NOT decided here. No tier sells "two calls at
    // once", so it is an abuse ceiling rather than a plan limit, and
    // usage.service.ts owns it — deciding it in both places meant two queries
    // and two different codes for one rule. What this snapshot still does is
    // count a live call's seconds as they run (see aggregateVoiceUsage), which
    // is what stops simultaneous calls from being free.
    if (voice_seconds_remaining <= 0) {
      return {
        allowed: false,
        code: "VOICE_MINUTES_EXHAUSTED",
        status: 402,
        error: "You've used all your voice minutes for this month.",
        tier: snap.tier,
        voice_seconds_remaining: 0,
        renews_at: snap.period.end.toISOString(),
      };
    }

    return allow;
  }

  if (messages_remaining_today <= 0) {
    const retry = Math.max(
      1,
      Math.ceil((snap.messages_reset_at.getTime() - now.getTime()) / 1000),
    );
    return {
      allowed: false,
      code: "DAILY_MESSAGE_CAP",
      status: 429,
      error: "You've reached today's message limit. It resets at midnight.",
      tier: snap.tier,
      voice_seconds_remaining,
      renews_at: snap.period.end.toISOString(),
      retry_after_seconds: retry,
    };
  }

  return allow;
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

interface VoiceUsageRow {
  used: number;
  in_flight: number;
  live: number;
}

/**
 * Billable voice seconds in a period, and what is in flight right now.
 *
 * Billable is not the same as recorded. Three cases, all of them load-bearing:
 *
 *   - `completed` bills its recorded duration, floored at 0 (a client can send
 *     an `ended_at` BEFORE the session started, which would mint minutes
 *     through the sum) and capped at the time actually elapsed since it started
 *     (it can also send one in the future).
 *   - `interrupted` means the stale sweep closed it, so at least the sweep's
 *     idle window is silence — see SWEEP_IDLE_SECONDS.
 *   - `active` is a call happening right now, billed as it runs. That is what
 *     stops simultaneous calls from being free and what makes the NEXT call
 *     refuse, since there is no mid-call cutoff yet.
 */
async function aggregateVoiceUsage(
  userId: string,
  period: BillingPeriod,
  now: Date,
): Promise<VoiceUsageRow> {
  // A live call that predates this period is still burning minutes, so early in
  // a period the lower bound reaches back a day to catch one. It never reaches
  // back further than that, so this cannot become a scan of every session the
  // user has ever had; later in the period the period start is earlier anyway
  // and the range is simply the period.
  const lowerBound = new Date(
    Math.min(period.start.getTime(), now.getTime() - ACTIVE_LOOKBACK_MS),
  );

  const startedInPeriod = { $gte: ["$started_at", period.start] };
  const isActive = { $eq: ["$status", "active"] };
  const elapsed = elapsedSecondsExpr(now);

  // Seconds a still-connected call has spent INSIDE this period.
  const inFlightSeconds = {
    $min: [
      MAX_IN_FLIGHT_SECONDS,
      {
        $max: [
          0,
          {
            $floor: {
              $divide: [
                { $subtract: [now, { $max: ["$started_at", period.start] }] },
                1000,
              ],
            },
          },
        ],
      },
    ],
  };

  // What a closed session bills, bounded on both sides because
  // `/sessions/:id/end` takes `ended_at` from the client and uses it verbatim:
  // a timestamp before the session started gives a negative duration, which
  // would mint minutes through the sum, and one in the future would claim any
  // duration at all.
  const recordedSeconds = {
    $min: [elapsed, { $max: [0, { $ifNull: ["$duration_seconds", 0] }] }],
  };
  const sweptSeconds = { $max: [0, { $subtract: [recordedSeconds, SWEEP_IDLE_SECONDS] }] };

  const closedSeconds = {
    $cond: [
      // A closed session belongs to the period it started in. Single-sided, so
      // a call is never counted twice across a renewal.
      startedInPeriod,
      { $cond: [{ $eq: ["$status", "interrupted"] }, sweptSeconds, recordedSeconds] },
      0,
    ],
  };

  const rows = await Session.aggregate<VoiceUsageRow & { _id: null }>([
    {
      $match: {
        user_id: userId,
        session_type: { $in: ["voice_call", "voice_note"] },
        started_at: { $gte: lowerBound, $lt: period.end },
      },
    },
    {
      $group: {
        _id: null,
        used: { $sum: { $cond: [isActive, inFlightSeconds, closedSeconds] } },
        in_flight: { $sum: { $cond: [isActive, inFlightSeconds, 0] } },
        live: { $sum: { $cond: [isActive, 1, 0] } },
      },
    },
  ]).option({ maxTimeMS: READ_DEADLINE_MS });

  const row = rows[0];
  return {
    used: Math.round(row?.used ?? 0),
    in_flight: Math.round(row?.in_flight ?? 0),
    live: row?.live ?? 0,
  };
}

/** A free period starting now, used when the reads failed. */
function degradedSnapshot(userId: string, now: Date): EntitlementSnapshot {
  const { start, end } = currentPeriod(now, now);
  const day = localDayBounds(null, now);
  return {
    user_id: userId,
    tier: "free",
    status: "none",
    platform: "none",
    auto_renew: false,
    expires_at: null,
    period: { start, end, source: "signup_anniversary" },
    voice_seconds_used: 0,
    voice_seconds_in_flight: 0,
    live_voice_sessions: 0,
    topup_seconds: 0,
    messages_used_today: 0,
    messages_reset_at: day.end,
    degraded: true,
  };
}

/**
 * Everything the decision needs, in two sequential hops: the subscription and
 * the user together, then usage (which needs the period the first hop resolves).
 *
 * Not cached in Redis. The auth hook already does a `User.findById` on every
 * request, and two more indexed reads are noise next to the LLM call this gate
 * stands in front of — while a cache would add an invalidation bug exactly at
 * the moment someone pays us money.
 */
export async function getEntitlementSnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<EntitlementSnapshot> {
  try {
    const [sub, user] = await Promise.all([
      Subscription.findOne({ user_id: userId })
        .select("tier status platform product_id expires_at period_start auto_renew topup_seconds")
        .maxTimeMS(READ_DEADLINE_MS)
        .lean(),
      User.findById(userId).select("created_at timezone").maxTimeMS(READ_DEADLINE_MS).lean(),
    ]);

    const tier = effectiveTier(sub, now);
    // A user this gate cannot find has just been deleted mid-request; anchoring
    // to `now` gives them a free period rather than a crash.
    const period = resolvePeriod(sub, user?.created_at ?? now, now);
    const day = localDayBounds(user?.timezone ?? null, now);

    const [voice, messagesToday] = await Promise.all([
      aggregateVoiceUsage(userId, period, now),
      // role: "user" matters. The companion's own proactive messages are
      // persisted as assistant turns, and counting those would let outreach
      // spend the user's daily cap for them.
      ConversationTurn.countDocuments({
        user_id: userId,
        role: "user",
        created_at: { $gte: day.start, $lt: day.end },
      }).maxTimeMS(READ_DEADLINE_MS),
    ]);

    return {
      user_id: userId,
      tier,
      // Reported as expired once the expiry has passed, rather than echoing the
      // row's own "active". The row is what the store last told us and it is
      // not wrong — a renewal simply has not been observed — but answering
      // `tier: "free", status: "active"` reads as a live subscription with no
      // allowance, and the app would show "Renews on" for a plan that lapsed.
      status:
        sub && sub.expires_at && sub.expires_at.getTime() <= now.getTime()
          ? "expired"
          : sub?.status ?? "none",
      platform: sub?.platform ?? "none",
      auto_renew: sub?.auto_renew ?? false,
      expires_at: sub?.expires_at ?? null,
      period,
      voice_seconds_used: voice.used,
      voice_seconds_in_flight: voice.in_flight,
      live_voice_sessions: voice.live,
      topup_seconds: sub?.topup_seconds ?? 0,
      messages_used_today: messagesToday,
      messages_reset_at: day.end,
      degraded: false,
    };
  } catch (err) {
    logger.error({ err, userId }, "entitlement: could not read usage — allowing through");
    return degradedSnapshot(userId, now);
  }
}

/**
 * The gate. Both session-start routes and the chat send route call this before
 * spending anything.
 */
export async function canStart(
  userId: string,
  kind: StartKind,
  now: Date = new Date(),
): Promise<CanStartResult> {
  const snapshot = await getEntitlementSnapshot(userId, now);
  try {
    return decide(snapshot, kind, now);
  } catch (err) {
    // `decide` is pure and should not be able to throw, which is exactly why a
    // throw here must not become a 500 on the send and call paths. Fail open
    // for the same reason the snapshot does.
    logger.error({ err, userId, kind }, "entitlement: decision failed — allowing through");
    return decide(degradedSnapshot(userId, now), kind, now);
  }
}

/**
 * Send a refusal, in the shape every other refusal in this API uses.
 *
 * It has to be an explicit reply rather than a thrown error: the global error
 * handler rebuilds the body and drops `code` (middleware/error-handler.ts), and
 * `code` is the only part of this the app can branch on — a 402 with no code
 * would reach the paywall as "something went wrong".
 */
export function refuse(reply: FastifyReply, refusal: CanStartRefused): FastifyReply {
  if (refusal.retry_after_seconds) {
    reply.header("Retry-After", String(refusal.retry_after_seconds));
  }
  return reply.status(refusal.status).send({
    success: false,
    error: refusal.error,
    code: refusal.code,
    // Enough for the paywall to say what it is offering without a second call.
    tier: refusal.tier,
    voice_seconds_remaining: refusal.voice_seconds_remaining,
    renews_at: refusal.renews_at,
  });
}

/** The snapshot as the app wants to read it. */
export function toEntitlementView(snap: EntitlementSnapshot): EntitlementView {
  const allowance = allowanceFor(snap.tier);
  return {
    tier: snap.tier,
    tier_label: allowance.label,
    status: snap.status,
    platform: snap.platform,
    auto_renew: snap.auto_renew,
    expires_at: snap.expires_at?.toISOString() ?? null,
    voice: {
      allowance_seconds: allowance.voice_seconds,
      // Reported but not yet spendable — see remainingVoiceSeconds.
      topup_seconds: snap.topup_seconds,
      used_seconds: snap.voice_seconds_used,
      in_flight_seconds: snap.voice_seconds_in_flight,
      remaining_seconds: remainingVoiceSeconds(snap),
    },
    text: {
      daily_cap: allowance.daily_messages,
      used_today: snap.messages_used_today,
      remaining_today: remainingMessagesToday(snap),
      resets_at: snap.messages_reset_at.toISOString(),
    },
    period: {
      start: snap.period.start.toISOString(),
      end: snap.period.end.toISOString(),
      renews_at: snap.period.end.toISOString(),
      source: snap.period.source,
    },
    // Served rather than hardcoded in the client, which is how the app came to
    // advertise 500 minutes for a 400-minute tier and a renewal date in June.
    plans: PLANS,
    topup_packs: TOPUP_PACKS,
    degraded: snap.degraded,
  };
}
