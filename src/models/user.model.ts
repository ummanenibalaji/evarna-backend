import { Schema, model } from "mongoose";
import type { IUser } from "../types/user.types.js";

// Profile fields are optional because a user document now exists BEFORE
// onboarding: sign-in creates the stub, POST /users/onboard fills it in.
// `onboarding_completed` is the flag that says whether they are populated —
// do not reintroduce `required: true` on them without moving user creation
// back into the onboard route.
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
    created_at: { type: Date, default: () => new Date() },
    last_active_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// One account per provider subject. Unique so a race between two simultaneous
// sign-ins cannot create duplicate users for the same person.
userSchema.index({ auth_provider: 1, provider_sub: 1 }, { unique: true });

export const User = model<IUser>("User", userSchema);
