/**
 * Offline check for the real activity numbers.
 *
 *   npm run check:activity
 *
 * No MongoDB, no Redis, no network. These replaced hardcoded constants that
 * were shown to every user, so the bar is that the real ones are actually
 * right — a streak that resets at the wrong hour is worse than no streak.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

import assert from "node:assert/strict";

const { localDayKey, shiftDay, weekKeys, computeStreaks, buildActivity } = await import(
  "../services/activity.service.js"
);

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n      ${(err as Error).message}`);
    failures++;
  }
}

console.log("\nDay bucketing is the user's, not the server's");

check("the same instant is a different day in different zones", () => {
  // 20:30 UTC on the 22nd is already the 23rd in Tokyo. Bucketing this in
  // server time breaks the streak of everyone far enough east.
  const at = new Date("2026-08-22T20:30:00Z");
  assert.equal(localDayKey("UTC", at), "2026-08-22");
  assert.equal(localDayKey("Asia/Tokyo", at), "2026-08-23");
  assert.equal(localDayKey("America/New_York", at), "2026-08-22");
});

check("late-night sessions stay on the day they happened", () => {
  // 23:30 in Kolkata is 18:00 UTC. Counted in UTC it is the same day here, but
  // an hour later it would roll over while the user is still awake and talking.
  assert.equal(localDayKey("Asia/Kolkata", new Date("2026-08-22T19:00:00Z")), "2026-08-23");
});

check("an unknown or missing timezone falls back to UTC, not to a crash", () => {
  const at = new Date("2026-08-22T12:00:00Z");
  assert.equal(localDayKey(null, at), "2026-08-22");
  assert.equal(localDayKey(undefined, at), "2026-08-22");
  assert.equal(localDayKey("Not/AZone", at), "2026-08-22");
});

check("day arithmetic crosses months, years and DST without drifting", () => {
  assert.equal(shiftDay("2026-08-22", 1), "2026-08-23");
  assert.equal(shiftDay("2026-08-01", -1), "2026-07-31");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDay("2028-02-28", 1), "2028-02-29", "2028 is a leap year");
  // US DST springs forward on 2026-03-08. Shifting through it in a real zone
  // would land on the same day twice or skip one.
  assert.equal(shiftDay("2026-03-07", 1), "2026-03-08");
  assert.equal(shiftDay("2026-03-08", 1), "2026-03-09");
});

console.log("\nThe week strip");

check("weeks run Monday to Sunday", () => {
  // 2026-08-22 is a Saturday.
  const w = weekKeys("2026-08-22");
  assert.equal(w.length, 7);
  assert.equal(w[0], "2026-08-17", "the week must start on Monday");
  assert.equal(w[6], "2026-08-23", "and end on Sunday");
  assert.ok(w.includes("2026-08-22"));
});

check("Sunday belongs to the week that just ended, not the one starting", () => {
  // The classic off-by-one: JS weeks start on Sunday, this strip does not.
  const w = weekKeys("2026-08-23"); // a Sunday
  assert.equal(w[0], "2026-08-17");
  assert.equal(w[6], "2026-08-23");
});

check("last week is the seven days before it", () => {
  assert.deepEqual(weekKeys("2026-08-22", 1)[0], "2026-08-10");
  assert.deepEqual(weekKeys("2026-08-22", 1)[6], "2026-08-16");
});

console.log("\nStreaks");

const days = (...keys: string[]): Set<string> => new Set(keys);

check("counts consecutive days back from today", () => {
  const { streak } = computeStreaks(days("2026-08-20", "2026-08-21", "2026-08-22"), "2026-08-22");
  assert.equal(streak, 3);
});

check("today being empty does not break a live streak", () => {
  // It is 9am and they have not talked yet. Showing 0 here tells someone with a
  // 12-day habit that they have lost it, which is the opposite of the point.
  const { streak } = computeStreaks(days("2026-08-20", "2026-08-21"), "2026-08-22");
  assert.equal(streak, 2);
});

check("a full missed day does break it", () => {
  const { streak } = computeStreaks(days("2026-08-19", "2026-08-20"), "2026-08-22");
  assert.equal(streak, 0);
});

check("no sessions at all is a streak of zero, not a crash", () => {
  assert.deepEqual(computeStreaks(days(), "2026-08-22"), { streak: 0, best: 0 });
});

check("the personal best comes from history, including closed runs", () => {
  const { streak, best } = computeStreaks(
    days(
      "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05",
      "2026-08-21", "2026-08-22",
    ),
    "2026-08-22",
  );
  assert.equal(streak, 2);
  assert.equal(best, 5, "an old five-day run is still the personal best");
});

check("the current streak counts as the best when it is the best", () => {
  const { streak, best } = computeStreaks(days("2026-08-21", "2026-08-22"), "2026-08-22");
  assert.equal(streak, 2);
  assert.equal(best, 2, "the live run must not be excluded from its own record");
});

console.log("\nAssembled activity");

check("week minutes land on the right bars and total correctly", () => {
  const a = buildActivity(
    new Map([
      ["2026-08-17", 18],   // Monday
      ["2026-08-22", 36.4], // Saturday
      ["2026-08-10", 100],  // last week
    ]),
    "2026-08-22",
  );
  assert.deepEqual(a.week_minutes, [18, 0, 0, 0, 0, 36, 0], "Monday first, rounded, gaps as zero");
  assert.equal(a.week_total_minutes, 54);
  assert.equal(a.prev_week_total_minutes, 100);
  assert.equal(a.active_days, 3);
});

check("a brand-new account is all zeros, never a placeholder", () => {
  const a = buildActivity(new Map(), "2026-08-22");
  assert.equal(a.streak_days, 0);
  assert.equal(a.best_streak, 0);
  assert.equal(a.active_days, 0);
  assert.deepEqual(a.week_minutes, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(a.week_total_minutes, 0);
  assert.equal(a.prev_week_total_minutes, 0);
});

console.log(
  failures === 0
    ? "\nAll activity checks passed.\n"
    : `\n${failures} activity check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
