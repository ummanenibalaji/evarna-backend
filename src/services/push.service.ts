import { User } from "../models/user.model.js";
import { logger } from "../utils/logger.js";

// ── Expo push delivery ───────────────────────────────────────────────────────
//
// Plain fetch, no SDK — the whole API is one POST (same reasoning as the Resend
// call in auth.service.ts). Expo push tokens need no auth header; the token
// itself is the address.
//
// This module exists for one distinction: a token that is dead forever versus a
// send that failed this time. Getting that wrong means either pushing at a
// deleted install until the end of time, or dropping a user after one blip.

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type PushResult =
  /** Expo accepted the message. */
  | "ok"
  /** The device unregistered. Stop sending: clear the token (see clearPushToken). */
  | "invalid_token"
  /** Transient. The token is still good; try again later. */
  | "failed";

export interface PushInput {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushResponse {
  data?: {
    status?: "ok" | "error";
    message?: string;
    details?: { error?: string };
  };
}

/**
 * A push token is a device identifier — never log it whole. The tail is enough
 * to correlate two log lines about the same device without being one.
 */
const redact = (token: string): string => `...${token.slice(-6)}`;

export async function sendPush(input: PushInput): Promise<PushResult> {
  const to = redact(input.to);

  // ponytail: one message per request. Expo's endpoint also accepts an array
  // (up to 100 messages) and hands back one ticket each, which is the upgrade
  // path once the scheduler fans out to more than a handful of users per tick —
  // batch there, and read the receipts endpoint for per-ticket outcomes.
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      to: input.to,
      title: input.title,
      body: input.body,
      ...(input.data ? { data: input.data } : {}),
    }),
  }).catch((err: unknown) => {
    logger.error({ err, to }, "push: request to Expo failed");
    return null;
  });

  if (!res) return "failed";

  if (!res.ok) {
    logger.error({ status: res.status, to }, "push: non-2xx from Expo");
    return "failed";
  }

  // Expo answers 200 with the error inside the body, so the HTTP status on its
  // own says nothing. `data.status` is the real answer.
  const payload = (await res.json().catch(() => null)) as ExpoPushResponse | null;
  const ticket = payload?.data;

  if (ticket?.status === "ok") return "ok";

  // DeviceNotRegistered is the only permanent one: the app was uninstalled or
  // notifications were revoked, and this token will never deliver again.
  // MessageTooBig / MessageRateExceeded / InvalidCredentials are ours to fix or
  // wait out, so they stay retryable.
  if (ticket?.details?.error === "DeviceNotRegistered") {
    logger.warn({ to, message: ticket.message }, "push: device unregistered — token should be cleared");
    return "invalid_token";
  }

  logger.error(
    { to, error: ticket?.details?.error, message: ticket?.message, status: ticket?.status },
    "push: Expo rejected the message",
  );
  return "failed";
}

/**
 * Null out a dead token. Exported so the scheduler can act on `invalid_token`
 * without reaching for the User model itself.
 */
export async function clearPushToken(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { push_token: null } });
  logger.info({ userId }, "push: cleared push token");
}
