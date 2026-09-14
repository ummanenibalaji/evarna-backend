/**
 * Billing and entitlement shapes.
 *
 * Everything here is platform-agnostic on purpose. Play Billing shares nothing
 * with StoreKit except our own model, so a field shaped like an Apple receipt
 * ("latest_receipt", "app_account_token") becomes a migration the day Android
 * ships. What both stores do give us is: a platform, a product id, an id that
 * is stable across renewals, and an expiry instant.
 */

export type Tier = "free" | "plus" | "premium";

export interface TierAllowance {
  /** Monthly voice allowance, in seconds. */
  voice_seconds: number;
  /**
   * Messages per day. Text is cheap (~$0.002 a turn), so on paid tiers this is
   * an abuse ceiling; on free it IS the product limit from the pricing decision.
   */
  daily_messages: number;
  label: string;
}

export interface BillingPlan {
  tier: Exclude<Tier, "free">;
  label: string;
  voice_minutes: number;
  /** Messages a day. Shown on the paywall, so it must come from the tier, not copy. */
  daily_messages: number;
  monthly_usd: number;
  /** Annual plans are sold as one payment but displayed per month. */
  annual_monthly_usd: number;
  /**
   * Store product identifiers. They must match App Store Connect and the Play
   * Console exactly, and nothing here validates that — a mismatch surfaces as a
   * purchase the server cannot find.
   */
  product_ids: { monthly: string; annual: string };
}

export interface TopUpPack {
  id: string;
  /** Seconds granted into the wallet. Bought minutes never expire. */
  seconds: number;
  price_usd: number;
  product_id: string;
}

/**
 * `none` is a user who has never purchased — the overwhelming majority, and
 * the reason a missing Subscription document is a normal state rather than an
 * error. `grace` is the store's billing-retry window: Apple and Google both
 * keep serving the subscription while a renewal payment is being retried, so
 * the user keeps their tier. `cancelled` means auto-renew is off but the period
 * they already paid for has not ended yet — they keep the tier until it does.
 */
export type SubscriptionStatus = "none" | "active" | "grace" | "expired" | "cancelled";

/** `dev_grant` exists so a paid tier can be tested before any store integration. */
export type BillingPlatform = "none" | "ios" | "android" | "dev_grant";

export interface ISubscription {
  user_id: string;
  tier: Tier;
  status: SubscriptionStatus;
  platform: BillingPlatform;
  /** Store product identifier, e.g. "evarna.plus.monthly". Null until purchase. */
  product_id: string | null;
  /**
   * The subscription's identity at the store, stable across every renewal.
   * Apple calls it originalTransactionId; on Play the closest equivalent is the
   * first purchase token of the chain. This is what a renewal notification is
   * matched on, which is why it is indexed and unique.
   */
  original_transaction_id: string | null;
  /** Play only: the current purchase token, which rotates on renewal. */
  purchase_token: string | null;
  period_start: Date | null;
  period_end: Date | null;
  expires_at: Date | null;
  auto_renew: boolean;
  /**
   * Top-up wallet, in seconds. Consumable minute packs land here, and it is
   * deliberately separate from the monthly allowance: allowances reset, bought
   * minutes do not.
   *
   * NOT SPENDABLE YET. Usage is derived per period, so anything added on top of
   * it would be re-granted every renewal — one $4.99 pack becoming an unlimited
   * subscription. It becomes spendable when the usage counters land and there is
   * a record of what has been drawn from it. Nothing can buy one in the
   * meantime.
   */
  topup_seconds: number;
  /** When the store last confirmed this state. Null for free and dev grants. */
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Where the current billing period came from, for display and for debugging. */
export type PeriodSource = "subscription" | "signup_anniversary";

export interface BillingPeriod {
  start: Date;
  end: Date;
  source: PeriodSource;
}

/**
 * Everything a gate decision needs, gathered in one pass so `decide()` can stay
 * pure and therefore testable without a database.
 */
export interface EntitlementSnapshot {
  user_id: string;
  tier: Tier;
  status: SubscriptionStatus;
  platform: BillingPlatform;
  auto_renew: boolean;
  expires_at: Date | null;
  period: BillingPeriod;
  /** Billable voice seconds already used in this period. See billableSeconds(). */
  voice_seconds_used: number;
  /** Of which, seconds attributed to calls that are still connected. */
  voice_seconds_in_flight: number;
  /**
   * Live voice sessions right now. Reported rather than decided on: the
   * concurrency ceiling lives in usage.service.ts.
   */
  live_voice_sessions: number;
  topup_seconds: number;
  messages_used_today: number;
  /** The next local midnight for this user — when the message cap resets. */
  messages_reset_at: Date;
  /**
   * True when a read failed and these numbers are not trustworthy. The gate
   * allows in that case: refusing everyone during a database blip turns a
   * degraded database into an outage.
   */
  degraded: boolean;
}

export type StartKind = "voice" | "text";

/**
 * Concurrency is not here on purpose: "two calls at once" is not something a
 * tier sells, so usage.service.ts owns that ceiling and answers it with
 * USAGE_LIMIT_REACHED.
 */
export type RefusalCode = "VOICE_MINUTES_EXHAUSTED" | "DAILY_MESSAGE_CAP";

export interface CanStartAllowed {
  allowed: true;
  tier: Tier;
  voice_seconds_remaining: number;
  messages_remaining_today: number;
}

export interface CanStartRefused {
  allowed: false;
  code: RefusalCode;
  /** The route sends this verbatim. 402 is the one the app turns into a paywall. */
  status: 402 | 429;
  error: string;
  tier: Tier;
  voice_seconds_remaining: number;
  /** ISO instant when the allowance resets, so the refusal can say when. */
  renews_at: string;
  retry_after_seconds?: number;
}

export type CanStartResult = CanStartAllowed | CanStartRefused;

/**
 * What GET /billing/entitlement returns. The app's paywall, top-up sheet and
 * stats hero all read from this one response, so none of them has to hardcode a
 * price, an allowance or a renewal date again — every one of those was a
 * fabricated constant in the client before this existed.
 */
export interface EntitlementView {
  tier: Tier;
  tier_label: string;
  status: SubscriptionStatus;
  platform: BillingPlatform;
  auto_renew: boolean;
  expires_at: string | null;
  voice: {
    allowance_seconds: number;
    topup_seconds: number;
    used_seconds: number;
    in_flight_seconds: number;
    remaining_seconds: number;
  };
  text: {
    daily_cap: number;
    used_today: number;
    remaining_today: number;
    resets_at: string;
  };
  period: {
    start: string;
    end: string;
    /** Same as `end`. Named for the "Renews on" row in settings. */
    renews_at: string;
    source: PeriodSource;
  };
  plans: BillingPlan[];
  topup_packs: TopUpPack[];
  /** True when the numbers above could not be read and are not trustworthy. */
  degraded: boolean;
}
