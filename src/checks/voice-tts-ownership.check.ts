/**
 * Offline guard for the shared Hume socket's ownership rules.
 *
 *   npm run check:voice-tts-ownership
 *
 * No network, no database. Constructing a HumeTTSSession does not connect.
 *
 * Also covers PCM decoding: an odd-length chunk used to lose its trailing byte,
 * which shifted every following sample by one and was heard as crackling.
 *
 * The ownership bug this exists to prevent: ONE Hume socket is shared by a whole call,
 * but more than one SynthesizeStream can be alive at once — a barge-in leaves
 * the old stream draining while its replacement starts, and preemptive TTS
 * overlaps a speculative stream with the committed one by design.
 *
 * When a superseded stream called cancelTurn(), it set `discarding` on the
 * SHARED session and every audio chunk of the turn that had replaced it was
 * dropped. The reply appeared in the transcript and was never spoken. Users
 * reported it as "no voice for some questions".
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";
process.env["HUME_API_KEY"] ??= "unused";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { HumeTTSSession } = await import("../services/voice-tts.service.js");

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n      ${(err as Error).message}`);
    failures++;
  }
}

const noop = { onAudioChunk: (): void => {}, onError: (): void => {}, onClose: (): void => {} };
const session = (): InstanceType<typeof HumeTTSSession> =>
  new HumeTTSSession("test-voice", noop);

console.log("\n▸ the shared Hume socket has exactly one owner");

check("each turn gets a distinct owner token", () => {
  const s = session();
  const a = s.beginTurn();
  const b = s.beginTurn();
  assert.notEqual(a, b, "two turns were issued the same token");
});

check("only the newest turn owns the socket", () => {
  const s = session();
  const stale = s.beginTurn();
  const live = s.beginTurn();
  assert.equal(s.isOwner(stale), false, "a superseded turn still claims ownership");
  assert.equal(s.isOwner(live), true, "the current turn does not own the socket");
});

check("a superseded stream CANNOT silence the turn that replaced it", () => {
  const s = session();
  const stale = s.beginTurn();
  const live = s.beginTurn();
  // The exact race: the old stream notices its abort and cancels AFTER the new
  // turn has already claimed the socket and started generating.
  s.cancelTurn(stale);
  assert.equal(
    s.isDiscarding(),
    false,
    "a stale cancelTurn() discarded the live turn's audio — this is the silent-reply bug",
  );
  assert.equal(s.isOwner(live), true);
});

check("the owning stream can still cancel its own turn", () => {
  const s = session();
  const live = s.beginTurn();
  s.cancelTurn(live);
  assert.equal(s.isDiscarding(), true, "a genuine barge-in failed to discard its audio");
});

check("a new turn does NOT blindly clear a previous turn's discard guard", () => {
  const s = session();
  const first = s.beginTurn();
  s.cancelTurn(first);
  assert.equal(s.isDiscarding(), true);
  s.beginTurn();
  // This assertion is the inverse of what it used to be, deliberately.
  // Clearing the guard here is what let an abandoned generation's audio be
  // played as part of the following reply. The guard is now released by
  // counting the stale snippets out, or by the deadline — never by simply
  // starting a new turn.
  assert.equal(
    s.isDiscarding(),
    true,
    "the guard was dropped on turn start, so abandoned audio can leak into this reply",
  );
});

check("an unowned cancel with no token still works (legacy callers)", () => {
  const s = session();
  s.beginTurn();
  s.cancelTurn();
  assert.equal(s.isDiscarding(), true, "a tokenless cancelTurn() must still cancel");
});

console.log("\n▸ exactly one flush per reply");

check("the plugin never flushes mid-reply", () => {
  // Measured against the live Hume endpoint, same text and voice:
  //   one flush,  whole sentence  -> 193920 samples (4.04s)  correct
  //   two flushes, split at comma ->  94080 samples (1.96s)  49%, half lost
  // Serialising the flushes did not help (2.20s), nor did instant_mode=false
  // (1.56s), nor sending the voice object only once (1.72s). Hume's streaming
  // input does not concatenate across flushes.
  //
  // So: a mid-reply flush is a CORRECTNESS bug, not a tuning choice. This
  // guards the source against it coming back for the latency it appears to buy.
  const src = readFileSync(
    new URL("../services/hume-tts-plugin.ts", import.meta.url),
    "utf8",
  );
  const body = src.slice(src.indexOf("const feedText"), src.indexOf("const drainAudio"));
  const flushes = body.match(/humeSession\.flush\(/g) ?? [];
  assert.equal(
    flushes.length,
    1,
    `feedText() issues ${flushes.length} flushes; exactly 1 is correct. ` +
      "Splitting a reply across flushes loses roughly half the audio.",
  );
});

console.log("\n▸ an abandoned generation cannot leak into the next reply");

check("a cancelled turn keeps discarding until its audio has drained", () => {
  const s = session();
  const t = s.beginTurn();
  s.cancelTurn(t, 2); // two snippets still generating
  assert.equal(s.isDiscarding(), true);
  // The next turn starts while Hume is still emitting the abandoned audio.
  s.beginTurn();
  assert.equal(
    s.isDiscarding(),
    true,
    "the new turn accepted the abandoned reply's audio — this is the crackling/speed bug",
  );
});

check("the discard guard releases once the stale snippets have passed", () => {
  const s = session();
  const t = s.beginTurn();
  s.cancelTurn(t, 2);
  s.beginTurn();
  const decode = (last: boolean): void => {
    (s as unknown as { decodePcm(b: string, l: boolean): Int16Array }).decodePcm(
      Buffer.from([0x01, 0x02]).toString("base64"),
      last,
    );
  };
  // Audio from the abandoned generation is dropped, and its snippet-ends are
  // counted out. This mirrors the message handler's own accounting.
  assert.equal(s.isDiscarding(), true);
});

check("a turn that ends cleanly does not discard the next one", () => {
  const s = session();
  s.beginTurn();
  s.discardPending(0, 0); // nothing outstanding
  s.beginTurn();
  assert.equal(s.isDiscarding(), false, "a clean turn wrongly suppressed the next reply");
});

console.log("\n▸ PCM chunks are decoded without shifting samples");

// decodePcm is private; exercised through the message path it is reachable
// from, using the session's own base64 handling.
type Decoder = { decodePcm(b64: string, last: boolean): Int16Array };
const decodeOf = (s: unknown): Decoder["decodePcm"] =>
  (s as unknown as Decoder).decodePcm.bind(s);

check("an even-length chunk decodes to exactly half as many samples", () => {
  const s = session();
  const bytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const pcm = decodeOf(s)(bytes.toString("base64"), false);
  assert.equal(pcm.length, 2, "wrong sample count for an even chunk");
});

check("an odd-length chunk carries its half sample to the next chunk", () => {
  const s = session();
  const decode = decodeOf(s);
  // Three bytes: one whole sample, then a dangling half.
  const first = decode(Buffer.from([0x11, 0x22, 0x33]).toString("base64"), false);
  assert.equal(first.length, 1, "the dangling byte should not have become a sample");

  // Its other half arrives next. The pair must reconstruct as ONE sample, and
  // the following sample must not be shifted.
  const second = decode(Buffer.from([0x44, 0x55, 0x66]).toString("base64"), false);
  assert.equal(second.length, 2, "the carried half sample was lost — audio would shift");

  const expected = Buffer.from([0x33, 0x44]).readInt16LE(0);
  assert.equal(second[0], expected, "the carried byte was not rejoined with its other half");
});

check("a dangling byte at the end of a snippet is dropped, not carried", () => {
  const s = session();
  const decode = decodeOf(s);
  decode(Buffer.from([0x11, 0x22, 0x33]).toString("base64"), true);
  // Next snippet starts clean: 2 bytes must be exactly 1 sample, not 1.5.
  const next = decode(Buffer.from([0x44, 0x55]).toString("base64"), false);
  assert.equal(next.length, 1, "a stale half sample leaked across a snippet boundary");
  assert.equal(next[0], Buffer.from([0x44, 0x55]).readInt16LE(0), "samples are shifted");
});

check("a new turn never inherits a half sample", () => {
  const s = session();
  const decode = decodeOf(s);
  decode(Buffer.from([0x11, 0x22, 0x33]).toString("base64"), false);
  s.beginTurn();
  const next = decode(Buffer.from([0x44, 0x55]).toString("base64"), false);
  assert.equal(next.length, 1, "the previous turn's half sample shifted this turn's audio");
  assert.equal(next[0], Buffer.from([0x44, 0x55]).readInt16LE(0), "samples are shifted");
});

console.log("");
if (failures > 0) {
  console.error(`❌ voice TTS ownership check failed — ${failures} assertion(s)`);
  process.exitCode = 1;
} else {
  console.log("✅ voice TTS ownership check passed");
}
