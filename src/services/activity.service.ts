/**
 * Real activity numbers: the streak, the week strip, the talk-time delta.
 *
 * All three were rendered from constants in the app's config file — a 12-day
 * streak, a personal best of 21, seven bars of invented minutes and "+18%" —
 * shown to every user on every launch. This is what they actually are.
 *
 * Everything is bucketed in the USER'S timezone, not the server's. A session at
 * 11pm in Kolkata is not the next day, and getting that wrong silently breaks
 * streaks for everyone east or west of wherever this happens to be deployed.
 */
import { Session } from "../models/session.model.js";
import { User } from "../models/user.model.js";

export interface Activity {
  /** Consecutive days up to today (or yesterday, if today is still empty). */
  streak_days: number;
  best_streak: number;
  /** Minutes talked, Monday first, for the current local week. */
  week_minutes: number[];
  week_total_minutes: number;
  prev_week_total_minutes: number;
  /** Days with at least one session, ever. Drives "nothing here yet" copy. */
  active_days: number;
}

/** "2026-08-22" in the given zone. Falls back to UTC for an unset timezone. */
export function localDayKey(timezone: string | null | undefined, at: Date): string {
  try {
    // en-CA renders as YYYY-MM-DD, which sorts and compares as a plain string.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    // An unknown zone must not take the whole screen down with it.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  }
}

/**
 * Day keys are calendar labels, not instants, so they are shifted through
 * Date.UTC deliberately — doing this in a real timezone would lose or repeat a
 * day twice a year at the DST boundary.
 */
export function shiftDay(key: string, deltaDays: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Monday-first week containing `key`. */
export function weekKeys(key: string, weeksAgo = 0): string[] {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  // getUTCDay: 0 = Sunday. This week starts on Monday.
  const offsetToMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const monday = shiftDay(key, -offsetToMonday - weeksAgo * 7);
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

/**
 * A streak survives today being empty — it is only broken by a full missed
 * day. Counting from today alone would show every user a streak of 0 until
 * their first session of the day, which reads as having lost it.
 */
export function computeStreaks(
  activeDays: ReadonlySet<string>,
  todayKey: string,
): { streak: number; best: number } {
  let streak = 0;
  let cursor = activeDays.has(todayKey) ? todayKey : shiftDay(todayKey, -1);
  while (activeDays.has(cursor)) {
    streak++;
    cursor = shiftDay(cursor, -1);
  }

  let best = 0;
  let run = 0;
  const sorted = [...activeDays].sort();
  for (let i = 0; i < sorted.length; i++) {
    const day = sorted[i]!;
    run = i > 0 && shiftDay(sorted[i - 1]!, 1) === day ? run + 1 : 1;
    if (run > best) best = run;
  }

  // The current streak is by definition a run, but it can end on today while
  // `best` was computed over closed runs — take the larger.
  return { streak, best: Math.max(best, streak) };
}

export function buildActivity(
  dayMinutes: ReadonlyMap<string, number>,
  todayKey: string,
): Activity {
  const activeDays = new Set(dayMinutes.keys());
  const { streak, best } = computeStreaks(activeDays, todayKey);

  const thisWeek = weekKeys(todayKey);
  const lastWeek = weekKeys(todayKey, 1);
  const minutesOn = (k: string): number => Math.round(dayMinutes.get(k) ?? 0);
  const week_minutes = thisWeek.map(minutesOn);

  return {
    streak_days: streak,
    best_streak: best,
    week_minutes,
    week_total_minutes: week_minutes.reduce((a, b) => a + b, 0),
    prev_week_total_minutes: lastWeek.map(minutesOn).reduce((a, b) => a + b, 0),
    active_days: activeDays.size,
  };
}

export async function getActivity(userId: string, now: Date = new Date()): Promise<Activity> {
  const user = await User.findById(userId).select("timezone").lean();
  const tz = user?.timezone ?? null;

  // Grouped in the database so this stays one small row per active day rather
  // than every session the user has ever had.
  const rows = await Session.aggregate<{ _id: string; seconds: number }>([
    { $match: { user_id: userId } },
    {
      $group: {
        _id: {
          $dateToString: { date: "$started_at", format: "%Y-%m-%d", timezone: tz || "UTC" },
        },
        seconds: { $sum: "$duration_seconds" },
      },
    },
  ]);

  const dayMinutes = new Map(rows.map((r) => [r._id, r.seconds / 60]));
  return buildActivity(dayMinutes, localDayKey(tz, now));
}
