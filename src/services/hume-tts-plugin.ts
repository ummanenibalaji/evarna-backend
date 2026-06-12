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
// Uses a persistent WebSocket per SynthesizeStream (one per voice call turn),
// keeping the same connection alive across multiple flush/send cycles to save
// the 500-1000ms reconnect overhead described in voice-tts.service.ts.

export class HumeTTS extends tts.TTS {
  label = "hume.octave-2";

  constructor(private readonly voiceId: string) {
    super(TTS_OUTPUT_SAMPLE_RATE, TTS_OUTPUT_CHANNELS, { streaming: true });
  }

  override get model(): string { return "octave-2"; }
  override get provider(): string { return "hume"; }

  synthesize(text: string, connOptions?: APIConnectOptions): HumeChunkedStream {
    return new HumeChunkedStream(text, this, this.voiceId, connOptions);
  }

  stream(options?: { connOptions?: APIConnectOptions }): HumeSynthesizeStream {
    return new HumeSynthesizeStream(this, this.voiceId, options?.connOptions);
  }
}

// ── Shared audio helpers ──────────────────────────────────────────────────────

// Build a LiveKit AudioFrame from Hume's PCM Int16Array chunk.
function makeAudioFrame(pcm: Int16Array): AudioFrame {
  return new AudioFrame(pcm, TTS_OUTPUT_SAMPLE_RATE, TTS_OUTPUT_CHANNELS, pcm.length);
}

// Simple async queue that bridges Hume callback events to async iteration.
class AudioChunkQueue {
  private _items: Array<TTSAudioChunk | Error | null> = [];
  private _resolve: (() => void) | null = null;

  put(item: TTSAudioChunk | Error | null): void {
    this._items.push(item);
    this._resolve?.();
    this._resolve = null;
  }

  async next(): Promise<TTSAudioChunk | Error | null> {
    while (this._items.length === 0) {
      await new Promise<void>((resolve) => { this._resolve = resolve; });
    }
    return this._items.shift()!;
  }
}

// ── SynthesizeStream ─────────────────────────────────────────────────────────
// Used by AgentSession in real-time streaming mode: text is pushed chunk-by-chunk
// as the LLM generates it, and flush() is called at sentence boundaries.

class HumeSynthesizeStream extends tts.SynthesizeStream {
  label = "hume.octave-2.stream";

  private readonly humeSession: HumeTTSSession;
  private readonly audioQueue = new AudioChunkQueue();
  private segmentCounter = 0;
  private requestCounter = 0;

  constructor(
    ttsInstance: tts.TTS,
    private readonly voiceId: string,
    connOptions?: APIConnectOptions,
  ) {
    super(ttsInstance, connOptions);

    this.humeSession = new HumeTTSSession(voiceId, {
      onAudioChunk: (chunk) => this.audioQueue.put(chunk),
      onError: (err) => {
        logger.error({ err }, "hume-tts-plugin: audio error");
        this.audioQueue.put(err);
      },
      onClose: () => {
        // Socket closed unexpectedly mid-segment; signal the drain loop so it
        // doesn't hang. The session will auto-reconnect on the next sendText.
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

      this.humeSession.beginTurn();
      this.humeSession.flush();

      const segmentId = String(++this.segmentCounter);
      const requestId = String(this.requestCounter++);
      let isFirstChunk = true;

      // Drain audio until Hume signals the end of this segment
      while (true) {
        if (this.abortSignal.aborted) {
          this.humeSession.cancelTurn();
          break;
        }

        const item = await this.audioQueue.next();

        // null = socket closed unexpectedly, Error = TTS error
        if (item === null || item instanceof Error) break;

        this.queue.put({
          requestId,
          segmentId,
          frame: makeAudioFrame(item.pcm),
          deltaText: isFirstChunk ? pendingText : undefined,
          final: item.isLastChunk,
        });
        isFirstChunk = false;

        if (item.isLastChunk) break;
      }

      pendingText = "";
    }

    this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
    this.humeSession.close();
  }
}

// ── ChunkedStream ─────────────────────────────────────────────────────────────
// Used by synthesize(text) — full text known upfront (e.g., initial greeting).

class HumeChunkedStream extends tts.ChunkedStream {
  label = "hume.octave-2.chunked";

  constructor(
    text: string,
    ttsInstance: tts.TTS,
    private readonly voiceId: string,
    connOptions?: APIConnectOptions,
  ) {
    super(text, ttsInstance, connOptions);
  }

  protected async run(): Promise<void> {
    const audioQueue = new AudioChunkQueue();

    const session = new HumeTTSSession(this.voiceId, {
      onAudioChunk: (chunk) => audioQueue.put(chunk),
      onError: (err) => {
        logger.error({ err }, "hume-tts-plugin: chunked audio error");
        audioQueue.put(err);
      },
      onClose: () => audioQueue.put(null),
    });

    try {
      await session.ensureConnected();
    } catch (err) {
      logger.error({ err }, "hume-tts-plugin: chunked connect failed");
      return;
    }

    session.sendText(this.inputText);
    session.flush();

    let isFirstChunk = true;
    let chunkIndex = 0;

    while (!this.abortSignal.aborted) {
      const item = await audioQueue.next();
      if (item === null || item instanceof Error) break;

      this.queue.put({
        requestId: "0",
        segmentId: "0",
        frame: makeAudioFrame(item.pcm),
        deltaText: isFirstChunk ? this.inputText : undefined,
        final: item.isLastChunk,
      });
      isFirstChunk = false;
      chunkIndex++;

      if (item.isLastChunk) break;
    }

    session.close();
  }
}
