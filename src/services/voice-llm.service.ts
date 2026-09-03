import { randomUUID } from "node:crypto";
import { llm } from "@livekit/agents";
import { DEFAULT_API_CONNECT_OPTIONS } from "@livekit/agents";
import type { APIConnectOptions } from "@livekit/agents";
import { streamConversation } from "./conversation.service.js";
import type { VoiceTurnTimer } from "./voice-metrics.service.js";
import { getConversationModel } from "../config/openai.js";
import { logger } from "../utils/logger.js";

// ── CompanionLLM ──────────────────────────────────────────────────────────────
// A LiveKit Agents LLM plugin that delegates to streamConversation() — the same
// generator the text-chat SSE route uses.
//
// Before this existed, voice.service.ts handed AgentSession a plain
// `openai.LLM` with only the persona string. That bypassed the entire product
// pipeline, so a voice call had:
//   - no input moderation, therefore no crisis/self-harm detection
//   - no under-18 content restrictions
//   - no long-term memory retrieval and no usage summary
//   - no Redis session context (it re-derived history from its own chatCtx)
//   - no ConversationTurn persistence — which also meant memory extraction
//     found zero turns at session end, so voice calls never produced memories
//
// Routing through streamConversation() restores all of the above at once, and
// keeps text and voice on ONE code path so future fixes apply to both.

export interface CompanionLLMOptions {
  sessionId: string;
  characterId: string;
  userId: string;
}

// Spoken to the user if the pipeline fails outright. Kept short — it is going
// through TTS, not onto a screen.
const SPOKEN_FALLBACK =
  "Sorry, I lost my train of thought there. Could you say that again?";

export class CompanionLLM extends llm.LLM {
  constructor(
    private readonly ids: CompanionLLMOptions,
    // Optional so the degraded path and tests can construct one without metrics.
    private readonly timer?: VoiceTurnTimer,
  ) {
    super();
  }

  label(): string {
    return "whisper.companion-pipeline";
  }

  override get model(): string {
    // Report the model that actually answers, so LiveKit's metrics and the
    // persisted turns agree with reality when a local endpoint is in use.
    return getConversationModel();
  }

  override get provider(): string {
    return "whisper";
  }

  chat({
    chatCtx,
    connOptions,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new CompanionLLMStream(this, this.ids, {
      chatCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    }, this.timer);
  }
}

/**
 * Pulls the text of the most recent user message out of the chat context.
 *
 * We deliberately use ONLY the latest user turn and ignore the rest of
 * AgentSession's chatCtx: conversation history is owned by the Redis session
 * context inside streamConversation(). Feeding both would duplicate history in
 * the prompt and double the token bill.
 */
function latestUserMessage(chatCtx: llm.ChatContext): string | null {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i];
    if (item?.type !== "message" || item.role !== "user") continue;
    const text = item.textContent?.trim();
    if (text) return text;
  }
  return null;
}

class CompanionLLMStream extends llm.LLMStream {
  constructor(
    companionLlm: CompanionLLM,
    private readonly ids: CompanionLLMOptions,
    opts: { chatCtx: llm.ChatContext; connOptions: APIConnectOptions },
    private readonly timer?: VoiceTurnTimer,
  ) {
    super(companionLlm, opts);
  }

  /**
   * Note on error handling: this must never throw. The base LLMStream retries
   * run() on APIError, and a retry here would re-run the whole pipeline —
   * re-moderating, re-retrieving memories and re-persisting turns for a single
   * utterance. So every failure is converted into spoken content instead.
   *
   * Note on lifecycle: the base class closes `this.queue` once run() settles
   * (`mainTask().finally(() => this.queue.close())`), so we must not close it.
   */
  protected async run(): Promise<void> {
    const message = latestUserMessage(this.chatCtx);
    if (!message) {
      logger.debug({ sessionId: this.ids.sessionId }, "voice: no user text in chatCtx — skipping turn");
      return;
    }

    const id = randomUUID();
    let emitted = false;

    try {
      for await (const event of streamConversation({
        sessionId: this.ids.sessionId,
        characterId: this.ids.characterId,
        userId: this.ids.userId,
        message,
        isVoiceMode: true,
      })) {
        switch (event.type) {
          // The crisis path bypasses the LLM and returns hotline wording. On a
          // voice call it must be spoken like any other reply, so it is emitted
          // through the same channel as a normal chunk.
          case "chunk":
          case "crisis":
            // V-03: the first content to leave the pipeline, whatever its
            // source. Stamped here rather than inside streamConversation so it
            // measures what actually reached the TTS stage.
            if (!emitted) this.timer?.markLlmFirstToken();
            emitted = true;
            this.queue.put({ id, delta: { role: "assistant", content: event.content } });
            break;

          case "error":
            logger.error(
              { sessionId: this.ids.sessionId, message: event.message },
              "voice: conversation pipeline reported an error",
            );
            if (!emitted) {
              emitted = true;
              this.queue.put({ id, delta: { role: "assistant", content: SPOKEN_FALLBACK } });
            }
            break;

          // Surface token usage so LiveKit's metrics collector sees real numbers.
          case "done":
            this.queue.put({
              id,
              usage: {
                promptTokens: event.tokens_used.input,
                completionTokens: event.tokens_used.output,
                promptCachedTokens: 0,
                totalTokens: event.tokens_used.input + event.tokens_used.output,
              },
            });
            break;
        }
      }
    } catch (err) {
      // Defensive: streamConversation yields an "error" event rather than
      // throwing, but a bug upstream must not silence the companion or trigger
      // a pipeline-rerunning retry.
      logger.error({ err, sessionId: this.ids.sessionId }, "voice: pipeline threw unexpectedly");
      if (!emitted) {
        this.queue.put({ id, delta: { role: "assistant", content: SPOKEN_FALLBACK } });
      }
    }
  }
}
