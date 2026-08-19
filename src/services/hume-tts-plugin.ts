import { tts } from "@livekit/agents";
import type { APIConnectOptions } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import {
  HumeTTSSession,
  TTS_OUTPUT_SAMPLE_RATE,
  TTS_OUTPUT_CHANNELS,
} from "./voice-tts.service.js";
import type { TTSAudioChunk } from "./voice-tts.service.js";
import { logger } from "../utils/logger.js";

// ── HumeTTS plugin ────────────────────────────────────────────────────────────
// Implements the LiveKit Agents TTS plugin interface backed by Hume Octave 2.
//
// The Hume socket is owned HERE, not by the individual streams. One HumeTTS is
// constructed per voice call (voice.service.ts), so this gives exactly one
// WebSocket for the whole call — which is what voice-tts.service.ts always
// claimed to do but did not: the session used to be created in the
// SynthesizeStream constructor and closed at the end of run(), so every turn
// paid a fresh handshake to api.hume.ai. A recorded session showed 28 opens.

export class HumeTTS extends tts.TTS {
  label = "hume.octave-2";

  // Lazily opened on the first stream, then shared by every turn of the call.
  private sharedSession: HumeTTSSession | null = null;

  constructor(private readonly voiceId: string) {
    super(TTS_OUTPUT_SAMPLE_RATE, TTS_OUTPUT_CHANNELS, { streaming: true });
  }

  override get model(): string { return "octave-2"; }
  override get provider(): string { return "hume"; }

  /**
   * The call-scoped Hume connection. Streams borrow it and rebind its
   * callbacks; none of them may close it — only closeSession() does, at the
   * end of the call.
   */
  getSession(): HumeTTSSession {
    if (!this.sharedSession) {
      this.sharedSession = new HumeTTSSession(this.voiceId, {
        onAudioChunk: () => {},
        onError: () => {},
        onClose: () => {},
      });
    }
    return this.sharedSession;
  }

  /** Permanently close the shared socket. Call once, when the call ends. */
  closeSession(): void {
    this.sharedSession?.close();
    this.sharedSession = null;
  }

  synthesize(text: string, connOptions?: APIConnectOptions): HumeChunkedStream {
    return new HumeChunkedStream(text, this, this.getSession(), connOptions);
  }

  stream(options?: { connOptions?: APIConnectOptions }): HumeSynthesizeStream {
    return new HumeSynthesizeStream(this, this.getSession(), options?.connOptions);
  }
}

// ── Shared audio helpers ──────────────────────────────────────────────────────

// Build a LiveKit AudioFrame from Hume's PCM Int16Array chunk.
function makeAudioFrame(pcm: Int16Array): AudioFrame {
  return new AudioFrame(pcm, TTS_OUTPUT_SAMPLE_RATE, TTS_OUTPUT_CHANNELS, pcm.length);
}

/** Returned by next() when the wait window elapsed with no new chunk. */
const IDLE = Symbol("idle");

// Simple async queue that bridges Hume callback events to async iteration.
class AudioChunkQueue {
  private _items: Array<TTSAudioChunk | Error | null> = [];
  private _resolve: (() => void) | null = null;

  put(item: TTSAudioChunk | Error | null): void {
    this._items.push(item);
    this._resolve?.();
    this._resolve = null;
  }

  /** Drop anything left over from a previous turn. */
  clear(): void {
    this._items = [];
  }

  /**
   * Wait for the next item. With timeoutMs, resolves to IDLE if nothing
   * arrives in that window — Hume never signals "this flush is finished", so a
   * quiet socket is the only available end-of-segment marker.
   */
  async next(timeoutMs?: number): Promise<TTSAudioChunk | Error | null | typeof IDLE> {
    if (this._items.length > 0) return this._items.shift()!;

    if (timeoutMs === undefined) {
      while (this._items.length === 0) {
        await new Promise<void>((resolve) => { this._resolve = resolve; });
      }
      return this._items.shift()!;
    }

    let timer: NodeJS.Timeout | undefined;
    const gotItem = await new Promise<boolean>((resolve) => {
      this._resolve = () => resolve(true);
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    if (timer) clearTimeout(timer);
    this._resolve = null;

    if (!gotItem) return IDLE;
    return this._items.shift()!;
  }
}

// ── SynthesizeStream ─────────────────────────────────────────────────────────
// Used by AgentSession in real-time streaming mode: text is pushed chunk-by-chunk
// as the LLM generates it, and flush() is called at sentence boundaries.

/**
 * How long the socket must stay quiet, after a snippet has finished, before the
 * flush is treated as complete.
 *
 * Hume's `isLastChunk` marks the end of ONE decoded snippet, not the end of the
 * flush — the SDK defines it as "the last chunk streamed back from the decoder
 * for one input snippet". A multi-sentence reply produces several snippets, so
 * breaking on the first `isLastChunk` (the old behaviour) cut the segment short
 * and orphaned the remaining audio in the queue, where it stalled the stream
 * until the framework force-closed it ("TTS stream stalled after producing
 * audio, forcing close" fired 20 times in one recorded session).
 *
 * Generous enough to survive the gap between snippets, far below the
 * framework's own multi-second stall timeout. This does not delay playback —
 * frames are emitted as they arrive; it only defers the final marker.
 */
const SEGMENT_IDLE_MS = 600;

class HumeSynthesizeStream extends tts.SynthesizeStream {
  label = "hume.octave-2.stream";

  private readonly audioQueue = new AudioChunkQueue();
  private segmentCounter = 0;
  private requestCounter = 0;

  constructor(
    ttsInstance: tts.TTS,
    private readonly humeSession: HumeTTSSession,
    connOptions?: APIConnectOptions,
  ) {
    super(ttsInstance, connOptions);

    // The socket is call-scoped and shared, so claim delivery for this stream.
    this.humeSession.setCallbacks({
      onAudioChunk: (chunk) => this.audioQueue.put(chunk),
      onError: (err) => {
        logger.error({ err }, "hume-tts-plugin: audio error");
        this.audioQueue.put(err);
      },
      onClose: () => {
        // Socket dropped mid-segment; wake the drain loop so it doesn't hang.
        // ensureConnected() reopens on the next turn.
        this.audioQueue.put(null);
      },
    });
  }

  protected async run(): Promise<void> {
    try {
      await this.humeSession.ensureConnected();
    } catch (err) {
      logger.error({ err }, "hume-tts-plugin: connect failed");
      this.queue.close();
      return;
    }

    let pendingText = "";

    for await (const item of this.input) {
      if (this.abortSignal.aborted) break;

      if (typeof item === "string") {
        pendingText += item;
        this.humeSession.sendText(item);
        continue;
      }

      // FLUSH_SENTINEL — Hume should generate audio for what was buffered
      if (!pendingText.trim()) continue;

      this.audioQueue.clear();
      this.humeSession.beginTurn();
      this.humeSession.flush();

      const segmentId = String(++this.segmentCounter);
      const requestId = String(this.requestCounter++);
      let isFirstChunk = true;

      // `final` must mark the last frame of the whole segment, so hold one
      // chunk back: emit it only once the following chunk arrives (not final)
      // or the segment ends (final).
      let held: TTSAudioChunk | null = null;
      let snippetEnded = false;

      const emit = (chunk: TTSAudioChunk, final: boolean): void => {
        this.queue.put({
          requestId,
          segmentId,
          frame: makeAudioFrame(chunk.pcm),
          deltaText: isFirstChunk ? pendingText : undefined,
          final,
        });
        isFirstChunk = false;
      };

      while (true) {
        if (this.abortSignal.aborted) {
          this.humeSession.cancelTurn();
          break;
        }

        // Only bound the wait once a snippet has completed — before that,
        // we are still waiting on Hume's first audio and must not give up.
        const next = await this.audioQueue.next(snippetEnded ? SEGMENT_IDLE_MS : undefined);

        // IDLE = flush finished, null = socket closed, Error = TTS failure
        if (next === IDLE || next === null || next instanceof Error) {
          if (held) emit(held, true);
          held = null;
          break;
        }

        if (held) emit(held, false);
        held = next;
        if (next.isLastChunk) snippetEnded = true;
      }

      pendingText = "";
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    // Deliberately NOT closing humeSession — it is owned by HumeTTS and shared
    // by every turn of the call. HumeTTS.closeSession() ends it.
  }
}

// ── ChunkedStream ─────────────────────────────────────────────────────────────
// Used by synthesize(text) — full text known upfront (e.g., initial greeting).

class HumeChunkedStream extends tts.ChunkedStream {
  label = "hume.octave-2.chunked";

  constructor(
    text: string,
    ttsInstance: tts.TTS,
    private readonly session: HumeTTSSession,
    connOptions?: APIConnectOptions,
  ) {
    super(text, ttsInstance, connOptions);
  }

  protected async run(): Promise<void> {
    const audioQueue = new AudioChunkQueue();

    // Shares the call's socket rather than opening a second one for the
    // greeting, so the first turn does not pay a handshake it can avoid.
    this.session.setCallbacks({
      onAudioChunk: (chunk) => audioQueue.put(chunk),
      onError: (err) => {
        logger.error({ err }, "hume-tts-plugin: chunked audio error");
        audioQueue.put(err);
      },
      onClose: () => audioQueue.put(null),
    });

    try {
      await this.session.ensureConnected();
    } catch (err) {
      logger.error({ err }, "hume-tts-plugin: chunked connect failed");
      return;
    }

    this.session.beginTurn();
    this.session.sendText(this.inputText);
    this.session.flush();

    let isFirstChunk = true;
    // Same one-chunk lookahead as the streaming path: isLastChunk ends a
    // snippet, not the flush, so `final` can only be set once the segment is
    // known to be over.
    let held: TTSAudioChunk | null = null;
    let snippetEnded = false;

    const emit = (chunk: TTSAudioChunk, final: boolean): void => {
      this.queue.put({
        requestId: "0",
        segmentId: "0",
        frame: makeAudioFrame(chunk.pcm),
        deltaText: isFirstChunk ? this.inputText : undefined,
        final,
      });
      isFirstChunk = false;
    };

    while (!this.abortSignal.aborted) {
      const next = await audioQueue.next(snippetEnded ? SEGMENT_IDLE_MS : undefined);

      if (next === IDLE || next === null || next instanceof Error) {
        if (held) emit(held, true);
        held = null;
        break;
      }

      if (held) emit(held, false);
      held = next;
      if (next.isLastChunk) snippetEnded = true;
    }

    // Socket is call-scoped; HumeTTS.closeSession() owns its lifetime.
  }
}
