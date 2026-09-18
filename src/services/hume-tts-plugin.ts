import { tts, voice } from "@livekit/agents";
import type { APIConnectOptions } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import { ReadableStream } from "node:stream/web";
import {
  HumeTTSSession,
  TTS_OUTPUT_SAMPLE_RATE,
  TTS_OUTPUT_CHANNELS,
  normalizeSpoken,
  spokenCovers,
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

type TextTransform = voice.textTransforms.TextTransform;

/**
 * LiveKit's default TTS text transforms. voice.service.ts passes this same
 * list to both AgentSession and HumeTTS, so text synthesised ahead of time
 * (Presynthesis) is transformed exactly as the streamed text would be.
 */
export const TTS_TEXT_TRANSFORMS: readonly TextTransform[] = ["filter_markdown", "filter_emoji"];

export class HumeTTS extends tts.TTS {
  label = "hume.octave-2";

  // Lazily opened on the first stream, then shared by every turn of the call.
  private sharedSession: HumeTTSSession | null = null;
  // At most one reply synthesised ahead of its moderation verdict.
  private pendingPresynthesis: Presynthesis | null = null;

  constructor(
    private readonly voiceId: string,
    // Optional: the OpenAI fallback path and tests construct one without it.
    private readonly timer?: VoiceTurnTimer,
    private readonly textTransforms: readonly TextTransform[] = TTS_TEXT_TRANSFORMS,
  ) {
    super(TTS_OUTPUT_SAMPLE_RATE, TTS_OUTPUT_CHANNELS, { streaming: true });
  }

  /**
   * Start synthesising a finished reply whose moderation verdict is still out.
   * Its audio is buffered, never emitted, until a SynthesizeStream carrying the
   * same text adopts it — which can only happen after the verdict passes,
   * because that is when the text is released to LiveKit. See Presynthesis.
   */
  presynthesize(chunks: readonly string[]): Presynthesis {
    this.pendingPresynthesis?.discard();
    const pre = new Presynthesis(this.getSession(), chunks, this.textTransforms);
    this.pendingPresynthesis = pre;
    return pre;
  }

  /** Hand the pending presynthesis (if still usable) to the stream about to run. */
  takePresynthesis(): Presynthesis | null {
    const pre = this.pendingPresynthesis;
    this.pendingPresynthesis = null;
    return pre && pre.pending ? pre : null;
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

/** Run text through LiveKit's own TTS text transforms, as its pipeline would. */
async function transformForTts(
  chunks: readonly string[],
  transforms: readonly TextTransform[],
): Promise<string[]> {
  if (transforms.length === 0) return [...chunks];
  const source = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const reader = voice.textTransforms.applyTextTransforms(source, transforms).getReader();
  const out: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/**
 * A reply synthesised while its moderation verdict was still out.
 *
 * Moderation from this deployment takes 300ms-3.5s and is often slower than
 * generating the whole reply. Before this, synthesis could not start until the
 * verdict, and Hume then needed ~600ms more for first audio. Now the finished
 * reply goes to Hume at once — ONE text send and ONE flush, the same shape as
 * a normal turn — and its audio collects in this object's own queue.
 *
 * Nothing here is ever emitted by itself. Audio reaches the caller only when a
 * SynthesizeStream ADOPTS it, and a stream exists only once
 * streamConversation() has released the reply text, i.e. after the verdict
 * passed. Adoption also requires the stream's text to be this text. On a
 * crisis verdict, a mismatch, or a newer turn, discard() abandons the Hume turn
 * and exactly its unspoken audio is dropped (abandonTurn).
 */
export class Presynthesis {
  private state: "starting" | "ready" | "adopted" | "discarded" = "starting";
  readonly queue = new AudioChunkQueue();
  token = 0;
  /** Exactly what Hume was sent, after LiveKit's transforms. */
  text = "";
  flushedAt = 0;
  readonly ready: Promise<boolean>;

  constructor(
    private readonly session: HumeTTSSession,
    chunks: readonly string[],
    transforms: readonly TextTransform[],
  ) {
    this.ready = this.start(chunks, transforms).catch((err) => {
      logger.warn({ err }, "hume-tts-plugin: presynthesis failed — the reply will be synthesised normally");
      this.state = "discarded";
      return false;
    });
  }

  get pending(): boolean {
    return this.state === "starting" || this.state === "ready";
  }

  private async start(chunks: readonly string[], transforms: readonly TextTransform[]): Promise<boolean> {
    const pieces = await transformForTts(chunks, transforms);
    await this.session.ensureConnected();
    if (this.state !== "starting") return false;
    // From here to the flush is synchronous, so discard() cannot interleave.
    this.token = this.session.beginTurn();
    this.session.setCallbacks({
      onAudioChunk: (chunk) => this.queue.put(chunk),
      onError: (err) => this.queue.put(err),
      onClose: () => this.queue.put(null),
    });
    for (const piece of pieces) this.session.sendText(piece, this.token);
    this.session.flush(this.token);
    this.flushedAt = Date.now();
    this.text = pieces.join("");
    this.state = "ready";
    return true;
  }

  /** Why the last adopt() said no — logged by the stream. */
  refusal = "";

  /** Take ownership if `streamText` is this reply. False means synthesise normally. */
  async adopt(streamText: string): Promise<boolean> {
    if (!(await this.ready)) {
      this.refusal = "not-sent";
      return false;
    }
    if (this.state !== "ready") {
      this.refusal = this.state;
      return false;
    }
    if (!this.session.isOwner(this.token)) {
      this.refusal = "socket-reclaimed";
      return false;
    }
    if (normalizeSpoken(streamText) !== normalizeSpoken(this.text)) {
      this.refusal = `text-differs(${normalizeSpoken(streamText).length}/${normalizeSpoken(this.text).length})`;
      return false;
    }
    this.state = "adopted";
    return true;
  }

  /** Never to be heard: drop its Hume turn, and exactly its unspoken audio. */
  discard(): void {
    if (this.state === "adopted" || this.state === "discarded") return;
    const sent = this.state === "ready";
    this.state = "discarded";
    // Still "starting": start() sees the state and never claims the socket.
    if (sent) this.session.abandonTurn(this.token);
  }
}

// ── Shared audio helpers ──────────────────────────────────────────────────────

// Build a LiveKit AudioFrame from Hume's PCM Int16Array chunk.
function makeAudioFrame(pcm: Int16Array): AudioFrame {
  return new AudioFrame(pcm, TTS_OUTPUT_SAMPLE_RATE, TTS_OUTPUT_CHANNELS, pcm.length);
}

/** Returned by next() when the wait window elapsed with no new chunk. */
export const IDLE = Symbol("idle");
/**
 * Returned by next() when wake() released the wait early with nothing in it.
 *
 * Deliberately NOT the same as IDLE. It used to be, and that is the lost-reply
 * bug: when the reply text finished, feedText() woke the drain loop, which read
 * the wake-up as "the socket has been quiet for the whole idle window" and —
 * because one pre-flush snippet had already produced audio — ended the turn a
 * millisecond after the flush. Everything Hume generated for that flush was
 * then thrown away and the caller heard nothing. A wake-up only means "your
 * state changed, look again".
 */
export const WOKE = Symbol("woke");

/** Stands in for LiveKit's flush sentinel when buffered input is replayed. */
const REPLAY_END = Symbol("replay-end");

/**
 * Tracks which of a reply's text Hume has finished speaking.
 *
 * Hume never says "this flush is done": `is_last_chunk` closes one SNIPPET, a
 * flush can come back as several, and a long reply starts its first snippet
 * before the flush is even sent (Hume begins generating once ~250 characters
 * are buffered). What every chunk does carry is the text of its snippet. So the
 * reply is complete exactly when the snippets that have finished have spoken
 * through to the end of the text that was sent — which is the one end-of-reply
 * signal that cannot fire early.
 *
 * Content is compared, not just length: if text abandoned by an earlier turn
 * were ever spoken in front of this reply, a length check would pass before the
 * reply's own last words had arrived. Requiring the END of the reply to match
 * the end of what has been spoken rules that out.
 */
export class ReplyCoverage {
  private expected = "";
  private spoken = "";
  private readonly finished = new Set<string>();
  /** Whether Hume has reported snippet text at all (it always has, measured). */
  known = false;

  /** The full text of the reply, as sent to Hume. */
  setExpected(rawText: string): void {
    this.expected = normalizeSpoken(rawText);
  }

  /** Forget what has been spoken — used when the reply is re-sent on a new socket. */
  resetSpoken(): void {
    this.spoken = "";
    this.finished.clear();
  }

  /** Record a snippet's closing chunk. Idempotent per snippet id. */
  snippetFinished(snippetId: string | undefined, snippetText: string | undefined): void {
    if (snippetText === undefined) return;
    this.known = true;
    if (snippetId !== undefined) {
      if (this.finished.has(snippetId)) return;
      this.finished.add(snippetId);
    }
    this.spoken += normalizeSpoken(snippetText);
  }

  /** True once the end of the reply has been spoken. An empty reply is trivially complete. */
  complete(): boolean {
    return spokenCovers(this.spoken, this.expected);
  }

  get expectedChars(): number {
    return this.expected.length;
  }

  get spokenChars(): number {
    return this.spoken.length;
  }

  /**
   * The part of `rawText` that has not been spoken yet, for re-sending after a
   * socket death. Falls back to the whole text when what was spoken does not
   * line up with the start of the reply.
   */
  unspokenSuffix(rawText: string): string {
    if (this.complete()) return "";
    if (this.spoken.length === 0 || !this.expected.startsWith(this.spoken)) return rawText;
    let seen = 0;
    for (let i = 0; i < rawText.length; i++) {
      if (normalizeSpoken(rawText[i]!).length > 0) seen++;
      if (seen === this.spoken.length) return rawText.slice(i + 1);
    }
    return "";
  }
}

// Simple async queue that bridges Hume callback events to async iteration.
export class AudioChunkQueue {
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
  async next(timeoutMs?: number): Promise<TTSAudioChunk | Error | null | typeof IDLE | typeof WOKE> {
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
    // Released with an empty queue: wake() was called. That is NOT a quiet
    // socket — see WOKE. (Shifting the empty array would also hand the drain
    // loop an `undefined` it would mistake for an audio chunk.)
    if (this._items.length === 0) return WOKE;
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
 * Also the allowance for a silence BETWEEN snippets while the end of the reply
 * is known to be unspoken (see ReplyCoverage). Measured gaps between snippets
 * of one flush are 50-410ms; this only elapses if Hume has genuinely stalled.
 *
 * Neither case adds dead time to a normal turn: a reply now ends the moment
 * its last snippet closes, not after a quiet period. TAIL_IDLE_MS remains only
 * as the fallback if Hume ever stops echoing snippet text.
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
    private readonly owner: HumeTTS,
    private readonly humeSession: HumeTTSSession,
    connOptions?: APIConnectOptions,
    private readonly timer?: VoiceTurnTimer,
  ) {
    super(owner, connOptions);
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

    // A reply synthesised ahead of its moderation verdict (see Presynthesis).
    // Its text arrives here in one burst once the verdict has passed, so read
    // the whole input first and adopt only if it is the same reply. Nothing is
    // sent to Hume while deciding; if it is not adopted, the text is replayed
    // into the normal path below, which only generates at its flush anyway.
    const pre = this.owner.takePresynthesis();
    let adopted: Presynthesis | null = null;
    let replay: Array<string | typeof REPLAY_END> | null = null;
    let presynth = "none";
    if (pre) {
      const items: string[] = [];
      let sawEnd = false;
      for await (const item of this.input) {
        if (this.abortSignal.aborted) break;
        if (typeof item === "string") {
          items.push(item);
          continue;
        }
        sawEnd = true;
        break;
      }
      if (sawEnd && !this.abortSignal.aborted && (await pre.adopt(items.join("")))) {
        adopted = pre;
        presynth = "adopted";
      } else {
        pre.discard();
        presynth = this.abortSignal.aborted ? "aborted" : sawEnd ? `refused:${pre.refusal}` : "no-end";
      }
      replay = sawEnd ? [...items, REPLAY_END] : items;
    }

    // One turn per stream: the framework builds a fresh SynthesizeStream for
    // each reply. Clearing here means no turn can inherit a stale item, and
    // beginTurn() clears any leftover discard flag from a barge-in.
    this.audioQueue.clear();
    // Where this turn's audio arrives: its own queue, or the adopted one that
    // has been collecting Hume's audio since the early flush.
    const activeQueue = adopted ? adopted.queue : this.audioQueue;
    // An interruption must be acted on at once, not whenever the next chunk or
    // idle timeout happens to wake the drain loop: until this turn abandons the
    // socket, anything it left in Hume's buffer is waiting to be glued onto the
    // next reply.
    this.abortSignal.addEventListener("abort", () => activeQueue.wake(), { once: true });
    let token = adopted ? adopted.token : this.humeSession.beginTurn();
    if (!adopted) {
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
    }

    let textDone = false;
    let spokenSoFar = "";

    // What Hume has finished speaking, snippet by snippet. This is what decides
    // that the reply is over — see ReplyCoverage.
    const coverage = new ReplyCoverage();
    // Whether a snippet closed after the flush. Only consulted if Hume ever
    // stops echoing snippet text, as the fallback end-of-reply signal.
    let lastChunkSinceFlush = false;
    // Audio Hume still owes this reply: the flush has gone out and the end of
    // the reply has not been spoken. Decides whether an early exit must arm the
    // discard guard, and what a socket death has to re-send.
    const outstandingSnippets = (): number => {
      if (flushCount === 0) return 0;
      const done = coverage.known ? coverage.complete() : lastChunkSinceFlush;
      return done ? 0 : 1;
    };
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
    let audioSamples = 0;
    // Chunks received since the most recent flush. Zero means Hume owes us
    // audio it has not started sending.
    let audioSinceLastFlush = 0;

    // ── Task A: text → Hume, flushing at sentence boundaries ─────────────────
    const feedText = async (): Promise<void> => {
      if (adopted) {
        // Already sent and flushed by the presynthesis — the one flush of this
        // reply. Record what Hume owes and let the drain loop play it.
        spokenSoFar = (replay ?? []).filter((x): x is string => typeof x === "string").join("");
        tLastText = tStart;
        tFlush = adopted.flushedAt;
        coverage.setExpected(adopted.text);
        flushCount = 1;
        textDone = true;
        activeQueue.wake();
        return;
      }
      let unflushed = "";
      let everFlushed = false;
      const source: AsyncIterable<string | typeof REPLAY_END | symbol> = replay
        ? (async function* () { yield* replay; })()
        : this.input;
      try {
        for await (const item of source) {
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
            coverage.setExpected(spokenSoFar);
            this.humeSession.flush(token);
            flushCount++;
            audioSinceLastFlush = 0;
            lastChunkSinceFlush = false;
            everFlushed = true;
          }
          unflushed = "";
        }
      } finally {
        textDone = true;
        // Wake the drain loop so it re-evaluates its exit condition instead of
        // sitting out a full idle window.
        activeQueue.wake();
      }
    };

    // ── Task B: Hume audio → the caller ──────────────────────────────────────
    const drainAudio = async (): Promise<void> => {
      // Frames go out the moment they arrive. This used to hold one chunk back so
      // the true last frame could carry `final: true` — but LiveKit reads `final`
      // only to emit per-segment METRICS (tts.js), and emits them again at end of
      // stream regardless, so nothing audible depends on it. Measured, Hume's
      // first two real chunks arrive 116-176ms apart, so the hold-back delayed
      // the first word of every reply by that much for a metrics flag.
      let isFirstChunk = true;
      let receivedAny = false;
      // Quiet time spent waiting for Hume to START answering the flush.
      let waitedForFlushAudio = 0;

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
          // Nothing is held back any more, so every frame received has already
          // been emitted — the tail of the final word cannot be dropped here
          // (it once was: "laptop" arriving as "lapt").
          // Discard exactly what Hume has not finished speaking — nothing if
          // the reply had already arrived in full (see abandonTurn()).
          this.humeSession.abandonTurn(token);
          break;
        }

        // Another turn claimed the socket: this stream has been superseded and
        // no further audio belongs to it. Leaving the loop here also stops it
        // sitting out the first-audio timeout for a turn that will never come.
        if (!this.humeSession.isOwner(token)) {
          exitReason = "superseded";
          break;
        }

        // The reply is over when Hume has spoken through to the end of the
        // text — not when the socket goes quiet. Ending here, the moment the
        // last snippet closes, also stops the turn sitting out a quiet period
        // it no longer needs.
        if (textDone && flushCount > 0 && coverage.known && coverage.complete()) {
          exitReason = "complete";
          break;
        }
        // Nothing was ever sent (an empty reply): no audio is coming.
        if (textDone && flushCount > 0 && coverage.expectedChars === 0) {
          exitReason = "empty-reply";
          break;
        }

        // Before the text is done, a quiet socket just means the model has not
        // written the next sentence yet. After it, silence is only an ending
        // signal once Hume has started answering the FLUSH — audio from a
        // snippet it began on its own before the flush does not count.
        //   no audio since the flush  -> Hume has not started; keep waiting
        //   audio, reply text unspoken -> between snippets; allow a long gap
        //   (fallback) no snippet text -> the old quiet-period rule
        const idleWindow = !textDone
          ? SEGMENT_IDLE_MS
          : audioSinceLastFlush === 0 || coverage.known
            ? PENDING_AUDIO_IDLE_MS
            : TAIL_IDLE_MS;
        const next = await activeQueue.next(idleWindow);

        // The text side finished (or something else changed): look again with
        // the new state. This is not silence — see WOKE.
        if (next === WOKE) continue;

        if (next === IDLE) {
          // Quiet socket only ends the turn once the text is finished. Before
          // that it just means the model has not produced the next sentence
          // yet, which must not be mistaken for the end of the reply.
          if (!textDone) continue;
          if (audioSinceLastFlush === 0 && flushCount > 0) {
            waitedForFlushAudio += idleWindow;
            if (waitedForFlushAudio < FIRST_AUDIO_TIMEOUT_MS) continue;
            if (!receivedAny) {
              // A reply that produced NO audio at all. This is the silent-reply
              // symptom, reported unambiguously rather than inferred.
              logger.error(
                { waitedMs: waitedForFlushAudio, flushes: flushCount, chars: spokenSoFar.length },
                "hume-tts-plugin: SILENT REPLY — text was flushed but Hume returned no audio",
              );
            } else {
              logger.error(
                {
                  waitedMs: waitedForFlushAudio,
                  spokenChars: coverage.spokenChars,
                  expectedChars: coverage.expectedChars,
                },
                "hume-tts-plugin: TRUNCATED REPLY — Hume never answered the flush after a pre-flush snippet",
              );
            }
            exitReason = receivedAny ? "flush-unanswered" : "no-audio-timeout";
            break;
          }
          if (coverage.known) {
            // Audio flowed after the flush, then stopped for a long time with
            // the end of the reply still unspoken.
            logger.error(
              {
                quietMs: idleWindow,
                spokenChars: coverage.spokenChars,
                expectedChars: coverage.expectedChars,
              },
              "hume-tts-plugin: TRUNCATED REPLY — Hume went quiet before the end of the reply was spoken",
            );
            exitReason = "stalled-incomplete";
            break;
          }
          exitReason = "idle-after-audio";
          break;
        }

        // null = socket closed, Error = TTS failure
        if (next === null || next instanceof Error) {
          // V-02: a socket that dies with text still unspoken must not silently
          // swallow the rest of the sentence. Reconnect and re-send what was
          // never spoken — once. A second failure is a real outage, and looping
          // on it would just stall the turn.
          const unspoken = outstandingSnippets() > 0 ? coverage.unspokenSuffix(spokenSoFar) : "";
          const recoverable =
            unspoken.trim().length > 0 && !this.abortSignal.aborted && reconnectsUsed < 1;

          if (recoverable) {
            reconnectsUsed++;
            logger.warn(
              { unspokenChars: unspoken.length, replyChars: spokenSoFar.length },
              "hume-tts-plugin: socket died mid-reply — reconnecting and re-sending unspoken text",
            );
            try {
              await this.humeSession.ensureConnected();
              // The reconnect resets ownership state, so re-claim before
              // re-sending or the guard would drop our own text.
              const retryToken = this.humeSession.beginTurn();
              this.humeSession.setCallbacks({
                onAudioChunk: (chunk) => activeQueue.put(chunk),
                onError: (err) => activeQueue.put(err),
                onClose: () => activeQueue.put(null),
              });
              this.humeSession.sendText(unspoken, retryToken);
              this.humeSession.flush(retryToken);
              // What is owed now is exactly the re-sent text, as ONE flush on a
              // fresh socket.
              coverage.setExpected(unspoken);
              coverage.resetSpoken();
              audioSinceLastFlush = 0;
              lastChunkSinceFlush = false;
              waitedForFlushAudio = 0;
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

          break;
        }

        receivedAny = true;
        if (next.snippetText !== undefined) coverage.known = true;
        if (flushCount > 0) audioSinceLastFlush++;
        if (next.isLastChunk) {
          sawLastChunk = true;
          if (flushCount > 0) lastChunkSinceFlush = true;
          // A closed snippet means that much of the reply has been spoken.
          coverage.snippetFinished(next.snippetId, next.snippetText);
        }
        if (next.pcm.length > 0) {
          audioSamples += next.pcm.length;
          emit(next, false);
        }
      }
    };

    await Promise.all([feedText(), drainAudio()]);

    // Audio still owed means Hume is STILL generating this reply and nobody is
    // going to read it. Left alone it arrives during the next turn and is
    // played as part of the next reply. Abandon it explicitly.
    const outstanding = this.abortSignal.aborted ? 0 : outstandingSnippets();
    if (outstanding > 0) {
      logger.warn(
        { outstanding, spokenChars: coverage.spokenChars, expectedChars: coverage.expectedChars },
        "hume-tts-plugin: turn ended with audio still generating — abandoning it so it cannot leak into the next reply",
      );
      this.humeSession.abandonTurn(token);
    }

    // One line per reply, so "the voice was not audible" is a fact in the log
    // rather than something to be inferred from a missing metric.
    // framesEmitted === 0 IS the silent-reply symptom.
    logger.info(
      {
        frames: framesEmitted,
        flushes: flushCount,
        chars: spokenSoFar.length,
        unspokenSegments: outstanding,
        aborted: this.abortSignal.aborted,
        // Where the TTS stage's time actually goes:
        //   text_ms  — waiting for the model to finish writing the reply
        //   flush_ms — our own overhead between last token and the flush
        //   hume_ms  — Hume's time to return the first audio frame
        text_ms: tLastText ? tLastText - tStart : null,
        flush_ms: tFlush && tLastText ? tFlush - tLastText : null,
        hume_ms: tFlush && firstFrameAt ? firstFrameAt - tFlush : null,
        // How much speech was produced, and how much of the reply's text Hume
        // reported as spoken. spoken_chars < expected_chars on a finished turn
        // is a reply that lost words.
        audio_ms: Math.round((audioSamples / TTS_OUTPUT_SAMPLE_RATE) * 1000),
        spoken_chars: coverage.spokenChars,
        expected_chars: coverage.expectedChars,
        // "no" here on a completed turn means we ended before Hume said it was
        // finished — which is what a clipped final word looks like.
        saw_last_chunk: sawLastChunk,
        exit: exitReason,
        // "adopted": synthesis started before the moderation verdict, and
        // presynth_lead_ms is how much earlier than this stream it began.
        presynth,
        presynth_lead_ms: adopted ? tStart - adopted.flushedAt : null,
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
    // No hold-back, for the same reason as the streaming path: `final` only
    // drives LiveKit's metrics, so frames are emitted as they arrive.
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
      if (!this.session.isOwner(token)) break;

      const next = await audioQueue.next(snippetEnded ? SEGMENT_IDLE_MS : undefined);

      if (next === IDLE || next === WOKE || next === null || next instanceof Error) break;

      if (next.pcm.length > 0) emit(next, false);
      if (next.isLastChunk) snippetEnded = true;
    }

    // Socket is call-scoped; HumeTTS.closeSession() owns its lifetime.
  }
}
