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
import type { VoiceTurnTimer } from "./voice-metrics.service.js";

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

  constructor(
    private readonly voiceId: string,
    // Optional: the OpenAI fallback path and tests construct one without it.
    private readonly timer?: VoiceTurnTimer,
  ) {
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
    return new HumeSynthesizeStream(this, this.getSession(), options?.connOptions, this.timer);
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
   * Release a pending next() without delivering an item, so the caller can
   * re-check its own state. Used when the text side finishes: the drain loop
   * should re-evaluate its exit condition immediately rather than sit out a
   * whole idle window.
   */
  wake(): void {
    this._resolve?.();
    this._resolve = null;
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

    // An empty queue here means wake() released the wait without delivering
    // anything. Treat it as IDLE: shifting an empty array would hand the drain
    // loop an `undefined` it would mistake for an audio chunk.
    if (!gotItem || this._items.length === 0) return IDLE;
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

/**
 * Quiet period after the reply text is complete before the turn is declared
 * over.
 *
 * Measured, Hume returns first audio ~380ms after a flush and up to ~920ms on a
 * cold voice, so 600ms was cutting the final sentence off — heard as a reply
 * losing its last word.
 *
 * An earlier attempt tried to be cleverer, counting a returned `is_last_chunk`
 * per flush and waiting longer while any were outstanding. That assumption is
 * WRONG: Hume does not return one last-chunk per flush, so the count never
 * drained, every turn took the slow path, and each one logged a truncation
 * error that had not happened. A plain quiet-period is both correct and honest
 * about what it knows.
 *
 * This timer only ever elapses when the socket is genuinely silent — incoming
 * chunks reset it. It does not delay playback or affect ttfb; frames are
 * emitted the moment they arrive.
 */
const TAIL_IDLE_MS = 800;

/**
 * How long to wait when a flush has been sent and NO audio has come back for
 * it yet. Covers Hume's measured 380ms warm / 920ms cold first-audio time with
 * room to spare, which is what stops the last sentence being cut off.
 *
 * This is deliberately separate from TAIL_IDLE_MS: once audio is flowing, a
 * short silence means the reply is finished and the turn should end promptly.
 * Waiting the long window on every turn — which an earlier version did by
 * accident — just adds dead time before the agent listens again.
 */
const PENDING_AUDIO_IDLE_MS = 2500;

/**
 * How long to keep waiting for Hume's FIRST audio of a turn once the text is
 * complete. Below the framework's own 10s ttsReadIdleTimeout, so a genuinely
 * dead socket is reported by us rather than force-closed by LiveKit.
 */
const FIRST_AUDIO_TIMEOUT_MS = 8000;

/**
 * ONE_FLUSH_PER_REPLY — why this plugin does not stream sentence by sentence.
 *
 * Flushing at sentence boundaries would let Hume synthesise sentence one while
 * the model writes sentence two, and it did measurably cut latency: the
 * token-to-first-audio stage went from ~2000ms to ~700ms.
 *
 * It also silently destroyed the audio. Measured directly against the Hume
 * streaming endpoint, same text and same voice:
 *
 *     one flush, whole sentence     193920 samples   4.04s   <- correct
 *     two flushes, split at comma    94080 samples   1.96s   <- 49%
 *
 * Roughly HALF the speech never comes back. It is not a race: serialising the
 * flushes (waiting for the first snippet to complete before sending the second)
 * gave 2.20s, back-to-back gave 1.72s, and it is unaffected by instant_mode or
 * by whether the voice object is repeated on each text message. Hume's
 * streaming input simply does not concatenate across flushes the way this
 * plugin assumed.
 *
 * That missing audio is what users heard: crackling where the joins fell,
 * speech that seemed to race because whole clauses were absent, and final words
 * cut short. Correct audio is worth more than the latency, so there is exactly
 * ONE flush per reply, at the end.
 *
 * To get the latency back without the corruption, the next thing to try is a
 * separate Hume connection per segment — sockets open in ~450ms, so a
 * pre-warmed spare could synthesise sentence two while sentence one plays.
 * That is a real piece of work, not a config change.
 */

class HumeSynthesizeStream extends tts.SynthesizeStream {
  label = "hume.octave-2.stream";

  private readonly audioQueue = new AudioChunkQueue();
  private segmentCounter = 0;
  private requestCounter = 0;

  constructor(
    ttsInstance: tts.TTS,
    private readonly humeSession: HumeTTSSession,
    connOptions?: APIConnectOptions,
    private readonly timer?: VoiceTurnTimer,
  ) {
    super(ttsInstance, connOptions);
    // Delivery is claimed in run(), NOT here. Claiming in the constructor meant
    // a stream that was merely CREATED — a speculative preemptive-TTS stream,
    // or the replacement after a barge-in — stole audio from the stream that
    // was actually being played, which arrived as a reply with text and no
    // sound. See the owner token in voice-tts.service.ts.
  }

  /**
   * Text in, audio out — as two concurrent tasks rather than one sequential
   * loop, which is the whole point.
   *
   * The framework hands us the model's text through `this.input` and, because
   * this plugin advertises `streaming: true`, LiveKit does NOT wrap it in its
   * BasicSentenceTokenizer. Its `pumpInput()` therefore pushes every chunk and
   * only calls `endInput()` — the single FLUSH_SENTINEL — once the reply is
   * COMPLETE. The previous implementation waited for that sentinel before
   * asking Hume to generate anything, so no audio existed until the last token
   * of the reply had been written. Measured on a real call, that put ~2000ms
   * between the first model token and the first audio frame.
   *
   * So we do the sentence splitting ourselves: flush at each sentence
   * boundary, and drain audio continuously in parallel. Hume synthesises
   * sentence one while the model is still writing sentence two.
   *
   * Draining never stops between sentences. An earlier sketch drained one
   * segment to quiet before flushing the next, which would have inserted a
   * SEGMENT_IDLE_MS silence between every sentence — trading a slow start for
   * a stuttering middle, and blowing the 600ms maximum-gap rule.
   */
  protected async run(): Promise<void> {
    try {
      await this.humeSession.ensureConnected();
    } catch (err) {
      logger.error({ err }, "hume-tts-plugin: connect failed");
      this.queue.close();
      return;
    }

    const segmentId = String(++this.segmentCounter);
    const requestId = String(this.requestCounter++);

    // One turn per stream: the framework builds a fresh SynthesizeStream for
    // each reply. Clearing here means no turn can inherit a stale item, and
    // beginTurn() clears any leftover discard flag from a barge-in.
    this.audioQueue.clear();
    let token = this.humeSession.beginTurn();
    this.humeSession.setCallbacks({
      onAudioChunk: (chunk) => this.audioQueue.put(chunk),
      onError: (err) => {
        logger.error({ err }, "hume-tts-plugin: audio error");
        this.audioQueue.put(err);
      },
      onClose: () => {
        // Socket dropped mid-turn; wake the drain loop so it doesn't hang.
        // ensureConnected() reopens on the next turn.
        this.audioQueue.put(null);
      },
    });

    let textDone = false;
    let spokenSoFar = "";

    // Audio accounting. `flushed` holds the text of every flush whose snippet
    // has not come back yet, oldest first: it is both how we know audio is
    // still owed, and exactly what has to be re-sent if the socket dies.
    // Retained ONLY so a socket death knows what was never spoken. It is
    // deliberately not used to decide when the turn is over — see TAIL_IDLE_MS.
    const flushed: string[] = [];
    let reconnectsUsed = 0;
    let flushCount = 0;
    let framesEmitted = 0;
    // Stage stamps for the TTS window. The turn-level metric says this stage
    // costs ~889ms while Hume measured standalone answers a flush in ~380ms.
    // These locate the missing ~500ms: time spent waiting for the model to
    // finish (tLastText), time between that and the flush actually going out
    // (tFlush), and Hume's own response (first audio).
    const tStart = Date.now();
    let tLastText = 0;
    let tFlush = 0;
    let sawLastChunk = false;
    let exitReason = "unknown";
    let firstFrameAt = 0;
    // Chunks received since the most recent flush. Zero means Hume owes us
    // audio it has not started sending.
    let audioSinceLastFlush = 0;

    // ── Task A: text → Hume, flushing at sentence boundaries ─────────────────
    const feedText = async (): Promise<void> => {
      let unflushed = "";
      let everFlushed = false;
      try {
        for await (const item of this.input) {
          if (this.abortSignal.aborted) break;

          if (typeof item === "string") {
            unflushed += item;
            spokenSoFar += item;
            tLastText = Date.now();
            this.humeSession.sendText(item, token);
            // NO mid-reply flush. See the note on ONE_FLUSH_PER_REPLY below.
            continue;
          }

          // FLUSH_SENTINEL — the reply is complete. This is the ONLY flush.
          if (unflushed.trim().length > 0 || !everFlushed) {
            tFlush = Date.now();
            this.humeSession.flush(token);
            flushed.push(unflushed);
            flushCount++;
            audioSinceLastFlush = 0;
            everFlushed = true;
          }
          unflushed = "";
        }
      } finally {
        textDone = true;
        // Wake the drain loop so it re-evaluates its exit condition instead of
        // sitting out a full idle window.
        this.audioQueue.wake();
      }
    };

    // ── Task B: Hume audio → the caller ──────────────────────────────────────
    const drainAudio = async (): Promise<void> => {
      // `final` must mark the last frame of the turn, so hold one chunk back:
      // emit it only once the next arrives (not final) or the turn ends (final).
      let held: TTSAudioChunk | null = null;
      let isFirstChunk = true;
      let receivedAny = false;
      let waitedForFirst = 0;

      const emit = (chunk: TTSAudioChunk, final: boolean): void => {
        // V-03: first audio of the reply reaching the caller — the end of the
        // ttfb measurement.
        if (isFirstChunk) {
          this.timer?.markTtsFirstFrame();
          firstFrameAt = Date.now();
        }
        framesEmitted++;
        this.queue.put({
          requestId,
          segmentId,
          frame: makeAudioFrame(chunk.pcm),
          deltaText: isFirstChunk ? spokenSoFar : undefined,
          final,
        });
        isFirstChunk = false;
      };

      while (true) {
        if (this.abortSignal.aborted) {
          exitReason = "aborted";
          // Emit the held chunk before leaving. The one-chunk lookahead always
          // has the most recent audio in hand, and dropping it here removed the
          // tail of the final word — "laptop" arriving as "lapt".
          if (held) emit(held, true);
          held = null;
          this.humeSession.cancelTurn(token, flushed.length);
          break;
        }

        // Another turn claimed the socket: this stream has been superseded and
        // no further audio belongs to it. Leaving the loop here also stops it
        // sitting out the first-audio timeout for a turn that will never come.
        if (!this.humeSession.isOwner(token)) {
          exitReason = "superseded";
          if (held) emit(held, true);
          held = null;
          break;
        }

        // Before the text is done, a quiet socket just means the model has not
        // written the next sentence yet. After it, how long to wait depends on
        // whether Hume has started answering the last flush: nothing yet means
        // audio is still coming and cutting here would lose the final sentence.
        const idleWindow = !textDone
          ? SEGMENT_IDLE_MS
          : audioSinceLastFlush === 0
            ? PENDING_AUDIO_IDLE_MS
            : TAIL_IDLE_MS;
        const next = await this.audioQueue.next(idleWindow);

        if (next === IDLE) {
          // Quiet socket only ends the turn once the text is finished. Before
          // that it just means the model has not produced the next sentence
          // yet, which must not be mistaken for the end of the reply.
          if (!textDone) continue;
          if (!receivedAny) {
            waitedForFirst += idleWindow;
            if (waitedForFirst < FIRST_AUDIO_TIMEOUT_MS) continue;
            // A reply that produced NO audio at all. This is the silent-reply
            // symptom, reported unambiguously rather than inferred.
            logger.error(
              { waitedMs: waitedForFirst, flushes: flushCount, chars: spokenSoFar.length },
              "hume-tts-plugin: SILENT REPLY — text was flushed but Hume returned no audio",
            );
          }
          exitReason = receivedAny ? "idle-after-audio" : "no-audio-timeout";
          if (held) emit(held, true);
          held = null;
          break;
        }

        // null = socket closed, Error = TTS failure
        if (next === null || next instanceof Error) {
          // V-02: a socket that dies with text still unspoken must not silently
          // swallow the rest of the sentence. Reconnect and re-send what was
          // never spoken — once. A second failure is a real outage, and looping
          // on it would just stall the turn.
          const unspoken = flushed.join("");
          const recoverable =
            unspoken.trim().length > 0 && !this.abortSignal.aborted && reconnectsUsed < 1;

          if (recoverable) {
            reconnectsUsed++;
            logger.warn(
              { unspokenChars: unspoken.length, segments: flushed.length },
              "hume-tts-plugin: socket died mid-reply — reconnecting and re-sending unspoken text",
            );
            try {
              await this.humeSession.ensureConnected();
              // The reconnect resets ownership state, so re-claim before
              // re-sending or the guard would drop our own text.
              const retryToken = this.humeSession.beginTurn();
              this.humeSession.setCallbacks({
                onAudioChunk: (chunk) => this.audioQueue.put(chunk),
                onError: (err) => this.audioQueue.put(err),
                onClose: () => this.audioQueue.put(null),
              });
              this.humeSession.sendText(unspoken, retryToken);
              this.humeSession.flush(retryToken);
              // Everything outstanding went back as ONE flush, so the
              // accounting has to collapse to one entry too — otherwise the
              // leftover entries would never clear and the turn would always
              // end on the slow path with a false truncation warning.
              flushed.length = 0;
              flushed.push(unspoken);
              token = retryToken;
              continue;
            } catch (err) {
              logger.error({ err }, "hume-tts-plugin: reconnect failed — reply is truncated");
            }
          } else if (unspoken.trim().length > 0 && !this.abortSignal.aborted) {
            logger.error(
              { unspokenChars: unspoken.length },
              "hume-tts-plugin: socket died again — giving up with text unspoken",
            );
          }

          if (held) emit(held, true);
          held = null;
          break;
        }

        receivedAny = true;
        audioSinceLastFlush++;
        if (next.isLastChunk) sawLastChunk = true;
        // A completed snippet means that much text is spoken and no longer
        // needs re-sending if the socket dies.
        if (next.isLastChunk) flushed.shift();
        if (held) emit(held, false);
        held = next;
      }
    };

    await Promise.all([feedText(), drainAudio()]);

    // Snippets still outstanding means Hume is STILL generating audio for this
    // reply that nobody is going to read. Left alone it arrives during the next
    // turn and is played as part of the next reply. Abandon it explicitly.
    if (flushed.length > 0) {
      logger.warn(
        { outstanding: flushed.length },
        "hume-tts-plugin: turn ended with audio still generating — abandoning it so it cannot leak into the next reply",
      );
      this.humeSession.discardPending(token, flushed.length);
    }

    // One line per reply, so "the voice was not audible" is a fact in the log
    // rather than something to be inferred from a missing metric.
    // framesEmitted === 0 IS the silent-reply symptom.
    logger.info(
      {
        frames: framesEmitted,
        flushes: flushCount,
        chars: spokenSoFar.length,
        unspokenSegments: flushed.length,
        aborted: this.abortSignal.aborted,
        // Where the TTS stage's time actually goes:
        //   text_ms  — waiting for the model to finish writing the reply
        //   flush_ms — our own overhead between last token and the flush
        //   hume_ms  — Hume's time to return the first audio frame
        text_ms: tLastText ? tLastText - tStart : null,
        flush_ms: tFlush && tLastText ? tFlush - tLastText : null,
        hume_ms: tFlush && firstFrameAt ? firstFrameAt - tFlush : null,
        // "no" here on a completed turn means we ended before Hume said it was
        // finished — which is what a clipped final word looks like.
        saw_last_chunk: sawLastChunk,
        exit: exitReason,
      },
      framesEmitted === 0 ? "hume-tts-plugin: reply produced NO audio" : "hume-tts-plugin: reply spoken",
    );

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

    try {
      await this.session.ensureConnected();
    } catch (err) {
      logger.error({ err }, "hume-tts-plugin: chunked connect failed");
      return;
    }

    // Claim the shared socket, then bind delivery — same ownership rule as the
    // streaming path, so a greeting and a first reply cannot silence each other.
    const token = this.session.beginTurn();
    this.session.setCallbacks({
      onAudioChunk: (chunk) => audioQueue.put(chunk),
      onError: (err) => {
        logger.error({ err }, "hume-tts-plugin: chunked audio error");
        audioQueue.put(err);
      },
      onClose: () => audioQueue.put(null),
    });

    this.session.sendText(this.inputText, token);
    this.session.flush(token);

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
      // Superseded by a later turn — stop rather than consume its audio.
      if (!this.session.isOwner(token)) {
        if (held) emit(held, true);
        held = null;
        break;
      }

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
