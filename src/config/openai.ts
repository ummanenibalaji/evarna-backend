import OpenAI from "openai";
import { env } from "./env.js";

let openaiClient: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// Model constants per PRD
export const MODELS = {
  CONVERSATION: "gpt-4o-mini",
  SUMMARIZATION: "gpt-4o-mini",
  EMBEDDING: "text-embedding-3-small",
} as const;
