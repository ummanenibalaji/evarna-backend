/**
 * Offline check for Phase C — the adaptive companion.
 *
 *   npm run check:adaptation
 *
 * No MongoDB, no Redis, no network. Covers the two pure pieces: which
 * suggestion gets offered (and, more importantly, when nothing does), and the
 * line the companion is told after a change is accepted.
 *
 * The stateful half — that resolving actually moves the slider and invalidates
 * the cached config — needs a database and lives in `npm run smoke`.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

import assert from "node:assert/strict";

// Dynamic: ESM evaluates static imports before the module body, which would
// read config/env.js before the defaults above are set.
const { pickSuggestion, phraseFor, COOLDOWN_MS, STEP } = await import(
  "../services/adaptation.service.js"
);
const { buildIdentityBlock } = await import("../services/prompt.service.js");

type Sliders = { warmth: number; humor: number; directness: number; energy: number; formality: number };
type Hinted = Parameters<typeof pickSuggestion>[0][number];
type State = Parameters<typeof pickSuggestion>[2];

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

const NOW = new Date("2026-08-22T12:00:00Z");
const DAY = 86_400_000;

const MID: Sliders = { warmth: 50, humor: 50, directness: 50, energy: 50, formality: 50 };

function mem(
  id: string,
  daysAgo: number,
  hint: Hinted["slider_hint"],
  content = "user prefers direct feedback over softening",
): Hinted {
  return {
    _id: id,
    content,
    created_at: new Date(NOW.getTime() - daysAgo * DAY),
    slider_hint: hint,
  };
}

const DIRECT_UP = mem("m1", 1, { trait: "directness", direction: "up" });

console.log("\nWhat gets offered");

check("a preference with a hint becomes an offer", () => {
  const { suggestion, isNew } = pickSuggestion([DIRECT_UP], MID, {}, NOW);
  assert.ok(suggestion, "expected an offer");
  assert.equal(suggestion.trait, "directness");
  assert.equal(suggestion.from, 50);
  assert.equal(suggestion.to, 50 + STEP);
  assert.equal(suggestion.phrase, "more direct");
  // The user's own words are carried through so the offer is auditable — an
  // adjustment with no stated reason is indistinguishable from the app
  // deciding on its own.
  assert.equal(suggestion.quote, "user prefers direct feedback over softening");
  assert.equal(isNew, true, "a fresh offer must start the cooldown");
});

check("memories with no hint are ignored entirely", () => {
  const plain = mem("m2", 1, null, "user has a sister named Priya");
  assert.equal(pickSuggestion([plain], MID, {}, NOW).suggestion, null);
});

check("the newest hint wins", () => {
  const old = mem("old", 30, { trait: "humor", direction: "up" });
  const recent = mem("recent", 2, { trait: "energy", direction: "down" });
  const { suggestion } = pickSuggestion([old, recent], MID, {}, NOW);
  assert.equal(suggestion?.memory_id, "recent");
});

check("a malformed hint is skipped, not coerced", () => {
  // Defence in depth: extraction already drops these, but a hint written by an
  // older build or edited by hand must not become a slider move.
  const bogusTrait = mem("b1", 1, { trait: "sarcasm", direction: "up" } as never);
  const bogusDir = mem("b2", 1, { trait: "warmth", direction: "sideways" } as never);
  assert.equal(pickSuggestion([bogusTrait, bogusDir], MID, {}, NOW).suggestion, null);
});

console.log("\nWhen nothing is offered");

check("no offer when the slider is already there", () => {
  // directness 85, and they want more direct. There is nothing useful left to
  // give, and a button that moves 85 → 90 changes nothing the user can hear.
  const high: Sliders = { ...MID, directness: 85 };
  assert.equal(pickSuggestion([DIRECT_UP], high, {}, NOW).suggestion, null);

  const low: Sliders = { ...MID, warmth: 15 };
  const warmDown = mem("m3", 1, { trait: "warmth", direction: "down" });
  assert.equal(pickSuggestion([warmDown], low, {}, NOW).suggestion, null);
});

check("an answered memory is never offered again", () => {
  const state: State = { handled_memory_ids: ["m1"] };
  assert.equal(pickSuggestion([DIRECT_UP], MID, state, NOW).suggestion, null);
});

check("at most one suggestion a week", () => {
  const fresh = mem("m9", 0, { trait: "humor", direction: "up" });
  const justOffered: State = { last_offered_at: new Date(NOW.getTime() - 2 * DAY) };
  assert.equal(pickSuggestion([fresh], MID, justOffered, NOW).suggestion, null);

  const longAgo: State = { last_offered_at: new Date(NOW.getTime() - COOLDOWN_MS - 1000) };
  assert.ok(pickSuggestion([fresh], MID, longAgo, NOW).suggestion, "cooldown should have expired");
});

console.log("\nAn outstanding offer");

const OPEN: State = {
  suggestion: { memory_id: "m1", trait: "directness", direction: "up", offered_at: new Date(NOW.getTime() - 3 * DAY) },
  last_offered_at: new Date(NOW.getTime() - 3 * DAY),
};

check("stands until answered, and does not restart the cooldown", () => {
  const { suggestion, isNew } = pickSuggestion([DIRECT_UP], MID, OPEN, NOW);
  assert.ok(suggestion);
  assert.equal(suggestion.memory_id, "m1");
  // If re-reading an unanswered offer restarted the clock, an offer the user
  // never taps would suppress every future one forever.
  assert.equal(isNew, false);
});

check("is re-derived from the current sliders, not replayed", () => {
  // They dragged directness to 70 by hand after the offer was made. The offer
  // must reflect where the slider actually is now.
  const moved: Sliders = { ...MID, directness: 70 };
  const { suggestion } = pickSuggestion([DIRECT_UP], moved, OPEN, NOW);
  assert.equal(suggestion?.from, 70);
  assert.equal(suggestion?.to, 90);
});

check("disappears once the user has tuned past it themselves", () => {
  const already: Sliders = { ...MID, directness: 90 };
  assert.equal(pickSuggestion([DIRECT_UP], already, OPEN, NOW).suggestion, null);
});

check("disappears if the memory behind it was deleted", () => {
  // The memory screen lets people delete memories. An offer quoting one that no
  // longer exists would show text the user has explicitly erased.
  assert.equal(pickSuggestion([], MID, OPEN, NOW).suggestion, null);
});

check("a newer hint does not jump the queue past an open offer", () => {
  const newer = mem("m2", 0, { trait: "humor", direction: "up" });
  const { suggestion } = pickSuggestion([DIRECT_UP, newer], MID, OPEN, NOW);
  assert.equal(suggestion?.memory_id, "m1", "the outstanding offer stays until answered");
});

console.log("\nThe companion is told (C2)");

const IDENTITY = { name: "Sage", mode: "companion", knownSince: new Date("2026-06-01T00:00:00Z") };

check("a recent change is mentioned, with the same words the user tapped", () => {
  const block = buildIdentityBlock(
    { ...IDENTITY, recentChange: { phrase: phraseFor("directness", "up"), at: new Date(NOW.getTime() - 2 * DAY) } },
    NOW,
  );
  assert.ok(block.includes("asked you to be more direct"), block);
  // The whole point is that it does NOT make a performance of it.
  assert.ok(/Do not announce the change/.test(block), block);
});

check("it stops being news after two weeks", () => {
  const block = buildIdentityBlock(
    { ...IDENTITY, recentChange: { phrase: "more direct", at: new Date(NOW.getTime() - 20 * DAY) } },
    NOW,
  );
  assert.ok(!block.includes("asked you to be"), block);
});

check("no change means no line at all", () => {
  assert.ok(!buildIdentityBlock(IDENTITY, NOW).includes("asked you to be"));
});

check("studio characters never carry it", () => {
  // A studio character is a role the user cast. It was never tuned, is never
  // offered a suggestion, and telling an interviewer the user asked it to be
  // warmer would be describing something that never happened.
  const block = buildIdentityBlock(
    {
      name: "Interviewer",
      mode: "studio",
      knownSince: new Date("2026-08-01T00:00:00Z"),
      studio: { kind: "scenario", scenarioName: "Interview practice" },
      recentChange: { phrase: "more direct", at: new Date(NOW.getTime() - DAY) },
    },
    NOW,
  );
  assert.ok(!block.includes("asked you to be"), block);
});

check("every trait and direction has real phrasing", () => {
  const traits = ["warmth", "humor", "directness", "energy", "formality"] as const;
  const seen = new Set<string>();
  for (const t of traits) {
    for (const d of ["up", "down"] as const) {
      const p = phraseFor(t, d);
      assert.ok(p && p.length > 2, `${t}/${d} has no phrasing`);
      assert.ok(!seen.has(p), `"${p}" is used for two different changes`);
      seen.add(p);
      // It is dropped straight into "asked you to be ___", so it has to read as
      // a comparative, not as a trait name.
      assert.ok(!p.includes(t), `"${p}" reads like a field name, not English`);
    }
  }
});

console.log(
  failures === 0
    ? "\nAll adaptation checks passed.\n"
    : `\n${failures} adaptation check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
