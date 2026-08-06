import { Types } from "mongoose";
import { voice } from "@livekit/agents";
import type { JobContext } from "@livekit/agents";
import { RoomEvent } from "@livekit/rtc-node";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { DEFAULT_VOICE_ID } from "../data/voices.js";
import { HumeTTS } from "./hume-tts-plugin.js";
import { CompanionLLM } from "./voice-llm.service.js";
import { endSessionById } from "./session.service.js";

const FALLBACK_PROMPT =
  "You are a warm, supportive AI companion. Speak naturally and conversationally, " +
  "keep replies fairly short since this is a spoken call, and respond with genuine care.";

// What the room resolved to. When `ids` is present the call runs through the
// real conversation pipeline (memory, safety, persistence). When it is null the
// session/character could not be resolved and we degrade to a generic companion
// so the caller still hears something rather than an error loop.
interface ResolvedVoiceConfig {
  ids: { sessionId: string; characterId: string; userId: string } | null;
  greeting: string;
  voiceId: string;
}

// The LiveKit room name is the Mongo session _id (see voice.routes.ts), so we
// walk session -> character to recover the ids the conversation pipeline needs.
// The persona is deliberately NOT read here any more: it now comes from
// assemblePrompt() inside streamConversation(), together with the archetype's
// behavioral rules, boundaries and safety overrides. Building a second copy
// here would double the system prompt.
async function resolveVoiceConfig(roomName: string): Promise<ResolvedVoiceConfig> {
  try {
    if (Types.ObjectId.isValid(roomName)) {
      const session = await Session.findById(roomName)
        .select("character_id user_id")
        .lean();

      if (session?.character_id && session.user_id) {
        const character = await Character.findById(session.character_id)
          .select("name voice_id")
          .lean();

        if (character) {
          return {
            ids: {
              sessionId: roomName,
              characterId: session.character_id.toString(),
              userId: session.user_id,
            },
            greeting: `Greet the user warmly as ${character.name} and ask how they're doing.`,
            voiceId: character.voice_id ?? DEFAULT_VOICE_ID,
          };
        }
      }
    }
    logger.error(
      { roomName },
      "voice: could not resolve session/character for room — degrading to generic companion (no memory, no safety pipeline)",
    );
  } catch (err) {
    logger.error({ err, roomName }, "voice: session lookup failed — degrading to generic companion");
  }

  return {
    ids: null,
    greeting: "Greet the user warmly and ask how they're doing.",
    voiceId: DEFAULT_VOICE_ID,
  };
}

/**
 * Runs one voice call: subscribes to the caller's mic, transcribes with Deepgram,
 * generates replies through the SAME pipeline as text chat (safety, memory,
 * usage summary, persona, turn persistence), and speaks back with Hume Octave 2
 * TTS using the user's selected voice.
 *
 * Called by the LiveKit agent worker (voice.worker.ts) once per room the agent
 * is dispatched to.
 */
export async function runVoicePipeline(ctx: JobContext): Promise<void> {
  await ctx.connect();

  const roomName = ctx.room.name ?? "";
  const { ids, greeting, voiceId } = await resolveVoiceConfig(roomName);

  logger.info(
    { roomName, voiceId, pipeline: ids ? "companion" : "degraded-generic" },
    "voice: starting agent session",
  );

  const humeTts = env.HUME_API_KEY
    ? new HumeTTS(voiceId)
    : new openai.TTS({ model: "tts-1", voice: "shimmer", apiKey: env.OPENAI_API_KEY });

  // The real path: every turn goes through streamConversation(), so voice gets
  // moderation/crisis detection, minor restrictions, memory retrieval, the
  // usage summary, Redis session context and ConversationTurn persistence.
  // Persisted turns are also what make memory extraction work for voice calls.
  const companionLlm = ids
    ? new CompanionLLM(ids)
    : new openai.LLM({ model: "gpt-4o-mini", apiKey: env.OPENAI_API_KEY });

  const session = new voice.AgentSession({
    stt: new deepgram.STT({ model: "nova-3", apiKey: env.DEEPGRAM_API_KEY }),
    llm: companionLlm,
    tts: humeTts,
    vad: await silero.VAD.load(),
  });

  // CompanionLLM ignores these instructions (the persona is assembled inside
  // the pipeline from persona_config). They only matter on the degraded path.
  const agent = new voice.Agent({ instructions: ids ? "" : FALLBACK_PROMPT });

  await session.start({ agent, room: ctx.room });

  // End the Mongo session as soon as the caller leaves. Without this a voice
  // session stayed `active` until the 30-minute stale-session sweep closed it,
  // and voice_minutes_consumed was then computed from that inflated duration —
  // a 2-minute call was billed as ~31 minutes. endSessionById is idempotent
  // (it no-ops unless status === "active") so overlapping paths are safe.
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    logger.info({ roomName, identity: participant.identity }, "voice: participant left — ending session");
    void endSessionById(roomName, "completed").catch((err) =>
      logger.error({ err, roomName }, "voice: failed to end session on participant disconnect"),
    );
  });

  ctx.room.on(RoomEvent.Disconnected, () => {
    logger.info({ roomName }, "voice: room disconnected — ending session");
    void endSessionById(roomName, "completed").catch((err) =>
      logger.error({ err, roomName }, "voice: failed to end session on room disconnect"),
    );
  });

  // Open with a spoken greeting so the user hears the companion immediately.
  session.generateReply({ instructions: greeting });

  logger.info(
    { roomName, voiceId, ttsProvider: env.HUME_API_KEY ? "hume" : "openai-fallback" },
    "voice: agent session started",
  );
}
