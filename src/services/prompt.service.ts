import { approximateTokensForMessages } from "../utils/token-counter.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";

export interface AssembledPrompt {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  total_tokens: number;
}

// Prompt order: system persona → memory block → usage summary → compressed older turns → verbatim recent turns → user message
export function assemblePrompt(
  systemPrompt: string,
  sessionContext: IRedisSessionContext,
  userMessage: string,
  memoryBlock?: string | null,
  usageSummary?: string | null
): AssembledPrompt {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  messages.push({ role: "system", content: systemPrompt });

  if (memoryBlock) {
    messages.push({ role: "system", content: memoryBlock });
  }

  if (usageSummary) {
    messages.push({ role: "system", content: usageSummary });
  }

  if (sessionContext.compressed_summary) {
    messages.push({
      role: "system",
      content: `[Earlier in this conversation]: ${sessionContext.compressed_summary}`,
    });
  }

  for (const turn of sessionContext.turns) {
    messages.push({
      role: turn.role as "user" | "assistant",
      content: turn.content,
    });
  }

  messages.push({ role: "user", content: userMessage });

  return {
    messages,
    total_tokens: approximateTokensForMessages(messages),
  };
}
