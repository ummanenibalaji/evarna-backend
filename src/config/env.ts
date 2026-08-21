import "dotenv/config";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const env = {
  PORT: parseInt(optional("PORT", "3000"), 10),
  NODE_ENV: optional("NODE_ENV", "development"),
  MONGODB_URI: required("MONGODB_URI"),
  // Signs our own session tokens. Changing it logs everyone out, which is the
  // emergency lever if it ever leaks.
  JWT_SECRET: required("JWT_SECRET"),
  REDIS_URL: required("REDIS_URL"),
  OPENAI_API_KEY: required("OPENAI_API_KEY"),
  // Sprint 4 — optional until then
  LIVEKIT_API_KEY: process.env["LIVEKIT_API_KEY"] ?? "",
  LIVEKIT_API_SECRET: process.env["LIVEKIT_API_SECRET"] ?? "",
  LIVEKIT_URL: process.env["LIVEKIT_URL"] ?? "",
  DEEPGRAM_API_KEY: process.env["DEEPGRAM_API_KEY"] ?? "",
  HUME_API_KEY: process.env["HUME_API_KEY"] ?? "",
  // Auth — comma-separated, because a native app has a different OAuth client
  // id per platform and all of them are valid audiences for the same account.
  GOOGLE_CLIENT_IDS: process.env["GOOGLE_CLIENT_IDS"] ?? "",
  APPLE_CLIENT_IDS: process.env["APPLE_CLIENT_IDS"] ?? "",
  // Optional: without it, email sign-in codes are logged instead of sent.
  RESEND_API_KEY: process.env["RESEND_API_KEY"] ?? "",
  EMAIL_FROM: process.env["EMAIL_FROM"] ?? "Evarna <noreply@evarna.app>",
} as const;
