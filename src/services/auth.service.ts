import { randomInt, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { User } from "../models/user.model.js";
import { getRedis } from "../config/redis.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { AuthProvider, IUser } from "../types/user.types.js";
import type { Types } from "mongoose";

// ── Session tokens ───────────────────────────────────────────────────────────
//
// A 30-day HS256 token carrying the user id and their token_version. Revocation
// is a version bump on the user document, which invalidates every device at
// once — deliberately cheaper than a refresh-token table we would have to
// store, index and clean up. If per-device revocation is ever needed, add a
// device id to the payload and a small deny-list; the shape here does not have
// to change.

const SESSION_TTL = "30d";
const secretKey = (): Uint8Array => new TextEncoder().encode(env.JWT_SECRET);

export interface SessionClaims {
  userId: string;
  tokenVersion: number;
}

export async function issueSessionToken(
  userId: string,
  tokenVersion: number,
): Promise<string> {
  return new SignJWT({ v: tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer("evarna")
    .setAudience("evarna-app")
    .setExpirationTime(SESSION_TTL)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: "evarna",
    audience: "evarna-app",
    algorithms: ["HS256"],
  });
  if (!payload.sub) throw new Error("token has no subject");
  return { userId: payload.sub, tokenVersion: Number(payload["v"] ?? 0) };
}

// ── Provider identity tokens ─────────────────────────────────────────────────
//
// Apple and Google both hand the client a signed ID token. We verify the
// signature against the provider's published keys and trust the claims inside.
// That is the whole reason we hold no passwords: there is no credential here to
// leak, reset or hash.
//
// Sign in with Apple is not a nice-to-have. App Store Guideline 4.8 requires it
// in any app that offers another third-party sign-in, so offering Google alone
// would be a rejection.

const JWKS = {
  google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
  apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
} as const;

const ISSUERS: Record<"google" | "apple", string[]> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface ProviderIdentity {
  sub: string;
  email: string | null;
}

function audienceFor(provider: "google" | "apple"): string[] {
  const raw = provider === "google" ? env.GOOGLE_CLIENT_IDS : env.APPLE_CLIENT_IDS;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new AuthError(`${provider} sign-in is not configured on this server`);
  }
  return list;
}

export async function verifyProviderToken(
  provider: "google" | "apple",
  idToken: string,
): Promise<ProviderIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS[provider], {
      issuer: ISSUERS[provider],
      audience: audienceFor(provider),
    }));
  } catch (err) {
    // Never echo the provider's error back to the client — it distinguishes
    // "expired" from "wrong audience" from "bad signature", which is a probing
    // aid and tells an attacker how our config is wrong.
    logger.warn({ err, provider }, "auth: provider token rejected");
    throw new AuthError("Sign-in failed. Please try again.");
  }

  if (!payload.sub) throw new AuthError("Sign-in failed. Please try again.");

  // Apple omits email on every sign-in after the first, and only marks it
  // verified on the first. Google always sends it. Either way the subject is
  // the identity — email is convenience, never the key.
  const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : null;
  return { sub: payload.sub, email };
}

// ── Email one-time codes ─────────────────────────────────────────────────────
//
// A code, not a password: nothing to hash, no reset flow, no credential at rest.
// Codes live in Redis with a TTL so expiry is the store's problem, not ours.
//
// ponytail: delivery falls back to a log line when no email provider is
// configured, so sign-in works in development with no third-party account.
// Wiring a real sender is one function — see sendCode below.

const OTP_TTL_SECONDS = 600;
const OTP_MAX_ATTEMPTS = 5;
const otpKey = (email: string): string => `otp:${email}`;

interface OtpRecord {
  code: string;
  attempts: number;
}

async function sendCode(email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    logger.warn(
      { email, code },
      "auth: no RESEND_API_KEY set — email code logged instead of sent (development only)",
    );
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: `${code} is your Evarna code`,
      text: `Your Evarna sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
    }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, email }, "auth: email send failed");
    throw new AuthError("Could not send the code. Please try again.");
  }
}

export async function requestEmailCode(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  // randomInt is the cryptographic generator; Math.random would make codes
  // predictable from one another, which is the whole attack here.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const record: OtpRecord = { code, attempts: 0 };
  await getRedis().set(otpKey(normalized), JSON.stringify(record), "EX", OTP_TTL_SECONDS);
  await sendCode(normalized, code);
}

export async function verifyEmailCode(email: string, code: string): Promise<ProviderIdentity> {
  const normalized = email.trim().toLowerCase();
  const key = otpKey(normalized);
  const raw = await getRedis().get(key);
  if (!raw) throw new AuthError("That code has expired. Request a new one.");

  const record = JSON.parse(raw) as OtpRecord;

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await getRedis().del(key);
    throw new AuthError("Too many attempts. Request a new code.");
  }

  const supplied = Buffer.from(code.trim());
  const expected = Buffer.from(record.code);
  const ok = supplied.length === expected.length && timingSafeEqual(supplied, expected);

  if (!ok) {
    record.attempts += 1;
    // Keep the original TTL — a wrong guess must not extend the window.
    const ttl = await getRedis().ttl(key);
    await getRedis().set(key, JSON.stringify(record), "EX", Math.max(1, ttl));
    throw new AuthError("That code is not right.");
  }

  await getRedis().del(key);
  // The email IS the subject here: we just proved control of the inbox.
  return { sub: normalized, email: normalized };
}

// ── User resolution ──────────────────────────────────────────────────────────

export interface AuthedUser {
  _id: Types.ObjectId;
  token_version: number;
  onboarding_completed: boolean;
}

/**
 * Find the user behind a verified identity, or create a stub.
 *
 * Sign-in now comes BEFORE onboarding, so the user document exists with almost
 * nothing on it until POST /users/onboard fills it in. That is why the profile
 * fields on the model are optional — `onboarding_completed` is what says whether
 * they have been supplied.
 *
 * Matching is by (provider, provider_sub), never by email alone: email is
 * mutable at the provider, Apple hides it behind a relay, and matching on it
 * would let someone take over an account by changing their address.
 */
export async function findOrCreateUser(
  provider: AuthProvider,
  identity: ProviderIdentity,
): Promise<AuthedUser> {
  const existing = await User.findOne({ auth_provider: provider, provider_sub: identity.sub })
    .select("token_version onboarding_completed")
    .lean();

  if (existing) {
    return {
      _id: existing._id,
      token_version: existing.token_version ?? 0,
      onboarding_completed: existing.onboarding_completed,
    };
  }

  const created = await User.create({
    auth_provider: provider,
    provider_sub: identity.sub,
    email: identity.email,
    onboarding_completed: false,
    token_version: 0,
  });

  logger.info({ provider, userId: created._id.toString() }, "auth: new user");
  return {
    _id: created._id,
    token_version: created.token_version,
    onboarding_completed: created.onboarding_completed,
  };
}

/** Invalidate every session for this user by bumping the version in their token. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { token_version: 1 } });
}
