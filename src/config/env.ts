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
  REDIS_URL: required("REDIS_URL"),
  OPENAI_API_KEY: required("OPENAI_API_KEY"),
  // Sprint 4 — optional until then
  LIVEKIT_API_KEY: process.env["LIVEKIT_API_KEY"] ?? "",
  LIVEKIT_API_SECRET: process.env["LIVEKIT_API_SECRET"] ?? "",
  LIVEKIT_URL: process.env["LIVEKIT_URL"] ?? "",
  DEEPGRAM_API_KEY: process.env["DEEPGRAM_API_KEY"] ?? "",
  HUME_API_KEY: process.env["HUME_API_KEY"] ?? "",
} as const;
