import { Schema, model } from "mongoose";
import type { IUser } from "../types/user.types.js";

// Profile fields are optional because a user document now exists BEFORE
// onboarding: sign-in creates the stub, POST /users/onboard fills it in.
// `onboarding_completed` is the flag that says whether they are populated —
// do not reintroduce `required: true` on them without moving user creation
// back into the onboard route.
// Another way the same person has signed in. See findOrCreateUser for when
// one is added: only on a provider-verified email that already owns an account.
const linkedIdentitySchema = new Schema(
  {
    provider: { type: String, enum: ["google", "apple", "email"], required: true },
    sub: { type: String, required: true },
    linked_at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    // ── identity ──────────────────────────────────────────────────────────
    auth_provider: {
      type: String,
      enum: ["google", "apple", "email"],
      required: true,
    },
    // The provider's stable subject claim. Never the email: email is mutable
    // at the provider and Apple hides it behind a relay, so matching on it
    // would let an address change become an account takeover.
    provider_sub: { type: String, required: true },
    // The account is still keyed by the method that created it (the two fields
    // above). These are the additional methods linked to it since.
    linked_identities: { type: [linkedIdentitySchema], default: [] },
    email: { type: String, default: null, lowercase: true, trim: true },
    // Bumped to invalidate every issued session token at once.
    token_version: { type: Number, default: 0 },

    // ── profile, supplied at onboarding ───────────────────────────────────
    display_name: { type: String, trim: true },
    gender: {
      type: String,
      enum: ["male", "female", "nonbinary", "undisclosed"],
    },
    date_of_birth: { type: Date },
    // Snapshot for querying only. Never trust it for a decision — it is
    // computed once and a birthday makes it stale. Derive from date_of_birth
    // at the point of use (see isMinorNow in utils/age.ts).
    is_minor: { type: Boolean, default: false },
    communication_style: {
      type: String,
      enum: ["warm", "direct", "funny", "calm"],
    },
    onboarding_completed: { type: Boolean, default: false },

    // ── push delivery ─────────────────────────────────────────────────────
    // Expo push token, `ExponentPushToken[xxxxxxxx]`. Null means no device is
    // registered (never installed, or notifications revoked) — and Expo may
    // tell us a token is dead (DeviceNotRegistered), which nulls it again.
    push_token: { type: String, default: null },
    // IANA name, e.g. "Asia/Kolkata". The scheduler needs it for quiet hours
    // (nothing sent 22:00-08:00 local). Refreshed from the device on every
    // launch rather than asked once at signup: people travel, and a stale
    // timezone means a notification at 3am.
    timezone: { type: String, default: null },
    // Settings → Daily check-in. Off stops proactive outreach: scheduled
    // follow-ups and the post-crisis check-in. Replies the user asked for are
    // not outreach, so their notifications still arrive.
    checkins_enabled: { type: Boolean, default: true },
    created_at: { type: Date, default: () => new Date() },
    last_active_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// One account per provider subject. Unique so a race between two simultaneous
// sign-ins cannot create duplicate users for the same person.
// Partial: users from before sign-in existed (Aug 2026) have neither field,
// and a plain unique index cannot be built over them all sharing null.
userSchema.index(
  { auth_provider: 1, provider_sub: 1 },
  { unique: true, partialFilterExpression: { provider_sub: { $type: "string" } } },
);

// A linked identity belongs to exactly one account. Partial because most users
// have none, and a plain unique index would collide on the missing value.
userSchema.index(
  { "linked_identities.provider": 1, "linked_identities.sub": 1 },
  { unique: true, partialFilterExpression: { "linked_identities.sub": { $exists: true } } },
);

// Linking looks accounts up by verified email.
userSchema.index({ email: 1 });

export const User = model<IUser>("User", userSchema);
