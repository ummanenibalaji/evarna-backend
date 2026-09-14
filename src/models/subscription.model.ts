import { Schema, model } from "mongoose";
import type { ISubscription } from "../types/billing.types.js";

/**
 * One document per user, holding the CURRENT entitlement state.
 *
 * Not a ledger of purchases, deliberately. `canStart()` runs on every message
 * and every call start, and deriving "what is this person entitled to right
 * now" from a purchase history means a sort-and-scan on the hot path. The
 * authoritative history lives at the store anyway — Apple and Google both keep
 * it and both will replay it — so a renewal notification upserts this document.
 * If a local audit trail is ever wanted, it belongs in its own collection
 * written by the store webhook, not in the shape the gate reads.
 *
 * A user with no document here is a free user. That is the normal case, and
 * nothing in the read path creates one: the only writers are the store
 * integration (later) and the dev grant script.
 */
const subscriptionSchema = new Schema<ISubscription>(
  {
    user_id: { type: String, required: true, unique: true },
    tier: { type: String, enum: ["free", "plus", "premium"], default: "free" },
    status: {
      type: String,
      enum: ["none", "active", "grace", "expired", "cancelled"],
      default: "none",
    },
    platform: {
      type: String,
      enum: ["none", "ios", "android", "dev_grant"],
      default: "none",
    },
    product_id: { type: String, default: null },
    original_transaction_id: { type: String, default: null },
    purchase_token: { type: String, default: null },
    period_start: { type: Date, default: null },
    period_end: { type: Date, default: null },
    // Kept alongside period_end rather than folded into it: the store's notion
    // of when access ends is not always the period boundary (grace periods
    // extend access past period_end), and entitlement follows expires_at.
    expires_at: { type: Date, default: null },
    auto_renew: { type: Boolean, default: false },
    topup_seconds: { type: Number, default: 0, min: 0 },
    last_verified_at: { type: Date, default: null },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// A store notification arrives knowing only the subscription's own id, so this
// is the lookup the renewal/refund handler will make. Sparse because every free
// user leaves it null, and unique so two accounts cannot claim one purchase —
// which is the shape of the most common receipt-sharing fraud.
subscriptionSchema.index({ original_transaction_id: 1 }, { unique: true, sparse: true });

export const Subscription = model<ISubscription>("Subscription", subscriptionSchema);
