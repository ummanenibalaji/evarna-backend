/**
 * What a RevenueCat customer record means for our Subscription row, offline.
 *
 *   npm run check:revenuecat
 *
 * This is the money path: a mistake here either gives a paid plan away or takes
 * one from someone who paid.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

const { tierForProduct, stateFromSubscriber, webhookAuthorized, usersInEvent } = await import("../services/revenuecat.service.js");
const { effectiveTier } = await import("../services/entitlement.service.js");

let failures = 0;
const check = (label: string, ok: boolean): void => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
};

const now = new Date("2026-09-14T12:00:00Z");
// effectiveTier reads the stored row, which also carries the top-up wallet.
const tierOf = (state: Parameters<typeof stateFromSubscriber>[0] extends never ? never : ReturnType<typeof stateFromSubscriber>): string => effectiveTier({ ...state, topup_seconds: 0 }, now);
const inDays = (d: number): string => new Date(now.getTime() + d * 86_400_000).toISOString();
const sub = (over: Record<string, string | null> = {}) => ({
  expires_date: inDays(20), purchase_date: inDays(-10), original_purchase_date: inDays(-40),
  unsubscribe_detected_at: null, billing_issues_detected_at: null, grace_period_expires_date: null,
  refunded_at: null, store: "play_store", ...over,
});

console.log("\nProducts");
check("a Play subscription id maps to its tier", tierForProduct("evarna.plus:monthly") === "plus" && tierForProduct("evarna.premium:annual") === "premium");
check("the bare subscription id and the older catalog form map too", tierForProduct("evarna.plus") === "plus" && tierForProduct("evarna.premium.monthly") === "premium");
check("a top-up is not a plan", tierForProduct("evarna.topup.30") === null);
check("someone else's product is not a plan", tierForProduct("com.other:monthly") === null);

console.log("\nCustomer state");
const free = stateFromSubscriber({}, now);
check("no purchases is free", free.tier === "free" && free.status === "none" && tierOf(free) === "free");

const active = stateFromSubscriber({ "evarna.plus:monthly": sub() }, now);
check("an active Plus subscription is Plus, renewing, on Android",
  active.tier === "plus" && active.status === "active" && active.auto_renew && active.platform === "android" && tierOf(active) === "plus");
check("the allowance is anchored to the original purchase, so renewals don't move it",
  active.period_start?.toISOString() === inDays(-40));

const cancelled = stateFromSubscriber({ "evarna.plus:monthly": sub({ unsubscribe_detected_at: inDays(-1) }) }, now);
check("cancelled but not yet expired keeps Plus until expiry, not renewing",
  cancelled.status === "cancelled" && !cancelled.auto_renew && tierOf(cancelled) === "plus");

const expired = stateFromSubscriber({ "evarna.plus:monthly": sub({ expires_date: inDays(-1) }) }, now);
check("expired is free", expired.status === "expired" && tierOf(expired) === "free");

const grace = stateFromSubscriber({ "evarna.plus:monthly": sub({ expires_date: inDays(-1), billing_issues_detected_at: inDays(-1), grace_period_expires_date: inDays(3) }) }, now);
check("a billing issue keeps access through the grace period",
  grace.status === "grace" && grace.expires_at?.toISOString() === inDays(3) && tierOf(grace) === "plus");

const graceOver = stateFromSubscriber({ "evarna.plus:monthly": sub({ expires_date: inDays(-5), billing_issues_detected_at: inDays(-5), grace_period_expires_date: inDays(-1) }) }, now);
check("once the grace period ends it's free", graceOver.status === "expired" && tierOf(graceOver) === "free");

const refunded = stateFromSubscriber({ "evarna.premium:annual": sub({ refunded_at: inDays(-1) }) }, now);
check("a refund ends access at once, even with time left", refunded.status === "expired" && tierOf(refunded) === "free");

const upgrade = stateFromSubscriber({ "evarna.plus:monthly": sub(), "evarna.premium:monthly": sub() }, now);
check("Premium wins over Plus while both are active (an upgrade)", upgrade.tier === "premium");

const lapsedPremium = stateFromSubscriber({ "evarna.premium:monthly": sub({ expires_date: inDays(-2) }), "evarna.plus:monthly": sub() }, now);
check("an active Plus wins over a lapsed Premium", lapsedPremium.tier === "plus" && tierOf(lapsedPremium) === "plus");

check("someone else's product grants nothing", stateFromSubscriber({ "com.other:monthly": sub() }, now).tier === "free");

console.log("\nWebhook");
check("the configured secret is accepted", webhookAuthorized("s3cret-value", "s3cret-value"));
check("a wrong or missing secret is refused", !webhookAuthorized("wrong-value!", "s3cret-value") && !webhookAuthorized(undefined, "s3cret-value"));
check("with no secret configured, everything is refused", !webhookAuthorized("anything", "") && !webhookAuthorized("", ""));
const ids = usersInEvent({ app_user_id: "68a1b2c3d4e5f60718293a4b", transferred_from: ["68a1b2c3d4e5f60718293a4c"], transferred_to: ["$RCAnonymousID:abc123"] });
check("a transfer re-reads both of our users and skips anonymous ids",
  JSON.stringify(ids) === JSON.stringify(["68a1b2c3d4e5f60718293a4b", "68a1b2c3d4e5f60718293a4c"]));

console.log(failures === 0 ? "\nAll RevenueCat checks passed." : `\n${failures} RevenueCat check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
