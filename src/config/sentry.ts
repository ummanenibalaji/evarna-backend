import * as Sentry from "@sentry/node";
import { env } from "./env.js";

// ── Crash reporting ──────────────────────────────────────────────────────────
//
// Errors only, no performance tracing. Tracing is what needs Sentry's
// `--import` preload in ESM; capturing an error does not, so the start commands
// stay as they are.
//
// Nothing is sent without SENTRY_DSN, so development, checks and scripts are
// unaffected. Reports come from the logger (utils/logger.ts), not from call
// sites: every existing `logger.error({ err }, …)` is reported, and a new one
// is reported without anyone remembering to add it.
//
// This file must not import the logger, which imports it.

let enabled = false;

export function initSentry(): boolean {
  if (!env.SENTRY_DSN || enabled) return enabled;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    sendDefaultPii: false,
    // Belt and braces. Nothing here attaches request bodies, but a future
    // integration might, and a request body here is someone's conversation.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) delete event.request.headers["authorization"];
      }
      return event;
    },
  });
  enabled = true;
  return true;
}

/**
 * Sends a logged error to Sentry. Only the error and the log line's message go
 * out, never the other fields: log objects carry emails, session ids and model
 * error text, which the logs may hold and a third party should not.
 *
 * A 4xx is a caller's mistake, not a defect, and would bury real errors.
 */
export function reportLoggedError(fields: unknown, msg: unknown): void {
  if (!enabled || !fields || typeof fields !== "object") return;
  const err = (fields as { err?: unknown }).err;
  if (!(err instanceof Error)) return;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status === "number" && status < 500) return;
  Sentry.captureException(err, { extra: typeof msg === "string" ? { log: msg } : {} });
}

/** Waits for queued reports to send. Call before exiting. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (enabled) await Sentry.close(timeoutMs);
}
