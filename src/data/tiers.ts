/**
 * What each tier is allowed, and what the store sells.
 *
 * These numbers are a product decision, not an implementation detail: the
 * margin on this product is almost entirely TTS cost, and a voice minute costs
 * roughly $0.085 all-in. Allowances come from the MVP pricing decision; prices
 * come from the paywall screen the app already ships. `check:entitlement` pins
 * every number below, so changing one is a deliberate act rather than a typo.
 *
 * Allowances are stored in SECONDS because voice is billed per connected
 * second, not per started minute. Rounding up to whole minutes is what made a
 * two-minute call cost thirty.
 */
import type { BillingPlan, Tier, TierAllowance, TopUpPack } from "../types/billing.types.js";

export const TIERS: Record<Tier, TierAllowance> = {
  // 8 minutes. Enough to feel what a call is like, not enough to live on.
  free: { voice_seconds: 8 * 60, daily_messages: 100, label: "Free" },
  // 120 minutes. The pricing table flags a heavy Plus user as the one account
  // that can cost more than the store pays us, which is why the gate exists.
  plus: { voice_seconds: 120 * 60, daily_messages: 1_000, label: "Plus" },
  premium: { voice_seconds: 400 * 60, daily_messages: 2_000, label: "Premium" },
};

/**
 * The store catalog. Product ids are deliberately identical on both stores, so
 * one catalog serves iOS and Android.
 */
export const PLANS: BillingPlan[] = [
  {
    tier: "plus",
    label: "Plus",
    voice_minutes: 120,
    monthly_usd: 19.99,
    annual_monthly_usd: 12.49,
    product_ids: { monthly: "evarna.plus.monthly", annual: "evarna.plus.annual" },
  },
  {
    tier: "premium",
    label: "Premium",
    voice_minutes: 400,
    monthly_usd: 39.99,
    annual_monthly_usd: 24.99,
    product_ids: { monthly: "evarna.premium.monthly", annual: "evarna.premium.annual" },
  },
];

/**
 * Consumables. The 30-minute pack was priced at 45 minutes in an early draft,
 * which barely cleared cost — 30 is the number that leaves a margin.
 */
export const TOPUP_PACKS: TopUpPack[] = [
  { id: "topup_30", seconds: 30 * 60, price_usd: 4.99, product_id: "evarna.topup.30" },
  { id: "topup_75", seconds: 75 * 60, price_usd: 9.99, product_id: "evarna.topup.75" },
  { id: "topup_150", seconds: 150 * 60, price_usd: 14.99, product_id: "evarna.topup.150" },
];
