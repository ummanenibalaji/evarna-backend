import { env } from "../config/env.js";

// ── Hume EVI ──────────────────────────────────────────────────────────────────
//
// The optional EVI voice path. Hume does speech-to-text, turn-taking, tone of
// voice and speech; our reply still comes from streamConversation(), which EVI
// reaches through the custom-language-model endpoint in voice.routes.ts. So
// memory, moderation, crisis handling and persistence are the same code as the
// text and LiveKit paths — EVI only replaces the audio around them.

export class EviNotConfiguredError extends Error {
  constructor() {
    super("Hume EVI is not configured. Set HUME_API_KEY, HUME_SECRET_KEY and HUME_EVI_CONFIG_ID.");
    this.name = "EviNotConfiguredError";
  }
}

/**
 * A short-lived (30 minute) Hume access token the app opens the EVI socket
 * with. The API key and secret never leave the server.
 */
export async function getHumeAccessToken(): Promise<string> {
  if (!env.HUME_API_KEY || !env.HUME_SECRET_KEY || !env.HUME_EVI_CONFIG_ID) {
    throw new EviNotConfiguredError();
  }
  const basic = Buffer.from(`${env.HUME_API_KEY}:${env.HUME_SECRET_KEY}`).toString("base64");
  const res = await fetch("https://api.hume.ai/oauth2-cc/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Hume token request failed with HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string") throw new Error("Hume token response had no access_token");
  return json.access_token;
}

/** One OpenAI-format streaming chunk, as EVI expects it. */
export function clmChunk(sessionId: string, content: string | null, finish: "stop" | null = null): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${sessionId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "evarna-companion",
    // EVI reads the session back from here.
    system_fingerprint: sessionId,
    choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finish }],
  })}\n\n`;
}
