import { Types } from "mongoose";
import { voice } from "@livekit/agents";
import type { JobContext } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const FALLBACK_PROMPT =
  "You are a warm, supportive AI companion. Speak naturally and conversationally, " +
  "keep replies fairly short since this is a spoken call, and respond with genuine care.";

// Resolve the persona system prompt for the room. The LiveKit room name is the
// Mongo session _id (see voice.routes.ts), so we walk session -> character and
// read persona_config.system_prompt. Falls back to a generic companion prompt
// if anything is missing, so a call never dies just because of a lookup gap.
async function resolveInstructions(
  roomName: string,
): Promise<{ instructions: string; greeting: string }> {
  try {
    if (Types.ObjectId.isValid(roomName)) {
      const session = await Session.findById(roomName).select("character_id").lean();
      if (session?.character_id) {
        const character = await Character.findById(session.character_id)
          .select("name persona_config")
          .lean();
        const sys = (character?.persona_config as { system_prompt?: string } | undefined)
          ?.system_prompt;
        if (sys) {
          const name = character?.name ?? "your companion";
          return {
            instructions:
              sys +
              "\n\nYou are on a live VOICE call. Keep responses concise and natural for " +
              "speech (usually 1-3 sentences). Avoid markdown, lists, or emoji - just talk.",
            greeting: `Greet the user warmly as ${name} and ask how they're doing.`,
          };
        }
      }
    }
  } catch (err) {
    logger.error({ err, roomName }, "voice: persona lookup failed, using fallback");
  }
  return {
    instructions: FALLBACK_PROMPT,
    greeting: "Greet the user warmly and ask how they're doing.",
  };
}

/**
 * Runs one voice call: subscribes to the caller's mic, transcribes with Deepgram,
 * generates replies with OpenAI using the character's persona, and speaks back
 * with OpenAI TTS. Voice activity detection (Silero) handles turn-taking.
 *
 * Called by the LiveKit agent worker (voice.worker.ts) once per room the agent
 * is dispatched to.
 */
export async function runVoicePipeline(ctx: JobContext): Promise<void> {
  await ctx.connect();

  const roomName = ctx.room.name ?? "";
  const { instructions, greeting } = await resolveInstructions(roomName);

  logger.info({ roomName }, "voice: starting agent session");

  const session = new voice.AgentSession({
    stt: new deepgram.STT({ model: "nova-2", apiKey: env.DEEPGRAM_API_KEY }),
    llm: new openai.LLM({ model: "gpt-4o-mini", apiKey: env.OPENAI_API_KEY }),
    tts: new openai.TTS({ model: "tts-1", voice: "shimmer", apiKey: env.OPENAI_API_KEY }),
    vad: await silero.VAD.load(),
  });

  const agent = new voice.Agent({ instructions });

  await session.start({ agent, room: ctx.room });

  // Open with a spoken greeting so the user hears the companion immediately.
  session.generateReply({ instructions: greeting });

  logger.info({ roomName }, "voice: agent session started");
}
