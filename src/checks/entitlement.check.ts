/**
 * Offline check for the entitlement maths and the gate's wire contract.
 *
 *   npm run check:entitlement
 *
 * Deliberately needs no MongoDB, no Redis and no network: everything asserted
 * here is a pure function, and these are the mistakes that are both silent and
 * expensive — a billing period that drifts a day earlier every month, an
 * allowance that resets twice, a lapsed subscriber who keeps their minutes, or
 * a refusal code the app does not recognise. The database half is covered by
 * `npm run smoke`, which is slower and needs a live server.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

// Dynamic, not static: ESM evaluates every static import before the module body
// runs, so importing anything that reads config/env.js at the top would blow up
// on the vars this file has just set.
const {
  addMonthsClamped,
  currentPeriod,
  daysInUTCMonth,
  decide,
  effectiveTier,
  localDayBounds,
  monthsElapsed,
  remainingMessagesToday,
  remainingVoiceSeconds,
  resolvePeriod,
  toEntitlementView,
} = await import("../services/entitlement.service.js");
const { TIERS, PLANS, TOPUP_PACKS } = await import("../data/tiers.js");

type Snapshot = Parameters<typeof decide>[0];

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
    failures++;
  }
}

const iso = (d: Date): string => d.toISOString();
const utc = (s: string): Date => new Date(s);

/** A free, unused snapshot. Each test overrides only what it is about. */
function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const now = utc("2026-09-12T10:00:00.000Z");
  return {
    user_id: "68a1b2c3d4e5f60718293a4b",
    tier: "free",
    status: "none",
    platform: "none",
    auto_renew: false,
    expires_at: null,
    period: { start: utc("2026-09-01T00:00:00.000Z"), end: utc("2026-10-01T00:00:00.000Z"), source: "signup_anniversary" },
    voice_seconds_used: 0,
    voice_seconds_in_flight: 0,
    live_voice_sessions: 0,
    topup_seconds: 0,
    messages_used_today: 0,
    messages_reset_at: new Date(now.getTime() + 3_600_000),
    degraded: false,
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("\nMonth arithmetic");
  check("February 2026 has 28 days", daysInUTCMonth(2026, 1) === 28);
  check("February 2024 has 29 days", daysInUTCMonth(2024, 1) === 29);
  check("December rolls into the next year", iso(addMonthsClamped(utc("2026-12-15T08:30:00Z"), 1)) === "2027-01-15T08:30:00.000Z");

  // The bug this guards: clamping 31 January to 28 February and then adding a
  // month from THERE gives 28 March, and the billing day creeps earlier every
  // month until it reaches the 28th permanently.
  const jan31 = utc("2026-01-31T09:15:00Z");
  check("31 Jan + 1 month clamps to 28 Feb", iso(addMonthsClamped(jan31, 1)) === "2026-02-28T09:15:00.000Z");
  check("31 Jan + 2 months is 31 Mar, not 28 Mar", iso(addMonthsClamped(jan31, 2)) === "2026-03-31T09:15:00.000Z");
  check("leap year gives 29 Feb", iso(addMonthsClamped(utc("2024-01-31T09:15:00Z"), 1)) === "2024-02-29T09:15:00.000Z");
  check("the anchor's time of day is preserved", addMonthsClamped(jan31, 5).getUTCHours() === 9);

  console.log("\nBilling periods");
  check("nothing has elapsed on the signup instant", monthsElapsed(jan31, jan31) === 0);
  check("a day before the billing day is still the same period", monthsElapsed(jan31, utc("2026-02-27T09:15:00Z")) === 0);
  check("the clamped billing day starts the next period", monthsElapsed(jan31, utc("2026-02-28T09:15:00Z")) === 1);
  check("a future anchor does not go negative", monthsElapsed(utc("2027-01-01T00:00:00Z"), jan31) === 0);

  const p = currentPeriod(jan31, utc("2026-03-15T00:00:00Z"));
  check(
    "mid-March sits in the 28 Feb → 31 Mar period",
    iso(p.start) === "2026-02-28T09:15:00.000Z" && iso(p.end) === "2026-03-31T09:15:00.000Z",
    `got ${iso(p.start)} → ${iso(p.end)}`,
  );

  // The property that matters more than any single case: every instant belongs
  // to exactly one period. A gap grants a free allowance; an overlap steals one.
  let contiguous = true;
  let covering = true;
  for (const day of [1, 15, 28, 29, 30, 31]) {
    const anchor = new Date(Date.UTC(2026, 0, day, 12, 0, 0));
    for (let i = 0; i < 36; i++) {
      const probe = new Date(anchor.getTime() + i * 30 * 86_400_000 + 86_400_000);
      const period = currentPeriod(anchor, probe);
      if (!(period.start.getTime() <= probe.getTime() && probe.getTime() < period.end.getTime())) {
        covering = false;
      }
      const next = currentPeriod(anchor, new Date(period.end.getTime() + 1));
      if (next.start.getTime() !== period.end.getTime()) contiguous = false;
    }
  }
  check("every instant falls inside its own period", covering);
  check("each period ends exactly where the next begins", contiguous);

  console.log("\nWhich tier is in force");
  const now = utc("2026-09-12T10:00:00Z");
  const future = utc("2026-10-12T10:00:00Z");
  const past = utc("2026-08-12T10:00:00Z");
  check("no subscription document means free", effectiveTier(null, now) === "free");
  check("a never-purchased row means free", effectiveTier({ tier: "free", status: "none", expires_at: null, period_start: null, topup_seconds: 0 }, now) === "free");
  check("an active plan is in force", effectiveTier({ tier: "plus", status: "active", expires_at: future, period_start: past, topup_seconds: 0 }, now) === "plus");
  check("an expired plan falls back to free", effectiveTier({ tier: "plus", status: "active", expires_at: past, period_start: past, topup_seconds: 0 }, now) === "free");
  check("status expired falls back to free even with a future expiry", effectiveTier({ tier: "premium", status: "expired", expires_at: future, period_start: past, topup_seconds: 0 }, now) === "free");
  // Cancelled is not lapsed: auto-renew is off, but they paid for this period.
  check("cancelled keeps the tier until the period they paid for ends", effectiveTier({ tier: "premium", status: "cancelled", expires_at: future, period_start: past, topup_seconds: 0 }, now) === "premium");
  // Grace is the store retrying a payment, not a lapse.
  check("a billing-retry grace period keeps the tier", effectiveTier({ tier: "plus", status: "grace", expires_at: future, period_start: past, topup_seconds: 0 }, now) === "plus");

  console.log("\nWhich window the allowance is measured over");
  const signup = utc("2026-03-20T06:00:00Z");
  const freePeriod = resolvePeriod(null, signup, now);
  check("a free user is anchored to signup", freePeriod.source === "signup_anniversary" && freePeriod.start.getUTCDate() === 20);

  // An annual subscriber's STORE period is a year long, but 400 minutes a month
  // is a monthly allowance. Honouring the store window would hand them twelve
  // months of minutes on the first day.
  const annual = resolvePeriod(
    { tier: "premium", status: "active", expires_at: utc("2027-06-05T00:00:00Z"), period_start: utc("2026-06-05T00:00:00Z"), topup_seconds: 0 },
    signup,
    now,
  );
  check(
    "an annual plan still rolls monthly from its purchase day",
    annual.source === "subscription" &&
      iso(annual.start) === "2026-09-05T00:00:00.000Z" &&
      iso(annual.end) === "2026-10-05T00:00:00.000Z",
    `got ${iso(annual.start)} → ${iso(annual.end)}`,
  );
  // A future anchor would put `now` before its own period, so the usage query
  // would match nothing and the allowance would look untouched.
  const futureAnchor = resolvePeriod(
    { tier: "plus", status: "active", expires_at: utc("2027-01-01T00:00:00Z"), period_start: utc("2026-12-01T00:00:00Z"), topup_seconds: 0 },
    signup,
    now,
  );
  check(
    "a period_start in the future does not create an empty period",
    futureAnchor.start.getTime() <= now.getTime() && now.getTime() < futureAnchor.end.getTime(),
    `got ${iso(futureAnchor.start)} → ${iso(futureAnchor.end)}`,
  );

  const lapsed = resolvePeriod(
    { tier: "plus", status: "active", expires_at: past, period_start: utc("2026-06-05T00:00:00Z"), topup_seconds: 0 },
    signup,
    now,
  );
  check("a lapsed subscriber goes back to the signup anniversary", lapsed.source === "signup_anniversary");

  console.log("\nThe numbers the owner decided");
  // Pinned, like the public-route allowlist: these are money, and a silent edit
  // should fail a check rather than ship.
  check("free is 8 minutes a month", TIERS.free.voice_seconds === 480);
  check("plus is 120 minutes a month", TIERS.plus.voice_seconds === 7_200);
  check("premium is 400 minutes a month", TIERS.premium.voice_seconds === 24_000);
  check("free is capped at 100 messages a day", TIERS.free.daily_messages === 100);
  check("every tier has a positive daily cap", Object.values(TIERS).every((t) => t.daily_messages > 0));
  check("plus is $19.99, or $12.49 a month annually", PLANS.some((x) => x.tier === "plus" && x.monthly_usd === 19.99 && x.annual_monthly_usd === 12.49));
  check("premium is $39.99, or $24.99 a month annually", PLANS.some((x) => x.tier === "premium" && x.monthly_usd === 39.99 && x.annual_monthly_usd === 24.99));
  check("every plan's advertised minutes match its tier allowance", PLANS.every((x) => x.voice_minutes * 60 === TIERS[x.tier].voice_seconds));
  check("the packs are 30/75/150 minutes", TOPUP_PACKS.map((x) => x.seconds / 60).join(",") === "30,75,150");
  check("the 30-minute pack is $4.99", TOPUP_PACKS.some((x) => x.seconds === 1_800 && x.price_usd === 4.99));
  check("every product id is namespaced", [...PLANS.flatMap((x) => [x.product_ids.monthly, x.product_ids.annual]), ...TOPUP_PACKS.map((x) => x.product_id)].every((id) => id.startsWith("evarna.")));

  console.log("\nRemaining balance");
  check("a fresh free account has 8 minutes", remainingVoiceSeconds({ tier: "free", topup_seconds: 0, voice_seconds_used: 0 }) === 480);
  check("usage comes off the allowance", remainingVoiceSeconds({ tier: "free", topup_seconds: 0, voice_seconds_used: 200 }) === 280);
  // Never negative: the app divides by the allowance to draw a meter, and a
  // negative balance rendered as a bar going the wrong way.
  check("an overspent balance clamps at zero", remainingVoiceSeconds({ tier: "free", topup_seconds: 0, voice_seconds_used: 9_999 }) === 0);
  // The wallet is carried but NOT spendable yet, and this pins that on purpose.
  // Derived usage resets every period, so a wallet added on top of it would be
  // re-granted every month — one $4.99 pack becoming an unlimited
  // subscription. It becomes spendable with the usage counters, and this
  // assertion is what should fail when someone makes it so without them.
  check("a top-up balance does not extend the allowance yet", remainingVoiceSeconds({ tier: "free", topup_seconds: 1_800, voice_seconds_used: 0 }) === 480);
  check("an exhausted allowance is not rescued by the wallet", remainingVoiceSeconds({ tier: "free", topup_seconds: 1_800, voice_seconds_used: 480 }) === 0);
  // A tier from another build must not become an unpriced allowance, and above
  // all must not throw: this runs inside the gate, outside its try/catch.
  check("an unknown tier is treated as free", remainingVoiceSeconds({ tier: "enterprise" as never, topup_seconds: 0, voice_seconds_used: 0 }) === 480);
  check("messages remaining clamps at zero too", remainingMessagesToday({ tier: "free", messages_used_today: 500 }) === 0);

  console.log("\nThe gate's answers");
  check("a fresh free account can call", decide(snapshot(), "voice").allowed);
  check("a fresh free account can text", decide(snapshot(), "text").allowed);
  // One second left is still allowed: refusing at the boundary would cut a call
  // off that the user is entitled to start.
  check("one second of allowance is enough to start", decide(snapshot({ voice_seconds_used: 479 }), "voice").allowed);

  const exhausted = decide(snapshot({ voice_seconds_used: 480 }), "voice");
  check(
    "an exhausted allowance is 402 VOICE_MINUTES_EXHAUSTED",
    !exhausted.allowed && exhausted.code === "VOICE_MINUTES_EXHAUSTED" && exhausted.status === 402,
  );
  check(
    "the refusal says when the allowance comes back",
    !exhausted.allowed && exhausted.renews_at === "2026-10-01T00:00:00.000Z",
  );
  check("text still works with no voice minutes left", decide(snapshot({ voice_seconds_used: 480 }), "text").allowed);

  const capped = decide(snapshot({ messages_used_today: 100 }), "text");
  check(
    "the daily cap is 429 DAILY_MESSAGE_CAP",
    !capped.allowed && capped.code === "DAILY_MESSAGE_CAP" && capped.status === 429,
  );
  // Measured against the snapshot's reset instant, not the wall clock: `decide`
  // takes `now` precisely so this is assertable.
  const cappedAt = utc("2026-09-12T10:00:00.000Z");
  const cappedSnap = snapshot({ messages_used_today: 100, messages_reset_at: utc("2026-09-12T11:00:00.000Z") });
  const timed = decide(cappedSnap, "text", cappedAt);
  check(
    "it tells the client exactly when to come back",
    !timed.allowed && timed.retry_after_seconds === 3_600,
    `got ${!timed.allowed ? timed.retry_after_seconds : "allowed"}`,
  );
  check("a paid tier is nowhere near the free cap", decide(snapshot({ tier: "plus", messages_used_today: 100 }), "text").allowed);

  // Concurrency is usage.service.ts's ceiling, not a plan limit, and deciding
  // it in both places gave one rule two codes. The gate must stay out of it.
  check("one live call does not block starting one", decide(snapshot({ live_voice_sessions: 1 }), "voice").allowed);
  check("the gate does not decide concurrency", decide(snapshot({ live_voice_sessions: 5 }), "voice").allowed);

  // Fail open. The alternative turns a slow database into a product-wide outage.
  check("unreadable usage allows a call", decide(snapshot({ degraded: true, voice_seconds_used: 99_999 }), "voice").allowed);
  check("unreadable usage allows a message", decide(snapshot({ degraded: true, messages_used_today: 99_999 }), "text").allowed);

  console.log("\nThe user's local day");
  // The cap resets at the user's own midnight. A UTC reset lands at 5:30am in
  // Kolkata and cuts someone's evening short.
  const kolkata = localDayBounds("Asia/Kolkata", utc("2026-09-12T18:45:00Z"));
  check(
    "an evening in Kolkata belongs to the next local day",
    iso(kolkata.start) === "2026-09-12T18:30:00.000Z" && iso(kolkata.end) === "2026-09-13T18:30:00.000Z",
    `got ${iso(kolkata.start)} → ${iso(kolkata.end)}`,
  );
  const utcDay = localDayBounds(null, utc("2026-09-12T18:45:00Z"));
  check("an unset timezone falls back to UTC", iso(utcDay.start) === "2026-09-12T00:00:00.000Z");
  check("an unknown timezone does not throw", localDayBounds("Mars/Olympus_Mons", now).end.getTime() > now.getTime());
  // A DST boundary inside the day must not move it: New York went forward on
  // 8 March 2026, so that local day is 23 hours long.
  const dst = localDayBounds("America/New_York", utc("2026-03-08T12:00:00Z"));
  check(
    "a spring-forward day is 23 hours, not 24",
    (dst.end.getTime() - dst.start.getTime()) / 3_600_000 === 23,
    `got ${(dst.end.getTime() - dst.start.getTime()) / 3_600_000}h`,
  );

  console.log("\nWhat the app reads");
  const view = toEntitlementView(snapshot({ tier: "plus", status: "active", voice_seconds_used: 600, topup_seconds: 1_800 }));
  check("the view reports the tier and its label", view.tier === "plus" && view.tier_label === "Plus");
  check("remaining is the allowance minus what was used", view.voice.remaining_seconds === 7_200 - 600);
  check("renews_at is the period end", view.period.renews_at === "2026-10-01T00:00:00.000Z");
  check("prices ship with the response", view.plans.length === 2 && view.topup_packs.length === 3);
  const viewSnap = snapshot({ tier: "plus", messages_reset_at: utc("2026-09-13T00:00:00.000Z") });
  check("the text block reports the real reset instant", toEntitlementView(viewSnap).text.resets_at === "2026-09-13T00:00:00.000Z");
  check("a top-up balance is reported even though it is not spendable", toEntitlementView(snapshot({ topup_seconds: 1_800 })).voice.topup_seconds === 1_800);
  check("an unknown tier still renders a view rather than throwing", toEntitlementView(snapshot({ tier: "enterprise" as never })).voice.allowance_seconds === 480);

  console.log(
    failures === 0
      ? "\nAll entitlement checks passed.\n"
      : `\n${failures} entitlement check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("entitlement check crashed:", err);
  process.exit(1);
});
