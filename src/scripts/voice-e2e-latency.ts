/**
 * End-to-end voice latency, measured the way a caller experiences it.
 *
 *   npm run voice-e2e -- <dir-of-wav-utterances>
 *
 * Needs the API and the voice worker running, and the server in development
 * mode (it signs in with the dev_code the API returns when no mail provider is
 * configured). Each utterance must be a 48 kHz mono 16-bit WAV — for example:
 *
 *   say -o u1.aiff "I had a long day" && afconvert -f WAVE -d LEI16@48000 -c 1 u1.aiff u1.wav
 *
 * What it does: signs in a throwaway user, creates a companion, starts a real
 * LiveKit voice session, joins the room as the caller and SPEAKS each utterance
 * in real time — followed by silence, exactly as a microphone would. It then
 * times the gap between the last spoken frame leaving and the first audible
 * frame of the companion's reply arriving.
 *
 * Why this exists alongside latency-report: that script reads the worker's own
 * stamps, which start at the worker's speech-end and stop at the first frame
 * the worker EMITS. This one stands where the phone stands, so it also counts
 * the network both ways and the playout buffer — the number users actually feel.
 * The worker still logs its per-stage breakdown for these same turns, so running
 * both shows where the total goes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

const BASE = process.env["E2E_BASE_URL"] ?? "http://localhost:3000/api/v1";
const SAMPLE_RATE = 48000;
const FRAME_MS = 10;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

/** Int16 RMS above which a frame from the companion counts as speech. */
const SPEECH_RMS = 500;
/** The companion is considered finished once it has been quiet this long. */
const REPLY_DONE_QUIET_MS = 1500;
/** Give up on a reply that has not started within this window. */
const REPLY_START_TIMEOUT_MS = 20_000;

const MAYA = "c050bc97-0e14-44ba-8c23-ae353fee972d";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data as T;
}

// ── Audio ────────────────────────────────────────────────────────────────────

/** Samples from a 16-bit PCM WAV, walking the chunks rather than assuming a 44-byte header. */
function readWav(path: string): Int16Array {
  const buf = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const channels = buf.readUInt16LE(offset + 10);
      const rate = buf.readUInt32LE(offset + 12);
      const bits = buf.readUInt16LE(offset + 22);
      if (channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) {
        throw new Error(`${path}: need 48 kHz mono 16-bit, got ${rate} Hz ${channels} ch ${bits}-bit`);
      }
    }
    if (id === "data") {
      const samples = new Int16Array(Math.floor(size / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(offset + 8 + i * 2);
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

function toFrames(samples: Int16Array): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let i = 0; i < samples.length; i += SAMPLES_PER_FRAME) {
    const frame = new Int16Array(SAMPLES_PER_FRAME);
    frame.set(samples.subarray(i, Math.min(i + SAMPLES_PER_FRAME, samples.length)));
    frames.push(frame);
  }
  return frames;
}

function rms(data: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / data.length);
}

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: npm run voice-e2e -- <dir-of-48k-mono-wav-files>");
  const files = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
  if (files.length === 0) throw new Error(`no .wav files in ${dir}`);

  // 1. A throwaway caller with a companion.
  const email = `e2e-latency-${Date.now()}@evarna.test`;
  const requested = await api<{ dev_code?: string }>("POST", "/auth/email/request", null, { email });
  if (!requested.dev_code) {
    throw new Error("no dev_code returned — this harness needs a server with no mail provider configured");
  }
  const auth = await api<{ token: string; user_id: string }>("POST", "/auth/email/verify", null, {
    email,
    code: requested.dev_code,
  });
  // Onboard the way the app does: /characters/create refuses accounts that have
  // not finished onboarding, and onboarding creates the first companion.
  const onboarded = await api<{ character_id?: string }>(
    "POST", "/users/onboard", auth.token,
    {
      display_name: "Latency Probe",
      gender: "undisclosed",
      date_of_birth: "1995-06-15",
      communication_style: "warm",
      intent: "emotional support",
      companion: { archetype: "bestfriend", gender: "female", voice_id: MAYA, name: "Maya" },
    },
  );
  const characterId = onboarded.character_id;
  if (!characterId) throw new Error(`onboarding returned no character id: ${JSON.stringify(onboarded)}`);

  const call = await api<{ session_id: string; livekit_token: string; livekit_url: string }>(
    "POST", "/voice/sessions/start", auth.token, { character_id: characterId },
  );
  console.log(`\n  session ${call.session_id} — grep the worker log for this roomName\n`);

  // 2. Join the room as the caller.
  const room = new Room();
  const onsets: number[] = [];
  let lastLoudAt = 0;
  let wasLoud = false;

  const agentAudio = new Promise<void>((resolve) => {
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const stream = new AudioStream(track, SAMPLE_RATE, 1);
      void (async () => {
        for await (const frame of stream) {
          const loud = rms(frame.data) > SPEECH_RMS;
          const now = Date.now();
          if (loud) {
            if (!wasLoud) onsets.push(now);
            lastLoudAt = now;
          }
          wasLoud = loud;
        }
      })();
      resolve();
    });
  });

  await room.connect(call.livekit_url, call.livekit_token, { autoSubscribe: true, dynacast: false });

  // A short queue keeps "frame captured" close to "frame sent", so the end-of-
  // speech stamp is not flattered by a second of local buffering.
  const source = new AudioSource(SAMPLE_RATE, 1, 50);
  const mic = LocalAudioTrack.createAudioTrack("caller-mic", source);
  await room.localParticipant!.publishTrack(
    mic,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );

  // 3. A microphone never stops sending: speech when there is some, silence otherwise.
  const pending: Int16Array[] = [];
  let lastSpeechFrameAt = 0;
  // Held in an object rather than a bare `let`: the resolver is assigned inside
  // a Promise executor, which TypeScript's control flow cannot see, so a plain
  // variable narrows to `never` at the call site.
  const spokenWaiter: { resolve: (() => void) | null } = { resolve: null };
  let running = true;
  const silence = new Int16Array(SAMPLES_PER_FRAME);

  const pump = (async () => {
    let next = performance.now();
    while (running) {
      const speech = pending.shift();
      await source.captureFrame(new AudioFrame(speech ?? silence, SAMPLE_RATE, 1, SAMPLES_PER_FRAME));
      if (speech && pending.length === 0) {
        lastSpeechFrameAt = Date.now();
        spokenWaiter.resolve?.();
        spokenWaiter.resolve = null;
      }
      next += FRAME_MS;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
  })();

  const waitQuiet = async (quietMs: number, capMs: number): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      if (lastLoudAt > 0 && Date.now() - lastLoudAt >= quietMs) return;
      await sleep(50);
    }
  };

  await Promise.race([agentAudio, sleep(20_000)]);
  // Let the opening greeting play out before speaking, or the first turn is a barge-in.
  const greetingDeadline = Date.now() + 15_000;
  while (onsets.length === 0 && Date.now() < greetingDeadline) await sleep(50);
  await waitQuiet(REPLY_DONE_QUIET_MS, 20_000);

  // 4. The turns.
  const results: { file: string; ttfb: number | null; replyMs: number; spokeOver: number }[] = [];
  for (const file of files) {
    const frames = toFrames(readWav(join(dir, file)));
    const spoken = new Promise<void>((resolve) => { spokenWaiter.resolve = resolve; });
    const speechStart = Date.now();
    pending.push(...frames);
    await spoken;
    const speechEnd = lastSpeechFrameAt;
    // Companion audio that STARTED while the caller was still mid-utterance.
    // Non-zero on a sentence with a pause in it means the companion took the
    // pause for the end of the turn and answered half a sentence.
    const spokeOver = onsets.filter((t) => t > speechStart && t <= speechEnd).length;
    const overNote = spokeOver > 0 ? `   ⚠ companion spoke over the caller ${spokeOver}x` : "";

    const deadline = speechEnd + REPLY_START_TIMEOUT_MS;
    let replyStart: number | undefined;
    while (Date.now() < deadline) {
      replyStart = onsets.find((t) => t > speechEnd);
      if (replyStart) break;
      await sleep(10);
    }

    if (!replyStart) {
      console.log(`  ${file.padEnd(8)} NO REPLY within ${REPLY_START_TIMEOUT_MS / 1000}s${overNote}`);
      results.push({ file, ttfb: null, replyMs: 0, spokeOver });
      continue;
    }
    await waitQuiet(REPLY_DONE_QUIET_MS, 40_000);
    const ttfb = replyStart - speechEnd;
    const replyMs = Math.max(0, lastLoudAt - replyStart);
    console.log(`  ${file.padEnd(8)} first sound back ${String(ttfb).padStart(5)} ms   reply ${(replyMs / 1000).toFixed(1)} s${overNote}`);
    results.push({ file, ttfb, replyMs, spokeOver });
  }

  // 5. Summary, then tidy up.
  const ttfbs = results.map((r) => r.ttfb).filter((t): t is number => t !== null).sort((a, b) => a - b);
  console.log("");
  if (ttfbs.length > 0) {
    const mean = Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length);
    console.log(
      `  caller-measured: n=${ttfbs.length}  p50=${percentile(ttfbs, 50)}ms  ` +
      `p95=${percentile(ttfbs, 95)}ms  mean=${mean}ms  min=${ttfbs[0]}ms  max=${ttfbs[ttfbs.length - 1]}ms`,
    );
  }
  const missed = results.filter((r) => r.ttfb === null).length;
  if (missed > 0) console.log(`  ${missed} turn(s) got no audible reply`);
  const overlapped = results.filter((r) => r.spokeOver > 0).length;
  console.log(`  companion spoke over the caller on ${overlapped} of ${results.length} utterance(s)`);
  console.log("");

  running = false;
  await pump;
  await api("POST", `/sessions/${call.session_id}/end`, auth.token, {}).catch(() => {});
  await room.disconnect();
  process.exit(missed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
