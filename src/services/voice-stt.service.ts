import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface FinalSegmentEvent {
  text: string;
  durationSeconds: number;
}

export interface STTCallbacks {
  /** Fires for every is_final segment. Caller should accumulate, not act. */
  onFinalSegment: (event: FinalSegmentEvent) => void;
  /** Fires once Deepgram thinks the user has finished a thought. THIS is the trigger to call runTurn. */
  onUtteranceEnd: () => void;
  /** Fires on VAD speech-start; used for barge-in detection. */
  onSpeechStarted: () => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

const DG_SAMPLE_RATE = 16000;
const DG_CHANNELS = 1;
const DG_BASE_URL = "wss://api.deepgram.com/v1/listen";

interface DGResults {
  type: "Results";
  is_final?: boolean;
  duration: number;
  channel: { alternatives: Array<{ transcript: string }> };
}
interface DGSpeechStarted {
  type: "SpeechStarted";
}
interface DGUtteranceEnd {
  type: "UtteranceEnd";
}

type DGMessage = DGResults | DGSpeechStarted | DGUtteranceEnd | { type: string };

export class DeepgramSTTSession {
  private socket: WebSocket | null = null;
  private closed = false;

  constructor(private callbacks: STTCallbacks) {}

  async connect(): Promise<void> {
    if (!env.DEEPGRAM_API_KEY) {
      throw new Error("DEEPGRAM_API_KEY not configured");
    }

    const params = new URLSearchParams({
      model: "nova-3",
      language: "en-US",
      encoding: "linear16",
      sample_rate: String(DG_SAMPLE_RATE),
      channels: String(DG_CHANNELS),
      smart_format: "true",
      // Conversational mode: send interim transcripts AND fire UtteranceEnd
      // when the user stops talking. We ignore interims, accumulate is_final
      // segments, and use UtteranceEnd as the "user is done" trigger.
      interim_results: "true",
      utterance_end_ms: "1000",
      punctuate: "true",
      vad_events: "true",
    });

    const url = `${DG_BASE_URL}?${params.toString()}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    });
    this.socket = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.off("error", onError);
        ws.off("unexpected-response", onUnexpected);
        logger.info("Deepgram socket open");
        resolve();
      };
      const onError = (err: Error): void => {
        ws.off("open", onOpen);
        reject(err);
      };
      const onUnexpected = (_req: unknown, res: { statusCode?: number }): void => {
        reject(new Error(`Deepgram HTTP ${res.statusCode ?? "?"}`));
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("unexpected-response", onUnexpected);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      if (this.closed) return;
      let msg: DGMessage;
      try {
        msg = JSON.parse(data.toString()) as DGMessage;
      } catch (err) {
        logger.warn({ err }, "Deepgram message parse failed");
        return;
      }

      switch (msg.type) {
        case "SpeechStarted":
          this.callbacks.onSpeechStarted();
          return;

        case "UtteranceEnd":
          this.callbacks.onUtteranceEnd();
          return;

        case "Results": {
          const r = msg as DGResults;
          if (!r.is_final) return; // ignore interim transcripts
          const alt = r.channel.alternatives[0];
          if (!alt || !alt.transcript.trim()) return;
          this.callbacks.onFinalSegment({
            text: alt.transcript,
            durationSeconds: r.duration,
          });
          return;
        }
      }
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Deepgram socket error");
      this.callbacks.onError(err);
    });

    ws.on("close", () => {
      logger.info("Deepgram socket closed");
      this.callbacks.onClose();
    });
  }

  sendAudio(pcm: ArrayBufferView): void {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(pcm);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "CloseStream" }));
      }
    } catch (err) {
      logger.warn({ err }, "Failed to send CloseStream to Deepgram");
    }
    try {
      const s = this.socket;
      if (s?.readyState === WebSocket.CONNECTING) s.terminate();
      else s?.close();
    } catch (err) {
      logger.warn({ err }, "Failed to close Deepgram socket");
    }
  }
}

export const DEEPGRAM_SAMPLE_RATE = DG_SAMPLE_RATE;
export const DEEPGRAM_CHANNELS = DG_CHANNELS;
