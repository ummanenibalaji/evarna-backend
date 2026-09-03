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

// Model constants per PRD
export const MODELS = {
  CONVERSATION: "gpt-4o-mini",
  SUMMARIZATION: "gpt-4o-mini",
  EMBEDDING: "text-embedding-3-small",
} as const;
