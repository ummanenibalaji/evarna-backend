import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { resolveHumeVoice } from "../data/voices.js";

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

/**
 * Longest we will keep dropping audio while waiting for an abandoned
 * generation to close itself out. Past this, assume its closing snippet is
 * never coming and accept the new turn's audio instead.
 */
const DISCARD_DEADLINE_MS = 5000;

interface HumePublishTts {
  text?: string;
  voice?: { id: string; provider: "HUME_AI" | "CUSTOM_VOICE" };
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
  // Set by cancelTurn() on barge-in. Hume keeps generating the abandoned turn,
  // so its remaining chunks must be dropped rather than leaking into the next
  // turn's audio. Cleared by beginTurn().
  private discarding = false;
  // How many more snippet-ends must arrive before the abandoned generation is
  // fully drained. Hume streams sequentially on one socket, so its leftover
  // audio always arrives BEFORE the next turn's — which is what makes counting
  // snippet-ends a reliable boundary.
  private discardSnippetsRemaining = 0;
  private discardStartedAt = 0;

  // Which SynthesizeStream currently owns this socket.
  //
  // One socket is shared by the whole call, but MORE THAN ONE stream can be
  // alive at once — a barge-in leaves the old stream draining while the new one
  // starts, and preemptive TTS makes a speculative stream overlap the committed
  // one by design. Without an owner, two failures follow:
  //
  //   1. the newest stream's constructor rebound the audio callbacks, so the
  //      stream actually being played received nothing;
  //   2. a superseded stream calling cancelTurn() set `discarding` on the
  //      SHARED session, silencing the audio of the stream that replaced it.
  //
  // Either one produces the reported symptom exactly: the reply appears as
  // text, and nothing is spoken. Every turn-scoped call now carries the token
  // it was issued, and a stale token is ignored.
  private ownerToken = 0;

  // A trailing half sample from the previous chunk, waiting for its other half.
  // See decodePcm().
  private pcmCarry: Buffer | null = null;

  constructor(
    private voiceId: string,
    private callbacks: TTSCallbacks
  ) {}

  /**
   * Rebind the audio/error sink. The socket outlives any single
   * SynthesizeStream, so each new stream claims delivery for its own queue.
   */
  setCallbacks(callbacks: TTSCallbacks): void {
    this.callbacks = callbacks;
  }

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
      let msg: { type?: string; audio?: string; isLastChunk?: boolean; is_last_chunk?: boolean };
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        logger.warn({ err }, "Hume message parse failed");
        return;
      }
      if (msg.type !== "audio" || typeof msg.audio !== "string") {
        if (msg.type === "error" || (msg as { status_code?: number }).status_code) {
          logger.error({ humeMessage: msg }, "Hume TTS returned error message");
        }
        return;
      }
      if (this.discarding) {
        // Count the abandoned generation out. Once its last snippet has passed,
        // the socket is clean and the next turn's audio is safe to deliver.
        if (Boolean(msg.is_last_chunk ?? msg.isLastChunk)) {
          this.discardSnippetsRemaining -= 1;
          if (this.discardSnippetsRemaining <= 0) {
            this.discarding = false;
            this.discardSnippetsRemaining = 0;
            this.pcmCarry = null;
          }
        }
        return;
      }

      if (this.firstChunkAt === 0) {
        this.firstChunkAt = Date.now();
      }

      // Hume sends snake_case (`is_last_chunk`); older SDK docs used camelCase.
      const isLastChunk = Boolean(msg.is_last_chunk ?? msg.isLastChunk);
      const pcm = this.decodePcm(msg.audio, isLastChunk);
      if (pcm.length === 0) return;
      this.callbacks.onAudioChunk({ pcm, isLastChunk });
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

  /**
   * Decode one base64 PCM chunk into 16-bit samples.
   *
   * Two things this has to get right, and the previous one-liner —
   * `new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)` — got
   * both wrong:
   *
   * 1. ODD-LENGTH CHUNKS. Hume's chunk boundaries are not guaranteed to fall
   *    between samples. When byteLength is odd, `byteLength / 2` is fractional
   *    and gets truncated, so the trailing byte was silently DROPPED. The next
   *    chunk then began mid-sample and every sample after it was shifted by one
   *    byte — heard as crackling that worsens through the reply. The half
   *    sample is now carried over and prepended to the next chunk, which is
   *    where its other half actually is.
   *
   * 2. ALIGNMENT. Node hands out Buffers from a shared pool, so `byteOffset` is
   *    an offset into memory shared with unrelated data. Int16Array requires a
   *    2-byte-aligned offset and throws otherwise — inside a WebSocket message
   *    handler, where nothing catches it. Copying into a fresh buffer makes
   *    alignment guaranteed rather than lucky.
   */
  private decodePcm(base64Audio: string, isLastChunk: boolean): Int16Array {
    const incoming = Buffer.from(base64Audio, "base64");
    const buf = this.pcmCarry ? Buffer.concat([this.pcmCarry, incoming]) : incoming;

    const usableBytes = buf.byteLength - (buf.byteLength % 2);

    // A trailing half sample belongs to the NEXT chunk. Copied, not sliced:
    // subarray would keep a view onto a pooled buffer that may be reused.
    this.pcmCarry =
      usableBytes < buf.byteLength ? Buffer.from(buf.subarray(usableBytes)) : null;

    // At the end of a snippet there is no next chunk, so a leftover byte is a
    // genuine half sample with nothing to pair it with. Drop it.
    if (isLastChunk) this.pcmCarry = null;

    if (usableBytes === 0) return new Int16Array(0);

    const aligned = new Uint8Array(usableBytes);
    aligned.set(buf.subarray(0, usableBytes));
    return new Int16Array(aligned.buffer);
  }

  /**
   * Claim the socket for a new turn and reset per-turn state.
   *
   * Returns the owner token for this turn. Pass it back to sendText(), flush()
   * and cancelTurn(); once another turn has claimed the socket, those calls
   * become no-ops instead of corrupting the turn that replaced this one.
   */
  beginTurn(): number {
    this.firstChunkAt = 0;
    // A half sample left over from the previous turn belongs to audio nobody
    // will hear; carrying it in would shift every sample of this one.
    this.pcmCarry = null;

    // Deliberately NOT clearing `discarding` unconditionally.
    //
    // Hume keeps generating an abandoned turn after we stop listening to it —
    // cancelTurn() does not stop the server, it only stops us reading. Clearing
    // the flag here meant the tail of the ABANDONED reply arrived after the new
    // turn had started and was delivered into the new turn's queue, where it
    // was played as part of the new reply. Two generations' PCM spliced
    // together is heard as crackling, and as speech that speeds up and slows
    // down, because it is literally two different utterances interleaved.
    //
    // So the stale generation is counted out (see the message handler) before
    // anything new is accepted. The deadline is a safety valve: if Hume never
    // sends the closing snippet, one lost turn is better than a mute call.
    if (this.discarding && Date.now() - this.discardStartedAt > DISCARD_DEADLINE_MS) {
      logger.warn(
        { remaining: this.discardSnippetsRemaining },
        "Hume TTS: abandoned generation never closed — releasing the discard guard",
      );
      this.discarding = false;
      this.discardSnippetsRemaining = 0;
    }

    return ++this.ownerToken;
  }

  /** Whether `token` still owns this socket. */
  isOwner(token: number): boolean {
    return token === this.ownerToken;
  }

  /**
   * Whether the current turn's audio is being thrown away.
   *
   * Exposed for the ownership regression check: "a stale stream silenced the
   * live one" is otherwise invisible from outside until someone reports a
   * reply that had text and no sound.
   */
  isDiscarding(): boolean {
    return this.discarding;
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

  sendText(text: string, token?: number): void {
    if (token !== undefined && !this.isOwner(token)) return;
    this.send({
      text,
      voice: resolveHumeVoice(this.voiceId),
    });
  }

  flush(token?: number): void {
    if (token !== undefined && !this.isOwner(token)) return;
    this.send({ flush: true });
  }

  /**
   * Abandon the current turn's audio after a barge-in.
   *
   * This used to close the socket, which did stop Hume generating — but it
   * also meant every interruption cost a full WebSocket reconnect (500-1000ms)
   * on the following turn, which is the exact overhead this class exists to
   * avoid. Instead the socket stays up and the abandoned turn's chunks are
   * dropped in the message handler.
   *
   * Trade-off: Hume finishes generating (and bills for) audio nobody hears.
   * That is a few hundred characters against a second of latency on the reply
   * the user is actually waiting for.
   */
  cancelTurn(token?: number, outstandingSnippets = 1): void {
    // A superseded stream must NOT discard the audio of the turn that replaced
    // it. This guard is the difference between "the barge-in was abandoned"
    // and "the next reply was silent".
    if (token !== undefined && !this.isOwner(token)) return;
    this.discarding = true;
    this.discardSnippetsRemaining = Math.max(1, outstandingSnippets);
    this.discardStartedAt = Date.now();
  }

  /**
   * Abandon whatever Hume is still generating for this turn.
   *
   * Called when a turn stops reading its audio while snippets are still
   * outstanding — an interruption, or a tail that never arrived. Identical to
   * cancelTurn(); named separately because a normal end that leaves audio
   * behind is not a barge-in, and conflating them makes the logs lie.
   */
  discardPending(token: number, outstandingSnippets: number): void {
    if (outstandingSnippets <= 0) return;
    this.cancelTurn(token, outstandingSnippets);
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
