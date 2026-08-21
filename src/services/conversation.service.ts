import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { Character } from "../models/character.model.js";
import { User } from "../models/user.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { checkModeration, getCrisisResponse } from "./safety.service.js";
import {
  getSessionContext,
  appendTurn,
  cacheCharacterConfig,
  getCachedCharacterConfig,
} from "./session-context.service.js";
import { assemblePrompt } from "./prompt.service.js";
import type { UserPersonalizationContext } from "./prompt.service.js";
import { compressIfNeeded } from "./context-compression.service.js";
import { retrieveMemories } from "./memory-retrieval.service.js";
import { getLatestUsageSummary, formatUsageSummary } from "./memory-summary.service.js";
import { approximateTokens } from "../utils/token-counter.js";
import { logger } from "../utils/logger.js";
import { isMinorNow } from "../utils/age.js";
import type { IPersonaConfig, IPersonalitySliders } from "../types/character.types.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";
import type { ModerationResult } from "./safety.service.js";
import type { UserGender, CommunicationStyle } from "../types/user.types.js";

export interface ConversationParams {
  sessionId: string;
  characterId: string;
  userId: string;
  message: string;
  /**
   * Set by the voice pipeline (voice-llm.service.ts). Switches the prompt's
   * response-length guidance to speakable replies — no markdown, no lists,
   * 1-3 sentences. buildPersonalizationBlock already handled this flag; before
   * Phase 1 nothing ever set it because voice never used this pipeline.
   */
  isVoiceMode?: boolean;
}

export type ConversationEvent =
  | { type: "chunk"; content: string }
  | { type: "crisis"; content: string }
  | { type: "done"; turn_id: string; tokens_used: { input: number; output: number } }
  | { type: "error"; message: string };

// ─── helpers ────────────────────────────────────────────────────────────────

// Cache includes everything the prompt needs about the character so we never
// need to hit MongoDB per-turn. Adding a field here means bumping the cache key
// version in session-context.service.ts, or existing cached entries read back
// without it.
interface CachedCharacterConfig {
  persona_config: IPersonaConfig;
  personality_sliders: IPersonalitySliders;
  name: string;
  mode: string;
  created_at: string;
}

async function getCharacterConfig(characterId: string): Promise<CachedCharacterConfig> {
  const cached = await getCachedCharacterConfig(characterId);
  if (cached) return cached as CachedCharacterConfig;

  const character = await Character.findById(characterId)
    .select("persona_config personality_sliders name mode created_at")
    .lean();
  if (!character) throw new Error(`Character not found: ${characterId}`);

  const config: CachedCharacterConfig = {
    persona_config: character.persona_config,
    personality_sliders: character.personality_sliders,
    name: character.name,
    mode: character.mode,
    // Serialized because this round-trips through JSON in Redis; a Date would
    // come back as a string anyway and the type would be lying.
    created_at: new Date(character.created_at).toISOString(),
  };
  await cacheCharacterConfig(characterId, config);
  return config;
}

// Profile fields are optional because sign-in creates the user document before
// onboarding fills it in. date_of_birth replaces the old is_minor flag: that
// was written once at onboarding and never recomputed, so a seventeen-year-old
// stayed restricted forever and nobody ever aged out.
type PersonalizationUser = {
  display_name?: string;
  gender?: string;
  communication_style?: string;
  date_of_birth?: Date;
};

// The only I/O behind personalization. Split out from buildPersonalization() so
// it can run inside the phase-1 Promise.all instead of adding another serial
// round-trip in front of the LLM call — it depends on nothing else.
// Returns null if the user doesn't exist (shouldn't happen in prod, fail open).
async function fetchPersonalizationUser(userId: string): Promise<PersonalizationUser | null> {
  try {
    const user = await User.findById(userId)
      .select("display_name gender communication_style date_of_birth")
      .lean();
    return (user as PersonalizationUser | null) ?? null;
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch user for personalization — proceeding without it");
    return null;
  }
}

// Pure assembly — the sliders and voice flag are pass-through, so this needs no
// awaiting once the user document is in hand.
function buildPersonalization(
  user: PersonalizationUser | null,
  personalitySliders: IPersonalitySliders,
  isVoiceMode = false,
): UserPersonalizationContext | null {
  if (!user) return null;

  return {
    // Reaching here without a name means a client started a conversation
    // mid-onboarding. Fall back rather than failing the turn — none of these
    // change what is safe to say.
    name: user.display_name ?? "there",
    gender: (user.gender ?? "undisclosed") as UserGender,
    communicationStyle: (user.communication_style ?? "warm") as CommunicationStyle,
    personalitySliders,
    // Derived on every turn, never read from a stored snapshot.
    isMinor: isMinorNow(user.date_of_birth),
    isVoiceMode,
  };
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
  const { sessionId, characterId, userId, message, isVoiceMode = false } = params;

  const EMPTY_CTX: IRedisSessionContext = {
    compressed_summary: "",
    turns: [],
    total_token_count: 0,
  };

  // Phase 1: all I/O in parallel — character config, session context, safety,
  // memory, summary, and the personalization user lookup
  const [charConfig, rawSessionCtx, modResult, memoryBlock, latestSummary, personalizationUser] =
    await Promise.all([
      getCharacterConfig(characterId),
      getSessionContext(sessionId).then((ctx) => ctx ?? EMPTY_CTX),
      checkModeration(message),
      retrieveMemories(characterId, userId, message).catch((err) => {
        logger.error({ err, characterId }, "Memory retrieval failed — proceeding without memories");
        return "";
      }),
      getLatestUsageSummary(characterId).catch((err) => {
        logger.error({ err, characterId }, "Usage summary fetch failed — proceeding without it");
        return null;
      }),
      fetchPersonalizationUser(userId),
    ]);

  // 2. Crisis path — inject safety response, skip LLM
  if (modResult.is_crisis) {
    const crisis = getCrisisResponse();
    yield { type: "crisis", content: crisis };

    // Awaited for the same reason as the normal path below — but it matters
    // more here: a crisis exchange is a safety record, and the client may end
    // the session immediately afterwards.
    const assistantTurnId = new Types.ObjectId();
    await Promise.all([
      persistTurns(
        sessionId, characterId, userId, message, crisis,
        { input: 0, output: 0 }, modResult, 0, assistantTurnId,
      ).catch((err) => logger.error({ err }, "Failed to persist crisis turns")),

      (async () => {
        await appendTurn(sessionId, "user", message);
        await appendTurn(sessionId, "assistant", crisis);
      })().catch((err) => logger.error({ err }, "Failed to update Redis after crisis")),
    ]);

    return;
  }

  if (modResult.flagged) {
    logger.warn({ sessionId, userId }, "User message flagged (not crisis) — proceeding");
  }

  // 3. Context compression: if session context is over 3,500 tokens, compress oldest 10 turns
  const sessionCtx = await compressIfNeeded(sessionId, rawSessionCtx);

  // 4. Assemble prompt: system persona + personalization + memory + usage summary + context + message
  const usageSummaryText = latestSummary ? formatUsageSummary(latestSummary) : null;

  // User personalization (name, pronouns, communication style, sliders). The
  // document was already fetched in phase 1; this is pure assembly.
  const personalization = buildPersonalization(
    personalizationUser,
    charConfig.personality_sliders,
    isVoiceMode,
  );

  const { messages, total_tokens } = assemblePrompt(
    charConfig.persona_config,
    {
      name: charConfig.name,
      mode: charConfig.mode,
      knownSince: new Date(charConfig.created_at),
    },
    sessionCtx,
    message,
    memoryBlock || null,
    usageSummaryText,
    personalization,
  );

  // 5. Stream from LLM (temperature 0.8 for consistent persona)
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
      temperature: 0.8,
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

  // 7. Persist turns to MongoDB, and 8. update the Redis session context.
  //
  // These are AWAITED before `done` is emitted, deliberately. Both used to be
  // fire-and-forget, which raced two things that follow immediately after:
  //   - POST /sessions/:id/end enqueues memory extraction, and the extraction
  //     job reads ConversationTurns. The client ends the session as soon as the
  //     chat screen unmounts, so an unpersisted final exchange was silently
  //     missing from memory extraction.
  //   - the next turn reads the Redis context; if appendTurn hadn't landed, the
  //     companion lost the immediately-preceding exchange.
  // The user has already received every content chunk by this point, so `done`
  // is only a terminator — paying a few ms here buys the guarantee that when a
  // client sees `done`, the turn is durable and in context.
  await Promise.all([
    persistTurns(
      sessionId, characterId, userId, message, fullContent,
      tokensUsed, modResult, latency_ms, assistantTurnId,
    ).catch((err) => logger.error({ err }, "Failed to persist conversation turns")),

    (async () => {
      await appendTurn(sessionId, "user", message);
      await appendTurn(sessionId, "assistant", fullContent);
    })().catch((err) => logger.error({ err }, "Failed to update Redis session context")),
  ]);

  // Cosmetic only — safe to let these settle after the stream closes.
  // FIX 11 + 13: update Character.last_interaction_at and User.last_active_at
  void Promise.all([
    Character.updateOne({ _id: characterId }, { last_interaction_at: new Date() }),
    User.updateOne({ _id: userId }, { last_active_at: new Date() }),
  ]).catch((err) => logger.error({ err }, "Failed to update interaction timestamps"));

  yield {
    type: "done",
    turn_id: assistantTurnId.toString(),
    tokens_used: tokensUsed,
  };
}
