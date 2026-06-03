import { getOpenAI, MODELS } from "../config/openai.js";
import { setSessionContext } from "./session-context.service.js";
import { approximateTokens } from "../utils/token-counter.js";
import { logger } from "../utils/logger.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";

const COMPRESSION_THRESHOLD = 3500;
const TURNS_TO_COMPRESS = 10;

const COMPRESSION_PROMPT =
  "Summarize this conversation segment in 3-4 sentences. " +
  "Keep key facts, decisions, emotional shifts, and important details mentioned by the user. Be concise.";

export async function compressIfNeeded(
  sessionId: string,
  ctx: IRedisSessionContext
): Promise<IRedisSessionContext> {
  if (
    ctx.total_token_count <= COMPRESSION_THRESHOLD ||
    ctx.turns.length <= TURNS_TO_COMPRESS
  ) {
    return ctx;
  }

  const turnsToCompress = ctx.turns.slice(0, TURNS_TO_COMPRESS);
  const remainingTurns = ctx.turns.slice(TURNS_TO_COMPRESS);

  const conversationText = turnsToCompress
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  let newSummary: string;
  try {
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model: MODELS.SUMMARIZATION,
      messages: [
        { role: "system", content: COMPRESSION_PROMPT },
        { role: "user", content: conversationText },
      ],
      max_tokens: 150,
      temperature: 0.3,
    });
    newSummary = response.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    logger.error({ err, sessionId }, "Context compression LLM call failed — keeping original");
    return ctx;
  }

  if (!newSummary) return ctx;

  const updatedSummary = ctx.compressed_summary
    ? `${ctx.compressed_summary}\n${newSummary}`
    : newSummary;

  const summaryTokens = approximateTokens(updatedSummary);
  const turnTokens = remainingTurns.reduce((sum, t) => sum + approximateTokens(t.content), 0);

  const updatedCtx: IRedisSessionContext = {
    compressed_summary: updatedSummary,
    turns: remainingTurns,
    total_token_count: summaryTokens + turnTokens,
  };

  await setSessionContext(sessionId, updatedCtx);

  logger.info(
    {
      sessionId,
      before: ctx.total_token_count,
      after: updatedCtx.total_token_count,
      compressedTurns: TURNS_TO_COMPRESS,
    },
    "Session context compressed"
  );

  return updatedCtx;
}
