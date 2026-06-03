import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { Character } from "../models/character.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { checkModeration, getCrisisResponse } from "./safety.service.js";
import {
  getSessionContext,
  appendTurn,
  cacheCharacterConfig,
  getCachedCharacterConfig,
} from "./session-context.service.js";
import { assemblePrompt } from "./prompt.service.js";
import { compressIfNeeded } from "./context-compression.service.js";
import { retrieveMemories } from "./memory-retrieval.service.js";
import { getLatestUsageSummary, formatUsageSummary } from "./memory-summary.service.js";
import { approximateTokens } from "../utils/token-counter.js";
import { logger } from "../utils/logger.js";
import type { IPersonaConfig } from "../types/character.types.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";
import type { ModerationResult } from "./safety.service.js";

export interface ConversationParams {
  sessionId: string;
  characterId: string;
  userId: string;
  message: string;
}

export type ConversationEvent =
  | { type: "chunk"; content: string }
  | { type: "crisis"; content: string }
  | { type: "done"; turn_id: string; tokens_used: { input: number; output: number } }
  | { type: "error"; message: string };

// ─── helpers ────────────────────────────────────────────────────────────────

async function getPersonaConfig(characterId: string): Promise<IPersonaConfig> {
  const cached = await getCachedCharacterConfig(characterId);
  if (cached) return cached as IPersonaConfig;

  const character = await Character.findById(characterId).lean();
  if (!character) throw new Error(`Character not found: ${characterId}`);

  await cacheCharacterConfig(characterId, character.persona_config);
  return character.persona_config;
}

async function persistTurns(
  sessionId: string,
  characterId: string,
  userId: string,
  userMessage: string,
  assistantMessage: string,
  tokensUsed: { input: number; output: number },
  userModeration: ModerationResult,
  latency_ms: number,
  assistantTurnId: Types.ObjectId
): Promise<void> {
  const sessionObjId = new Types.ObjectId(sessionId);
  const characterObjId = new Types.ObjectId(characterId);
  const now = new Date();

  await ConversationTurn.insertMany([
    {
      session_id: sessionObjId,
      character_id: characterObjId,
      user_id: userId,
      role: "user",
      content_text: userMessage,
      content_audio_url: null,
      safety_flags: {
        categories: userModeration.categories,
        flagged: userModeration.flagged,
      },
      tokens_used: { input: tokensUsed.input, output: 0 },
      model_used: MODELS.CONVERSATION,
      latency_ms: 0,
      created_at: now,
    },
    {
      _id: assistantTurnId,
      session_id: sessionObjId,
      character_id: characterObjId,
      user_id: userId,
      role: "assistant",
      content_text: assistantMessage,
      content_audio_url: null,
      safety_flags: { categories: {}, flagged: false },
      tokens_used: { input: 0, output: tokensUsed.output },
      model_used: MODELS.CONVERSATION,
      latency_ms,
      created_at: new Date(now.getTime() + 1),
    },
  ]);
}

// ─── main generator ─────────────────────────────────────────────────────────

export async function* streamConversation(
  params: ConversationParams
): AsyncGenerator<ConversationEvent> {
  const { sessionId, characterId, userId, message } = params;

  const EMPTY_CTX: IRedisSessionContext = {
    compressed_summary: "",
    turns: [],
    total_token_count: 0,
  };

  // Phase 1: all I/O in parallel — persona, session context, safety, memory, summary
  const [personaConfig, rawSessionCtx, modResult, memoryBlock, latestSummary] =
    await Promise.all([
      getPersonaConfig(characterId),
      getSessionContext(sessionId).then((ctx) => ctx ?? EMPTY_CTX),
      checkModeration(message),
      retrieveMemories(characterId, message).catch((err) => {
        logger.error({ err, characterId }, "Memory retrieval failed — proceeding without memories");
        return "";
      }),
      getLatestUsageSummary(characterId).catch((err) => {
        logger.error({ err, characterId }, "Usage summary fetch failed — proceeding without it");
        return null;
      }),
    ]);

  // 2. Crisis path — inject safety response, skip LLM
  if (modResult.is_crisis) {
    const crisis = getCrisisResponse();
    yield { type: "crisis", content: crisis };

    const assistantTurnId = new Types.ObjectId();
    void persistTurns(
      sessionId, characterId, userId, message, crisis,
      { input: 0, output: 0 }, modResult, 0, assistantTurnId
    ).catch((err) => logger.error({ err }, "Failed to persist crisis turns"));

    void (async () => {
      await appendTurn(sessionId, "user", message);
      await appendTurn(sessionId, "assistant", crisis);
    })().catch((err) => logger.error({ err }, "Failed to update Redis after crisis"));

    return;
  }

  if (modResult.flagged) {
    logger.warn({ sessionId, userId }, "User message flagged (not crisis) — proceeding");
  }

  // 3. Context compression: if session context is over 3,500 tokens, compress oldest 10 turns
  const sessionCtx = await compressIfNeeded(sessionId, rawSessionCtx);

  // 4. Assemble prompt: system + memory block + usage summary + session context + user message
  const usageSummaryText = latestSummary ? formatUsageSummary(latestSummary) : null;

  const { messages, total_tokens } = assemblePrompt(
    personaConfig.system_prompt,
    sessionCtx,
    message,
    memoryBlock || null,
    usageSummaryText
  );

  // 5. Stream from LLM
  const openai = getOpenAI();
  const startTime = Date.now();
  const assistantTurnId = new Types.ObjectId();

  let fullContent = "";
  let outputTokens = 0;

  try {
    const stream = await openai.chat.completions.create({
      model: MODELS.CONVERSATION,
      messages,
      stream: true,
      max_completion_tokens: 600,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        fullContent += token;
        yield { type: "chunk", content: token };
      }
      if (chunk.usage) {
        outputTokens = chunk.usage.completion_tokens;
      }
    }
  } catch (err) {
    logger.error({ err, sessionId }, "LLM streaming error");
    yield { type: "error", message: "Companion is unavailable right now. Please try again." };
    return;
  }

  const latency_ms = Date.now() - startTime;
  const tokensUsed = {
    input: total_tokens,
    output: outputTokens || approximateTokens(fullContent),
  };

  // 6. Output moderation — log only, never block (Phase 1 per PRD)
  checkModeration(fullContent)
    .then((outMod) => {
      if (outMod.flagged) {
        logger.warn({ sessionId, characterId }, "LLM output flagged by moderation");
      }
    })
    .catch((err) => logger.error({ err }, "Output moderation check failed"));

  // 7. Persist turns to MongoDB (non-blocking)
  void persistTurns(
    sessionId, characterId, userId, message, fullContent,
    tokensUsed, modResult, latency_ms, assistantTurnId
  ).catch((err) => logger.error({ err }, "Failed to persist conversation turns"));

  // 8. Update Redis session context
  void (async () => {
    await appendTurn(sessionId, "user", message);
    await appendTurn(sessionId, "assistant", fullContent);
  })().catch((err) => logger.error({ err }, "Failed to update Redis session context"));

  yield {
    type: "done",
    turn_id: assistantTurnId.toString(),
    tokens_used: tokensUsed,
  };
}
