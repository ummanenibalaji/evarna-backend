/**
 * Offline check for the outreach send policy.
 *
 *   npm run check:outreach
 *
 * No MongoDB, no Redis, no network. This covers the pure decision logic —
 * quiet hours and the timezone handling around them — which is the part where a
 * mistake wakes someone at 3am and there is no way to take it back.
 *
 * The stateful half of the policy — daily cap, recent-activity skip, hint
 * expiry, and crisis suppression — needs a database and is NOT yet covered
 * anywhere. That is a real gap: those branches decide whether someone gets
 * messaged after a self-harm disclosure, and right now only review protects
 * them. They belong in `npm run smoke`, which already has the fixtures.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

import assert from "node:assert/strict";

// Dynamic: ESM evaluates static imports before the module body, which would
// read config/env.js before the defaults above are set.
const { isQuietHours, localHour } = await import("../services/outreach.service.js");

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

// A fixed instant, expressed in UTC. Every assertion below asks what the clock
// says somewhere else at this same moment.
//   14:30 UTC  →  20:00 Kolkata (+5:30), 10:30 New York (EDT, -4), 23:30 Tokyo (+9)
// New York is on daylight time in August. Hardcoding the standard-time offset
// is exactly the mistake that sends notifications an hour into quiet hours for
// half the year, which is why the zone name is resolved rather than an offset.
const T = new Date("2026-08-21T14:30:00Z");

console.log("\nTimezone resolution");

check("resolves a real zone to its local hour", () => {
  assert.equal(localHour("Asia/Kolkata", T), 20);
  assert.equal(localHour("America/New_York", T), 10);
  assert.equal(localHour("Asia/Tokyo", T), 23);
  assert.equal(localHour("UTC", T), 14);
});

check("midnight resolves to 0, not 24", () => {
  // en-GB with hour12:false renders midnight as "24" in some runtimes, which
  // would silently fall outside the quiet window and send at midnight.
  const midnightUtc = new Date("2026-08-21T00:15:00Z");
  assert.equal(localHour("UTC", midnightUtc), 0);
});

check("daylight saving is honoured, not assumed away", () => {
  // Same zone, six months apart: EDT in August, EST in January. An offset
  // stored once would be an hour wrong for half the year.
  assert.equal(localHour("America/New_York", new Date("2026-08-21T14:30:00Z")), 10);
  assert.equal(localHour("America/New_York", new Date("2026-01-21T14:30:00Z")), 9);
});

check("an unknown or malformed zone resolves to null", () => {
  assert.equal(localHour("Not/AZone", T), null);
  assert.equal(localHour("", T), null);
  assert.equal(localHour(null, T), null);
  assert.equal(localHour(undefined, T), null);
});

console.log("\nQuiet hours (22:00–08:00 local)");

check("sends during the day", () => {
  assert.equal(isQuietHours("Asia/Kolkata", T), false, "20:00 local is not quiet");
  assert.equal(isQuietHours("America/New_York", T), false, "10:30 local is not quiet");
  assert.equal(isQuietHours("UTC", T), false, "14:30 local is not quiet");
});

check("does not send late at night", () => {
  assert.equal(isQuietHours("Asia/Tokyo", T), true, "23:30 local is quiet");
});

check("the window wraps midnight", () => {
  // The classic bug: `hour >= 22 && hour < 8` is never true, so nothing is ever
  // quiet and the app messages people all night.
  const at = (iso: string): boolean => isQuietHours("UTC", new Date(iso));
  assert.equal(at("2026-08-21T21:59:00Z"), false, "21:59 is still allowed");
  assert.equal(at("2026-08-21T22:00:00Z"), true, "22:00 begins quiet hours");
  assert.equal(at("2026-08-21T23:59:00Z"), true, "23:59 is quiet");
  assert.equal(at("2026-08-21T00:00:00Z"), true, "midnight is quiet");
  assert.equal(at("2026-08-21T03:00:00Z"), true, "3am is quiet");
  assert.equal(at("2026-08-21T07:59:00Z"), true, "07:59 is still quiet");
  assert.equal(at("2026-08-21T08:00:00Z"), false, "08:00 ends quiet hours");
});

check("an unknown timezone is treated as quiet, never as safe", () => {
  // Fails closed. Guessing UTC for someone whose timezone we do not know sends
  // notifications into the middle of their night; silence does not.
  assert.equal(isQuietHours(null, T), true);
  assert.equal(isQuietHours(undefined, T), true);
  assert.equal(isQuietHours("Not/AZone", T), true);
  assert.equal(isQuietHours("", T), true);
});

check("every hour of the day is decided, none left ambiguous", () => {
  const quiet: number[] = [];
  for (let h = 0; h < 24; h++) {
    const at = new Date(Date.UTC(2026, 7, 21, h, 0, 0));
    if (isQuietHours("UTC", at)) quiet.push(h);
  }
  // 22, 23, 0..7 — ten hours of silence, fourteen of daylight.
  assert.deepEqual(quiet, [0, 1, 2, 3, 4, 5, 6, 7, 22, 23]);
});

console.log(
  failures === 0
    ? "\nAll outreach policy checks passed.\n"
    : `\n${failures} outreach check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
