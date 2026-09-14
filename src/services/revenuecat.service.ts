import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { Subscription } from "../models/subscription.model.js";
import type { SubscriptionStatus, Tier } from "../types/billing.types.js";

// ── Store purchases, through RevenueCat ──────────────────────────────────────
//
// RevenueCat verifies Google Play purchases, handles renewals, grace periods and
// refunds, and tells us when something changed. We never apply its events one
// by one: they can arrive late, retried, or out of order. Any notification, or
// the app saying "I just bought something", makes us read the customer's current
// record from RevenueCat and write that state to our Subscription row, which the
// entitlement gate already reads. This is RevenueCat's own recommendation.

const SUBSCRIBER_URL = "https://api.revenuecat.com/v1/subscribers/";

export class RevenueCatNotConfiguredError extends Error {
  constructor() {
    super("RevenueCat is not configured. Set REVENUECAT_SECRET_KEY.");
    this.name = "RevenueCatNotConfiguredError";
  }
}

/** One entry of a v1 subscriber's `subscriptions` map. Dates are ISO 8601. */
export interface RcSubscription {
  expires_date?: string | null;
  purchase_date?: string | null;
  original_purchase_date?: string | null;
  unsubscribe_detected_at?: string | null;
  billing_issues_detected_at?: string | null;
  grace_period_expires_date?: string | null;
  refunded_at?: string | null;
  store?: string | null;
}

export interface SubscriptionState {
  tier: Tier;
  status: SubscriptionStatus;
  platform: "none" | "android" | "ios";
  product_id: string | null;
  period_start: Date | null;
  period_end: Date | null;
  expires_at: Date | null;
  auto_renew: boolean;
}

const FREE_STATE: SubscriptionState = {
  tier: "free", status: "none", platform: "none", product_id: null,
  period_start: null, period_end: null, expires_at: null, auto_renew: false,
};

const TIER_RANK: Record<Exclude<Tier, "free">, number> = { plus: 1, premium: 2 };

/**
 * The paid tier a store product unlocks, or null. Google Play identifies a
 * subscription as "subscriptionId:basePlanId" ("evarna.plus:annual"); the older
 * catalog form ("evarna.plus.monthly") is accepted too. Top-ups are not tiers.
 */
export function tierForProduct(productId: string): Exclude<Tier, "free"> | null {
  const id = productId.split(":")[0] ?? "";
  if (id === "evarna.plus" || id.startsWith("evarna.plus.")) return "plus";
  if (id === "evarna.premium" || id.startsWith("evarna.premium.")) return "premium";
  return null;
}

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const timeOr = (d: Date | null, fallback: number): number => (d ? d.getTime() : fallback);

/**
 * Pure: what a customer's RevenueCat subscriptions mean for our Subscription row
 * right now. A refund ends access at once; a billing issue keeps access until
 * the grace period ends; a cancellation keeps access until expiry. When several
 * products exist, a plan that still grants access beats one that doesn't, and
 * Premium beats Plus (they overlap during an upgrade).
 */
export function stateFromSubscriber(subscriptions: Record<string, RcSubscription>, now: Date): SubscriptionState {
  const rows = Object.entries(subscriptions).flatMap(([productId, s]) => {
    const tier = tierForProduct(productId);
    if (!tier) return [];
    const refunded = toDate(s.refunded_at);
    const grace = s.billing_issues_detected_at ? toDate(s.grace_period_expires_date) : null;
    const inGrace = !!grace && grace.getTime() > now.getTime();
    const expires = refunded ?? (inGrace ? grace : toDate(s.expires_date));
    const entitled = !refunded && (expires === null || expires.getTime() > now.getTime());
    return [{ productId, tier, s, expires, entitled, inGrace }];
  });
  if (rows.length === 0) return FREE_STATE;

  rows.sort((a, b) =>
    Number(b.entitled) - Number(a.entitled) ||
    TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
    timeOr(b.expires, Number.MAX_SAFE_INTEGER) - timeOr(a.expires, Number.MAX_SAFE_INTEGER),
  );
  const best = rows[0]!;
  const status: SubscriptionStatus = !best.entitled
    ? "expired"
    : best.inGrace
      ? "grace"
      : best.s.unsubscribe_detected_at
        ? "cancelled"
        : "active";

  return {
    tier: best.tier,
    status,
    platform: best.s.store === "play_store" ? "android" : best.s.store === "app_store" ? "ios" : "none",
    product_id: best.productId,
    // The original purchase is the stable anchor for the monthly allowance, so
    // renewals don't move the day minutes reset.
    period_start: toDate(best.s.original_purchase_date) ?? toDate(best.s.purchase_date),
    period_end: toDate(best.s.expires_date),
    expires_at: best.expires,
    auto_renew: best.entitled && !best.s.unsubscribe_detected_at,
  };
}

/** Constant-time comparison of RevenueCat's Authorization header. Fails closed. */
export function webhookAuthorized(header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Every one of our users a webhook event touches. A transfer moves a purchase
 * between accounts, so both sides are re-read. Anonymous RevenueCat ids are not
 * ours and are skipped.
 */
export function usersInEvent(event: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && /^[a-f0-9]{24}$/i.test(v)) ids.add(v);
  };
  add(event["app_user_id"]);
  add(event["original_app_user_id"]);
  for (const key of ["transferred_from", "transferred_to", "aliases"]) {
    const list = event[key];
    if (Array.isArray(list)) list.forEach(add);
  }
  return [...ids];
}

/** Read the customer from RevenueCat and store what it implies. */
export async function syncFromRevenueCat(userId: string, now: Date = new Date()): Promise<SubscriptionState> {
  if (!env.REVENUECAT_SECRET_KEY) throw new RevenueCatNotConfiguredError();
  const res = await fetch(SUBSCRIBER_URL + encodeURIComponent(userId), {
    headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`RevenueCat subscriber lookup failed with HTTP ${res.status}`);
  const body = (await res.json()) as { subscriber?: { subscriptions?: Record<string, RcSubscription> } };
  const state = stateFromSubscriber(body.subscriber?.subscriptions ?? {}, now);

  // A developer grant has no store record, so an empty one must not wipe it.
  const existing = await Subscription.findOne({ user_id: userId }).select("platform").lean();
  if (state.tier === "free" && existing?.platform === "dev_grant") return state;

  await Subscription.updateOne(
    { user_id: userId },
    {
      $set: { ...state, last_verified_at: now, updated_at: now },
      $setOnInsert: { created_at: now, topup_seconds: 0 },
    },
    { upsert: true },
  );
  return state;
}
