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
  // Resolved BEFORE the try, deliberately. audienceFor() throws when the server
  // has no client ids configured, and inside the try that would be swallowed
  // and re-reported as the generic "Sign-in failed" below — telling whoever is
  // setting this up nothing at all. A configuration fault and a bad token are
  // different problems and deserve different messages.
  const audience = audienceFor(provider);

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS[provider], {
      issuer: ISSUERS[provider],
      audience,
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

/**
 * Returns true when the code actually reached a mail provider.
 *
 * It used to return void and the route always answered `sent: true`, so with no
 * provider configured the app told people to check an inbox nothing had been
 * sent to. Sign-in appeared to work and then simply never completed.
 */
async function sendCode(email: string, code: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    // assertEmailDeliverable() has already refused to boot in production, so
    // reaching here means development, where the code comes back in the
    // response instead — see requestEmailCode.
    logger.warn(
      { email, code },
      "auth: no RESEND_API_KEY set — code returned in the response (development only)",
    );
    return false;
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
    // The body carries the actual reason — almost always an unverified `from`
    // domain — and without it this is an unexplained 502 at the one moment a
    // user cannot get past.
    const detail = await res.text().catch(() => "");
    logger.error({ status: res.status, email, detail }, "auth: email send failed");
    throw new AuthError("Could not send the code. Please try again.");
  }
  return true;
}

/**
 * Called once at boot. A production server with no mail provider cannot sign
 * anybody in, and the only way that used to surface was as users silently
 * failing to receive codes. Fail at startup instead, where someone is looking.
 */
// Arguments default to the live config but are injectable, because env.* is
// snapshotted at import and cannot be varied from a test otherwise.
export function assertEmailDeliverable(
  nodeEnv: string = env.NODE_ENV,
  apiKey: string = env.RESEND_API_KEY,
): void {
  if (nodeEnv === "production" && !apiKey) {
    throw new Error(
      "RESEND_API_KEY is required in production: without it no sign-in code can be delivered.",
    );
  }
}

/**
 * Requesting a code is unauthenticated and writes to Redis and a paid mail
 * provider, so it needs a ceiling on both axes.
 *
 * Per address, because each request mints a FRESH code and resets the attempt
 * counter — without a cap, "request, guess five times, repeat" walks the whole
 * six-digit space with no lockout ever engaging.
 * Per IP, because otherwise one script can mail-bomb arbitrary strangers from
 * your domain and burn your sending reputation doing it.
 */
const OTP_MAX_PER_EMAIL_PER_HOUR = 5;
const OTP_MAX_PER_IP_PER_HOUR = 20;
const RATE_WINDOW_SECONDS = 3600;

export class RateLimitedError extends Error {
  constructor() {
    super("Too many codes requested. Please wait a while and try again.");
    this.name = "RateLimitedError";
  }
}

async function bump(key: string, limit: number): Promise<boolean> {
  const redis = getRedis();
  const count = await redis.incr(key);
  // Only the first increment sets the expiry, so the window is fixed from the
  // first request rather than sliding forward on every hit — which would let a
  // steady trickle keep the key alive forever.
  if (count === 1) await redis.expire(key, RATE_WINDOW_SECONDS);
  return count <= limit;
}

export interface EmailCodeResult {
  /** True only if a mail provider accepted it. */
  delivered: boolean;
  /** Development only, when nothing could be delivered. Never set in production. */
  devCode?: string;
}

export async function requestEmailCode(
  email: string,
  requesterIp?: string,
): Promise<EmailCodeResult> {
  const normalized = email.trim().toLowerCase();

  const withinEmailLimit = await bump(`otp:rl:email:${normalized}`, OTP_MAX_PER_EMAIL_PER_HOUR);
  const withinIpLimit = requesterIp
    ? await bump(`otp:rl:ip:${requesterIp}`, OTP_MAX_PER_IP_PER_HOUR)
    : true;
  if (!withinEmailLimit || !withinIpLimit) {
    logger.warn({ email: normalized, requesterIp }, "auth: code request rate limited");
    throw new RateLimitedError();
  }

  // randomInt is the cryptographic generator; Math.random would make codes
  // predictable from one another, which is the whole attack here.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const record: OtpRecord = { code, attempts: 0 };
  await getRedis().set(otpKey(normalized), JSON.stringify(record), "EX", OTP_TTL_SECONDS);
  const delivered = await sendCode(normalized, code);
  // Guarded twice on purpose. assertEmailDeliverable() makes this branch
  // unreachable in production; this makes handing the caller a valid code
  // impossible there even if that guard is ever removed.
  if (!delivered && env.NODE_ENV !== "production") {
    return { delivered: false, devCode: code };
  }
  return { delivered };
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
