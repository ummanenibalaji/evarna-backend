import { Session } from "../models/session.model.js";
import { withinLimit } from "../utils/rate-limit.js";

// ── Server-side usage ceilings ───────────────────────────────────────────────
//
// Every reply is a paid model call and every call-minute is paid speech, so a
// signed-in script could previously run up an unlimited bill. These are abuse
// ceilings, not plan tiers: when entitlements land, per-tier numbers replace
// the defaults here and the enforcement points stay where they are.
//
// Env-overridable so they can be tuned without a deploy.

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const USAGE_LIMITS = {
  messagesPerMinute: intFromEnv("LIMIT_MESSAGES_PER_MINUTE", 20),
  messagesPerDay: intFromEnv("LIMIT_MESSAGES_PER_DAY", 400),
  sessionStartsPerHour: intFromEnv("LIMIT_SESSION_STARTS_PER_HOUR", 60),
  voiceMinutesPerDay: intFromEnv("LIMIT_VOICE_MINUTES_PER_DAY", 60),
  // ponytail: 2, not 1, so a call that crashed without ending does not block
  // the retry. Stale calls are closed by the 30-minute sweep.
  concurrentCalls: intFromEnv("LIMIT_CONCURRENT_CALLS", 2),
  companions: intFromEnv("LIMIT_COMPANIONS", 10),
} as const;

export type LimitName =
  | "messages_per_minute"
  | "messages_per_day"
  | "session_starts_per_hour"
  | "voice_minutes_per_day"
  | "concurrent_calls";

/** Rendered as a 429 with code USAGE_LIMIT_REACHED by the global error handler. */
export class UsageLimitError extends Error {
  constructor(readonly limit: LimitName, message: string) {
    super(message);
    this.name = "UsageLimitError";
  }
}

/** Spoken on either voice path when the day's minutes run out mid-call. */
export const VOICE_LIMIT_LINE =
  "We've hit today's limit for calls, so I have to go for now. We can pick this up tomorrow.";

const DAY_MS = 86_400_000;
const LIVE_CALL_WINDOW_MS = 3 * 60 * 60 * 1000;

export async function assertCanSendMessage(userId: string): Promise<void> {
  if (!(await withinLimit(`usage:msg:min:${userId}`, USAGE_LIMITS.messagesPerMinute, 60))) {
    throw new UsageLimitError("messages_per_minute", "You're sending messages very quickly. Give it a moment and try again.");
  }
  if (!(await withinLimit(`usage:msg:day:${userId}`, USAGE_LIMITS.messagesPerDay, 86_400))) {
    throw new UsageLimitError("messages_per_day", "You've reached today's message limit. It resets within 24 hours.");
  }
}

export async function assertCanStartSession(userId: string): Promise<void> {
  if (!(await withinLimit(`usage:start:${userId}`, USAGE_LIMITS.sessionStartsPerHour, 3600))) {
    throw new UsageLimitError("session_starts_per_hour", "Too many conversations started in the last hour. Try again shortly.");
  }
}

type CallRow = { started_at: Date; status: string; duration_seconds?: number };

/** Seconds of calling in `sessions`, counting a live call up to `now`. */
export function voiceSecondsUsed(sessions: CallRow[], now: Date): number {
  return sessions.reduce(
    (sum, s) =>
      sum +
      (s.status === "active"
        ? Math.max(0, (now.getTime() - new Date(s.started_at).getTime()) / 1000)
        : (s.duration_seconds ?? 0)),
    0,
  );
}

async function callsInLastDay(userId: string, now: Date): Promise<CallRow[]> {
  return Session.find({
    user_id: userId,
    session_type: "voice_call",
    started_at: { $gte: new Date(now.getTime() - DAY_MS) },
  })
    .select("started_at status duration_seconds")
    .lean<CallRow[]>();
}

/** Seconds of calling left in the rolling 24 hours, including any live call. */
export async function voiceSecondsRemaining(userId: string, now: Date = new Date()): Promise<number> {
  const used = voiceSecondsUsed(await callsInLastDay(userId, now), now);
  return Math.max(0, USAGE_LIMITS.voiceMinutesPerDay * 60 - used);
}

export async function assertCanStartCall(userId: string, now: Date = new Date()): Promise<void> {
  await assertCanStartSession(userId);
  const calls = await callsInLastDay(userId, now);
  const live = calls.filter(
    (c) => c.status === "active" && now.getTime() - new Date(c.started_at).getTime() < LIVE_CALL_WINDOW_MS,
  ).length;
  if (live >= USAGE_LIMITS.concurrentCalls) {
    throw new UsageLimitError("concurrent_calls", "You already have a call in progress. End it before starting another.");
  }
  if (voiceSecondsUsed(calls, now) >= USAGE_LIMITS.voiceMinutesPerDay * 60) {
    throw new UsageLimitError("voice_minutes_per_day", "You've used today's voice minutes. They reset within 24 hours.");
  }
}

