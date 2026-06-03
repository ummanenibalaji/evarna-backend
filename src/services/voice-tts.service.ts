import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface TTSAudioChunk {
  pcm: Int16Array;
  isLastChunk: boolean;
}

export interface TTSCallbacks {
  onAudioChunk: (chunk: TTSAudioChunk) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

const TTS_SAMPLE_RATE = 48000;
const TTS_CHANNELS = 1;
const HUME_BASE_URL = "wss://api.hume.ai/v0/tts/stream/input";

interface HumePublishTts {
  text?: string;
  voice?: { id: string; provider: "CUSTOM_VOICE" };
  flush?: boolean;
  close?: boolean;
}

/**
 * Session-long Hume TTS streamInput connection.
 * One socket per voice session — turns share it. Saves 500-1000ms/turn vs
 * per-turn sockets and avoids burst-rate-limiting from rapid turn cadence.
 *
 * Lifecycle:
 *   ttts = new HumeTTSSession(voiceId, callbacks)
 *   await ttts.ensureConnected()      // initial open
 *   per turn:
 *     ttts.beginTurn()                 // resets firstChunkAt
 *     ttts.sendText("first sentence.")
 *     ttts.sendText("second sentence.")
 *     ttts.flush()                     // force generation
 *   on barge-in:
 *     ttts.cancelTurn()                // close socket; next sendText auto-reconnects
 *   on session end:
 *     ttts.close()                     // permanent close
 */
export class HumeTTSSession {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private permanentlyClosed = false;
  private firstChunkAt = 0;

  constructor(
    private voiceId: string,
    private callbacks: TTSCallbacks
  ) {}

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  async ensureConnected(): Promise<void> {
    if (this.permanentlyClosed) throw new Error("HumeTTSSession permanently closed");
    if (this.isOpen()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (!env.HUME_API_KEY) {
      throw new Error("HUME_API_KEY not configured");
    }

    const params = new URLSearchParams({
      instant_mode: "true",
      format_type: "pcm",
      version: "2",
      strip_headers: "true",
      // Force JSON-only responses (base64-encoded audio).
      no_binary: "true",
    });

    const url = `${HUME_BASE_URL}?${params.toString()}`;
    const ws = new WebSocket(url, {
      headers: { "X-Hume-Api-Key": env.HUME_API_KEY },
    });
    this.socket = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off("error", onError);
        ws.off("unexpected-response", onUnexpected);
        logger.info({ voiceId: this.voiceId }, "Hume TTS socket open");
        resolve();
      };
      const onError = (err: Error): void => {
        ws.off("open", onOpen);
        reject(err);
      };
      const onUnexpected = (_req: unknown, res: { statusCode?: number }): void => {
        reject(new Error(`Hume HTTP ${res.statusCode ?? "?"}`));
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("unexpected-response", onUnexpected);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      if (this.permanentlyClosed) return;
      let msg: { type?: string; audio?: string; isLastChunk?: boolean };
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        logger.warn({ err }, "Hume message parse failed");
        return;
      }
      if (msg.type !== "audio" || typeof msg.audio !== "string") return;

      if (this.firstChunkAt === 0) {
        this.firstChunkAt = Date.now();
      }

      const buf = Buffer.from(msg.audio, "base64");
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      this.callbacks.onAudioChunk({ pcm, isLastChunk: Boolean(msg.isLastChunk) });
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Hume TTS socket error");
      this.callbacks.onError(err);
    });

    ws.on("close", () => {
      logger.info({ permanent: this.permanentlyClosed }, "Hume TTS socket closed");
      // Allow next ensureConnected() to reopen unless we marked permanent.
      if (this.socket === ws) this.socket = null;
      this.callbacks.onClose();
    });
  }

  /** Reset per-turn state. Should be called at start of every new turn. */
  beginTurn(): void {
    this.firstChunkAt = 0;
  }

  /** Returns the wall-clock ms of the first audio chunk received this turn (0 if none yet). */
  getFirstChunkAt(): number {
    return this.firstChunkAt;
  }

  private send(msg: HumePublishTts): void {
    if (!this.isOpen()) {
      logger.debug({ readyState: this.socket?.readyState }, "Hume socket not open — dropping message");
      return;
    }
    this.socket!.send(JSON.stringify(msg));
  }

  sendText(text: string): void {
    this.send({
      text,
      voice: { id: this.voiceId, provider: "CUSTOM_VOICE" },
    });
  }

  flush(): void {
    this.send({ flush: true });
  }

  /**
   * Cancel the current turn's generation by closing the socket. The next
   * ensureConnected() / sendText() call will reopen. Use when the user
   * has barged in and we want Hume to stop generating immediately.
   */
  cancelTurn(): void {
    this.closeSocket();
  }

  /** Permanently close at session end. */
  close(): void {
    this.permanentlyClosed = true;
    this.closeSocket();
  }

  private closeSocket(): void {
    const s = this.socket;
    if (!s) return;
    try {
      if (s.readyState === WebSocket.CONNECTING) s.terminate();
      else if (s.readyState === WebSocket.OPEN) s.close();
    } catch (err) {
      logger.warn({ err }, "Failed to close Hume socket");
    }
    this.socket = null;
  }
}

export const TTS_OUTPUT_SAMPLE_RATE = TTS_SAMPLE_RATE;
export const TTS_OUTPUT_CHANNELS = TTS_CHANNELS;
