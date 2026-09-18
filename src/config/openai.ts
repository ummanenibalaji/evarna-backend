import OpenAI from "openai";
import { env } from "./env.js";

let openaiClient: OpenAI | null = null;
let conversationClient: OpenAI | null = null;

/**
 * The OpenAI client. Used for embeddings, moderation and summarisation —
 * everything that is NOT the conversation model.
 */
export function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ── Swappable conversation model ─────────────────────────────────────────────
//
// The reply model is the one thing on the voice critical path, and from India
// OpenAI's first token measures ~740ms — almost all of it the round trip to a US
// origin, not inference (a request that does NO inference takes ~1000ms).
//
// A local model removes that entirely: llama3:8b on this machine answers in
// ~246ms. It generates more slowly once started (58 vs ~100 tok/s), so on a
// short spoken reply the net saving is roughly 350ms.
//
// ONLY the conversation model is switchable, deliberately:
//   - EMBEDDING must stay OpenAI. The Atlas vector index is built on 1536-dim
//     text-embedding-3-small; a model with different dimensions does not fail
//     loudly, it silently returns no memories.
//   - MODERATION must stay OpenAI. It is the crisis-detection gate and has no
//     equivalent endpoint locally.
//   - SUMMARISATION stays OpenAI: it is off the critical path, so there is
//     nothing to win and quality matters for what gets written to memory.
//
// Anything OpenAI-compatible works. For Ollama:
//   LLM_BASE_URL=http://localhost:11434/v1
//   LLM_MODEL=llama3:latest
export function isLocalConversationModel(): boolean {
  return env.LLM_BASE_URL.length > 0;
}

export function getConversationClient(): OpenAI {
  if (!isLocalConversationModel()) return getOpenAI();
  if (!conversationClient) {
    conversationClient = new OpenAI({
      baseURL: env.LLM_BASE_URL,
      // Ollama ignores the key but the SDK requires one to be present.
      apiKey: env.LLM_API_KEY || "not-needed",
    });
  }
  return conversationClient;
}

export function getConversationModel(): string {
  return env.LLM_MODEL || MODELS.CONVERSATION;
}

// ── Keeping a local model resident and its prompt cache warm ────────────────
//
// Ollama unloads an idle model after 5 minutes, and its OpenAI-compatible
// endpoint IGNORES `keep_alive` — measured on 0.34: a request carrying
// keep_alive "47m" still expired 5 minutes later, and every request resets the
// timer to 5 minutes. Only the native API honours it. So residency is set
// through /api/*, while the conversation itself stays on /v1.
//
// LLM_KEEP_ALIVE is an Ollama duration ("30m", "2h", or "-1" for forever).
const LLM_KEEP_ALIVE = process.env["LLM_KEEP_ALIVE"] ?? "30m";

/** The native Ollama API root for LLM_BASE_URL ("http://host:11434/v1" -> "http://host:11434"). */
function localNativeBase(): string {
  return env.LLM_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Extend how long the local model stays loaded. A prompt-less /api/generate
 * only (re)loads the model and sets its expiry — no inference, and measured,
 * the prompt cache survives it (the next request reused all 911 cached
 * tokens). Fire-and-forget: it must never delay or fail a turn.
 */
export function keepLocalModelLoaded(): void {
  if (!isLocalConversationModel()) return;
  void fetch(`${localNativeBase()}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: getConversationModel(), keep_alive: LLM_KEEP_ALIVE }),
  }).catch(() => {});
}

/**
 * Evaluate `messages` on the local model once, so its KV cache holds them.
 *
 * A later request whose prompt starts with the same tokens only evaluates what
 * follows — measured on this machine at ~880 tokens/s cold, so a ~1,700-token
 * companion prompt costs ~1.9s the first time and ~0.1s once cached. Sent to
 * the native API because that is the only one that honours keep_alive; the
 * chat template, and therefore the cached prefix, is the same on both.
 */
export async function primeLocalModel(
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  if (!isLocalConversationModel()) return;
  const res = await fetch(`${localNativeBase()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: getConversationModel(),
      messages,
      stream: false,
      keep_alive: LLM_KEEP_ALIVE,
      // One token: this is about the prompt, not the answer. No other options,
      // because a request with different model options can force a reload.
      options: { num_predict: 1 },
    }),
  });
  if (!res.ok) throw new Error(`local model prime failed: HTTP ${res.status}`);
  await res.arrayBuffer();
}

/**
 * GPT-5.x reasons by default, and reasoning tokens count against
 * max_completion_tokens. Measured on this key: at "low", 13-17 of a 150-token
 * voice reply went on thinking and first token went from ~1.0s to 1.9s. At
 * "none" it used 0 reasoning tokens with first token on par with gpt-4o-mini,
 * and it is the only effort at which `temperature` is accepted.
 *
 * gpt-4o-mini rejects the field outright, so it is sent only to GPT-5 models —
 * otherwise rolling back via LLM_MODEL would fail every reply.
 */
export function conversationReasoningEffort(): "none" | undefined {
  return !isLocalConversationModel() && getConversationModel().startsWith("gpt-5") ? "none" : undefined;
}

// Model constants per PRD
export const MODELS = {
  // gpt-5.6-luna: compared with gpt-5.5, gpt-5.6-terra, gpt-5.4-mini and
  // gpt-4o-mini on the real companion prompt (grief, "I'm fine", a bad plan, an
  // unfair accusation). Close to 5.5 on all four, with first token matching
  // gpt-4o-mini (~690ms median), at $0.20/$1.20 per 1M tokens vs 5.5's $5/$30.
  // gpt-5.4-mini was as fast but joked through grief. Set LLM_MODEL=gpt-5.5 to
  // use the stronger model, e.g. for a paid tier.
  CONVERSATION: "gpt-5.6-luna",
  SUMMARIZATION: "gpt-4o-mini",
  EMBEDDING: "text-embedding-3-small",
} as const;
