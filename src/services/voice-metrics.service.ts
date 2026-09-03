import { logger } from "../utils/logger.js";

// ── Voice latency instrumentation ────────────────────────────────────────────
//
// Defect V-03: nothing in the voice path measured itself, so nobody could state
// what P50 was or prove that a change helped. HumeTTSSession.getFirstChunkAt()
// existed and was called by nothing.
//
// This records four wall-clock stamps per turn and emits exactly ONE structured
// log line when the turn's first audio frame goes out:
//
//   t_speech_end      user stopped speaking            (AgentSession user state)
//   t_stt_final       final transcript from Deepgram   (AgentSession event)
//   t_llm_first_token first token out of the pipeline  (CompanionLLMStream)
//   t_tts_first_frame first audio frame from Hume      (hume-tts-plugin)
//
// ttfb_ms — end of their sentence to first sound back — is the number the
// targets are written against: P50 under 800ms, P95 under 1200ms.
//
// Read the lines back with `npm run latency-report`.

/** The one log message the report script greps for. Do not change casually. */
export const VOICE_LATENCY_MSG = "voice-latency";

/**
 * How far back a stamp may sit before speech-end and still be treated as
 * belonging to this turn. Comfortably wider than the endpointing delay and any
 * preemptive head start, far narrower than the gap between two utterances.
 */
const STT_LOOKBACK_MS = 3000;

export class VoiceTurnTimer {
  private turnIndex = 0;
  private speechEndAt = 0;
  private sttFinalAt = 0;
  private llmFirstTokenAt = 0;
  // Audio that arrived before the turn's speech-end (preemptive TTS winning).
  private pendingFrameAt = 0;

  constructor(private readonly roomName: string) {}

  /**
   * The user stopped speaking — the clock the targets are measured from.
   * Starts a new turn, discarding any half-filled one (the user spoke again
   * before we answered, so the previous stamps describe a turn that no longer
   * exists).
   */
  markSpeechEnd(at: number = Date.now()): void {
    this.turnIndex += 1;
    this.speechEndAt = at;
    // llmFirstTokenAt is preserved for the same reason as sttFinalAt below.
    //
    // With preemptive generation — and especially preemptive TTS — the model
    // can produce its first token BEFORE the session declares the turn over.
    // That is the whole point of the feature, and clearing the stamp here threw
    // away the measurement on exactly the turns where it worked: a real call
    // logged ttfb=371ms with llm_ms and tts_ms both null, because the stamp had
    // been wiped between being taken and being reported.
    if (this.llmFirstTokenAt > 0 && at - this.llmFirstTokenAt > STT_LOOKBACK_MS) {
      this.llmFirstTokenAt = 0;
    }

    // Audio already produced for this turn before the caller stopped: report it
    // now, at ttfb 0 — the reply was waiting for them to finish.
    //
    // Only when this turn actually generated something. Without that guard, any
    // audio arriving while no turn was open — the opening greeting, or the tail
    // of an already-reported turn — was credited to the NEXT turn as a 0ms
    // reply, which dragged a whole call's p50 to zero and made the report
    // useless.
    const frameAt = this.pendingFrameAt;
    this.pendingFrameAt = 0;
    if (frameAt > 0 && this.llmFirstTokenAt > 0 && at - frameAt <= STT_LOOKBACK_MS) {
      this.markTtsFirstFrame(Math.max(frameAt, at));
    }
    // sttFinalAt is deliberately NOT cleared here.
    //
    // Deepgram routinely finalises a transcript BEFORE the session declares
    // the user's turn over — endpointing adds its minDelay on top of the
    // silence that triggered it, so the two orderings are both normal.
    // Clearing on speech-end therefore threw away the stamp on exactly the
    // turns where STT was fastest, which is why the first report showed
    // "stt: no samples" while tts had samples.
    //
    // Anything older than this window belongs to a previous utterance.
    if (this.sttFinalAt > 0 && at - this.sttFinalAt > STT_LOOKBACK_MS) {
      this.sttFinalAt = 0;
    }
  }

  markSttFinal(at: number = Date.now()): void {
    // FIRST final of this turn wins, not the latest.
    //
    // "Latest wins" produced an 11966ms stt_ms on a real call: a final belonging
    // to the caller's NEXT utterance overwrote this turn's stamp while the turn
    // was still waiting on audio. The first final at or after speech-end is the
    // one that actually unblocked generation.
    if (this.speechEndAt > 0 && this.sttFinalAt >= this.speechEndAt) return;
    this.sttFinalAt = at;
  }

  markLlmFirstToken(at: number = Date.now()): void {
    if (this.llmFirstTokenAt === 0) this.llmFirstTokenAt = at;
  }

  /**
   * First audio frame of the reply reached the caller. Emits the turn's line
   * and closes the turn, so a multi-segment reply logs once rather than once
   * per sentence.
   */
  markTtsFirstFrame(at: number = Date.now()): void {
    // Audio can genuinely arrive BEFORE speech-end when preemptive TTS wins:
    // the reply was synthesised while the caller was still finishing. Hold the
    // stamp so markSpeechEnd() can report the turn instead of dropping it —
    // a real call logged ttfb=371ms and the fastest turns were the ones going
    // unreported.
    if (this.speechEndAt === 0) {
      this.pendingFrameAt = at;
      return;
    }

    const speechEnd = this.speechEndAt;
    const sttFinal = this.sttFinalAt;
    const llmFirstToken = this.llmFirstTokenAt;

    // Closed first, so a second frame cannot log the same turn twice.
    this.speechEndAt = 0;
    this.sttFinalAt = 0;
    this.llmFirstTokenAt = 0;

    // A stage is null rather than a bogus 0 when its stamp never landed —
    // the report script must not average a missing measurement as zero.
    //
    // stt_ms is NEGATIVE when Deepgram finalised before the endpointing timer
    // expired. That is not an error: it means STT was not on the critical path
    // for this turn, and the endpointing delay was. Reported as measured.
    //
    // llm_ms is NEGATIVE when the model produced its first token before the
    // transcript was final — preemptive generation doing its job. tts_ms can be
    // larger than ttfb_ms for the same reason: the TTS work began before the
    // clock the caller experiences even started.
    const stt_ms = sttFinal > 0 ? sttFinal - speechEnd : null;
    const llm_ms = sttFinal > 0 && llmFirstToken > 0 ? llmFirstToken - sttFinal : null;
    const tts_ms = llmFirstToken > 0 ? at - llmFirstToken : null;

    logger.info(
      {
        roomName: this.roomName,
        turn: this.turnIndex,
        t_speech_end: speechEnd,
        t_stt_final: sttFinal || null,
        t_llm_first_token: llmFirstToken || null,
        t_tts_first_frame: at,
        stt_ms,
        llm_ms,
        tts_ms,
        ttfb_ms: at - speechEnd,
      },
      VOICE_LATENCY_MSG,
    );
  }
}
