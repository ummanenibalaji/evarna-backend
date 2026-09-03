import { Types } from "mongoose";
import { getOpenAI, getConversationClient, getConversationModel, MODELS } from "../config/openai.js";
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
import { phraseFor } from "./adaptation.service.js";
import type { UserPersonalizationContext } from "./prompt.service.js";
import { compressIfNeeded, compressInBackground } from "./context-compression.service.js";
import { retrieveMemories } from "./memory-retrieval.service.js";
import { takeMemoryPrefetch } from "./memory-prefetch.service.js";
import { getLatestUsageSummary, formatUsageSummary } from "./memory-summary.service.js";
import { approximateTokens } from "../utils/token-counter.js";
import { logger } from "../utils/logger.js";
import { isMinorNow } from "../utils/age.js";
import { getScenario } from "../data/scenarios.js";
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
  studio?: { kind: "scenario" | "custom"; scenarioName?: string };
  // Serialized like created_at — this round-trips through JSON in Redis.
  recent_change?: { phrase: string; at: string };
}

async function getCharacterConfig(characterId: string): Promise<CachedCharacterConfig> {
  const cached = await getCachedCharacterConfig(characterId);
  if (cached) return cached as CachedCharacterConfig;

  const character = await Character.findById(characterId)
    .select("persona_config personality_sliders name mode created_at studio_config adaptation.recent_change")
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
    // Rendered to a phrase here rather than in the prompt builder so the words
    // the companion is told match the words on the button the user tapped.
    ...(character.adaptation?.recent_change
      ? {
          recent_change: {
            phrase: phraseFor(
              character.adaptation.recent_change.trait,
              character.adaptation.recent_change.direction,
            ),
            at: new Date(character.adaptation.recent_change.at).toISOString(),
          },
        }
      : {}),
    ...(character.studio_config
      ? {
          studio: {
            kind: character.studio_config.kind,
            ...(character.studio_config.scenario_id
              ? { scenarioName: getScenario(character.studio_config.scenario_id)?.name }
              : {}),
          },
        }
      : {}),
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
        is_crisis: userModeration.is_crisis,
      },
      tokens_used: { input: tokensUsed.input, output: 0 },
      model_used: getConversationModel(),
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
      model_used: getConversationModel(),
      latency_ms,
      created_at: new Date(now.getTime() + 1),
    },
  ]);
}

// ── Voice first-token latency (V-05) ─────────────────────────────────────────
//
// Phase 1 below runs six lookups concurrently, so its cost is the SLOWEST of
// them, not their sum. Measured, that is almost always memory retrieval: an
// embedding call plus an Atlas $vectorSearch. On a voice call every millisecond
// of it is dead air before the model has even been asked to start.
//
// Two changes, both voice-only — the text path keeps its exact original
// ordering and semantics:
//
//   1. Moderation leaves the critical path. Generation starts immediately and
//      the FIRST token is gated on the moderation result instead. The safety
//      guarantee is unchanged: nothing unmoderated is ever yielded, so nothing
//      unmoderated reaches the caller's ear. The wait now hides underneath the
//      model's own thinking time rather than adding to it.
//
//   2. Memory retrieval is bounded by a deadline. The prompt genuinely needs
//      the memory block, so it cannot simply be moved after generation starts.
//      Instead a slow retrieval is abandoned and the turn proceeds without
//      memories rather than making the caller wait through the tail. Every
//      abandonment is logged, so the rate is measurable rather than assumed.
//      Set VOICE_MEMORY_DEADLINE_MS=0 to disable the bound entirely.
const VOICE_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env["VOICE_MAX_COMPLETION_TOKENS"];
  if (raw === undefined) return 150;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 150;
})();

// On the default: measured retrieval is ~330ms warm and ~400ms cold against
// this Atlas cluster, so this is set as a TAIL GUARD rather than a routine
// shortcut. A tighter value (300-400ms) buys latency by dropping memories on a
// meaningful share of turns, which is a real quality regression — the companion
// forgets things — so that is a trade to make with numbers in hand, not a
// default to ship blind. Lower it during a latency run and watch the rate of
// the "exceeded its deadline" warning below.
const VOICE_MEMORY_DEADLINE_MS = (() => {
  const raw = process.env["VOICE_MEMORY_DEADLINE_MS"];
  if (raw === undefined) return 600;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 600;
})();

/**
 * Resolve to `fallback` if `promise` has not settled within `ms`.
 *
 * The underlying promise is left running rather than cancelled — it already
 * carries its own .catch(), so an late rejection cannot surface as an unhandled
 * rejection, and letting it finish keeps any cache it populates warm.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T, onTimeout: () => void): Promise<T> {
  if (ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  const winner = await Promise.race([promise, timeout]);
  if (timer) clearTimeout(timer);
  if (winner === TIMED_OUT) {
    onTimeout();
    return fallback;
  }
  return winner as T;
}
const TIMED_OUT = Symbol("timed-out");

/**
 * Write a crisis exchange to Mongo and Redis.
 *
 * Awaited by both callers for the same reason: a crisis exchange is a safety
 * record, and the client may end the session immediately afterwards.
 */
async function persistCrisisExchange(
  sessionId: string,
  characterId: string,
  userId: string,
  message: string,
  crisis: string,
  modResult: ModerationResult,
): Promise<void> {
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
  // memory, summary, and the personalization user lookup.
  //
  // Started together; what we WAIT for differs by mode. See the V-05 note above
  // the generator: on voice, moderation is not awaited here and memory is
  // bounded, so the model is asked to start sooner.
  const phase1Start = Date.now();

  const moderationPromise = checkModeration(message);
  // Attached immediately so a rejection can never surface as an unhandled
  // rejection while the promise sits un-awaited on the voice path.
  const safeModerationPromise = moderationPromise.catch((err) => {
    logger.error({ err, sessionId }, "Moderation failed — treating as unflagged");
    return { flagged: false, is_crisis: false, categories: {} } as ModerationResult;
  });

  let memoryTimedOut = false;
  // On voice, retrieval was very likely started while the caller was still
  // speaking (see memory-prefetch.service.ts). Claiming that head start is the
  // difference between waiting ~400ms here and waiting almost nothing.
  const prefetched = isVoiceMode ? takeMemoryPrefetch(sessionId) : null;
  const memoryPromise =
    prefetched ??
    retrieveMemories(characterId, userId, message).catch((err) => {
      logger.error({ err, characterId }, "Memory retrieval failed — proceeding without memories");
      return "";
    });

  const [charConfig, rawSessionCtx, memoryBlock, latestSummary, personalizationUser] =
    await Promise.all([
      getCharacterConfig(characterId),
      getSessionContext(sessionId).then((ctx) => ctx ?? EMPTY_CTX),
      isVoiceMode
        ? withDeadline(memoryPromise, VOICE_MEMORY_DEADLINE_MS, "", () => {
            memoryTimedOut = true;
          })
        : memoryPromise,
      getLatestUsageSummary(characterId).catch((err) => {
        logger.error({ err, characterId }, "Usage summary fetch failed — proceeding without it");
        return null;
      }),
      fetchPersonalizationUser(userId),
    ]);

  // Text keeps its original contract exactly: moderation is settled before any
  // generation starts. Voice resolves it later, at the first token.
  let modResult: ModerationResult | null = isVoiceMode ? null : await safeModerationPromise;

  if (isVoiceMode) {
    logger.debug(
      {
        sessionId,
        prep_ms: Date.now() - phase1Start,
        memory_timed_out: memoryTimedOut,
        memory_prefetched: prefetched !== null,
      },
      "voice: pipeline prep complete",
    );
    if (memoryTimedOut) {
      logger.warn(
        { sessionId, deadline_ms: VOICE_MEMORY_DEADLINE_MS },
        "voice: memory retrieval exceeded its deadline — answering without memories",
      );
    }
  }

  // 2. Crisis path — inject safety response, skip LLM.
  // Voice reaches this check further down, once the first token is ready.
  if (modResult?.is_crisis) {
    const crisis = getCrisisResponse();
    yield { type: "crisis", content: crisis };
    await persistCrisisExchange(sessionId, characterId, userId, message, crisis, modResult);
    return;
  }

  if (modResult?.flagged) {
    logger.warn({ sessionId, userId }, "User message flagged (not crisis) — proceeding");
  }

  // 3. Context compression: if session context is over 3,500 tokens, compress oldest 10 turns
  // Voice does not wait for compression — it is a token-cost optimisation that
  // was costing 1.5-3s of silence per turn on any conversation long enough to
  // trigger it. See compressInBackground().
  let sessionCtx: IRedisSessionContext;
  if (isVoiceMode) {
    sessionCtx = rawSessionCtx;
    compressInBackground(sessionId, rawSessionCtx);
  } else {
    sessionCtx = await compressIfNeeded(sessionId, rawSessionCtx);
  }

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
      ...(charConfig.studio ? { studio: charConfig.studio } : {}),
      ...(charConfig.recent_change
        ? {
            recentChange: {
              phrase: charConfig.recent_change.phrase,
              at: new Date(charConfig.recent_change.at),
            },
          }
        : {}),
    },
    sessionCtx,
    message,
    memoryBlock || null,
    usageSummaryText,
    personalization,
  );

  // 5. Stream from LLM (temperature 0.8 for consistent persona)
  // Conversation model only — may be a local endpoint. Embeddings and
  // moderation elsewhere in this file stay on OpenAI.
  const openai = getConversationClient();
  const startTime = Date.now();
  const assistantTurnId = new Types.ObjectId();

  let fullContent = "";
  let outputTokens = 0;

  try {
    const stream = await openai.chat.completions.create({
      model: getConversationModel(),
      messages,
      stream: true,
      temperature: 0.8,
      // V-07: 600 tokens is ~40 seconds of unstoppable speech that we pay Hume
      // for. The prompt asks for one to three sentences but nothing enforced
      // it. On a call the cap IS the enforcement.
      max_completion_tokens: isVoiceMode ? VOICE_MAX_COMPLETION_TOKENS : 600,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        // V-05 safety gate. On voice, moderation ran concurrently with
        // generation; this is the point it must be settled, because it is the
        // last moment before any content becomes audible. Costs nothing when
        // moderation finished first, which is the normal case.
        if (modResult === null) {
          modResult = await safeModerationPromise;
          if (modResult.is_crisis) {
            // Discard whatever the model produced — it was generated without
            // knowing this was a crisis — and speak the crisis response.
            const crisis = getCrisisResponse();
            yield { type: "crisis", content: crisis };
            await persistCrisisExchange(sessionId, characterId, userId, message, crisis, modResult);
            return;
          }
          if (modResult.flagged) {
            logger.warn({ sessionId, userId }, "User message flagged (not crisis) — proceeding");
          }
        }
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

  // An empty completion never reaches the gate above, so settle moderation
  // here — persistTurns records it on the user turn's safety_flags.
  if (modResult === null) modResult = await safeModerationPromise;

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
  const persistStart = Date.now();
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


  // On voice this window is DEAD AIR: the generator closing is what triggers
  // the flush to Hume, so nothing is being synthesised while these writes run.
  if (isVoiceMode) {
    logger.debug(
      { sessionId, persist_ms: Date.now() - persistStart },
      "voice: post-generation persistence (blocks the TTS flush)",
    );
  }

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
