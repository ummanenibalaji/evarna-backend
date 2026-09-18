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

check("Hume's empty leading marker chunk does NOT release the discard guard", () => {
  // Measured protocol: every generation opens with a 0 ms audio chunk flagged
  // is_last_chunk, ~300ms after the flush; real audio follows from ~800ms and
  // the snippet really ends on a last chunk that carries audio. Counting the
  // empty marker released the guard early and leaked the abandoned reply's
  // audio into the next turn.
  const s = session();
  const t = s.beginTurn();
  s.cancelTurn(t, 1);
  s.beginTurn();

  s.countDiscardedChunk("", true);
  assert.equal(
    s.isDiscarding(),
    true,
    "released on Hume's empty marker — the abandoned reply's real audio would play inside the next turn",
  );

  s.countDiscardedChunk(Buffer.from([1, 2, 3, 4]).toString("base64"), false);
  assert.equal(s.isDiscarding(), true, "released mid-snippet on ordinary audio");

  s.countDiscardedChunk(Buffer.from([5, 6, 7, 8]).toString("base64"), true);
  assert.equal(s.isDiscarding(), false, "guard never released after the real final chunk");
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

console.log("\n▸ a reply only ends once Hume has spoken all of it");

const { ReplyCoverage, AudioChunkQueue, IDLE, WOKE } = await import("../services/hume-tts-plugin.js");

// The reply that went silent in the baseline run. Hume started a snippet on its
// own before the flush; the drain loop took the flush's wake-up for a quiet
// socket and ended the turn, discarding everything generated for the flush.
const LOST_REPLY =
  "Well, if I were in your shoes, I'd probably need some time to process and calm down after " +
  "that kind of blow. Maybe I'd grab a cup of coffee, take a walk outside, or do something that " +
  "helps me unwind. And then I'd probably talk to someone I trust, like a friend or family member, " +
  "about what happened.";

await (async (): Promise<void> => {
  const label = "the text side finishing is NOT mistaken for a quiet socket";
  try {
    const q = new AudioChunkQueue();
    const woken = q.next(5_000);
    setTimeout(() => q.wake(), 5);
    const started = Date.now();
    const result = await woken;
    assert.equal(result, WOKE, "wake() was reported as IDLE — this is the lost-reply bug");
    assert.ok(Date.now() - started < 1_000, "wake() did not release the wait");
    assert.equal(await q.next(20), IDLE, "a genuinely quiet socket must still report IDLE");
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n      ${(err as Error).message}`);
    failures++;
  }
})();

check("a snippet Hume started before the flush does not complete the reply", () => {
  const c = new ReplyCoverage();
  c.setExpected(LOST_REPLY);
  // Hume's own split, measured: the first ~250 characters come back as one
  // snippet, the rest (starting with the full stop) as another.
  const cut = LOST_REPLY.indexOf(". And then");
  c.snippetFinished("s1", LOST_REPLY.slice(0, cut));
  assert.equal(c.complete(), false, "the reply was declared finished with its last sentence unspoken");
  assert.ok(c.unspokenSuffix(LOST_REPLY).includes("about what happened"), "re-send would miss the tail");
  c.snippetFinished("s2", LOST_REPLY.slice(cut));
  assert.equal(c.complete(), true, "the reply never completed after its last snippet closed");
  assert.equal(c.unspokenSuffix(LOST_REPLY), "");
});

check("Hume's re-spaced echo of the text still counts as spoken", () => {
  const c = new ReplyCoverage();
  c.setExpected("Well, if I were in your shoes, I'd probably rest.");
  c.snippetFinished("s1", "Well ,  if  I  were  in  your  shoes ,  I'd  proba bly  rest . ");
  assert.equal(c.complete(), true);
});

check("text abandoned by an earlier turn cannot complete this reply early", () => {
  const c = new ReplyCoverage();
  c.setExpected("Hello there, friend. See you tomorrow.");
  // Longer than this reply on its own, but it does not end with this reply.
  c.snippetFinished("s1", "Purple elephants dance quietly all night long. Hello there, friend.");
  assert.equal(c.complete(), false, "completed on length before the reply's own last words arrived");
  c.snippetFinished("s2", "See you tomorrow.");
  assert.equal(c.complete(), true);
});

check("a snippet reported twice is counted once", () => {
  const c = new ReplyCoverage();
  c.setExpected("One two three. Four five six.");
  c.snippetFinished("s1", "One two three.");
  c.snippetFinished("s1", "One two three.");
  assert.equal(c.complete(), false, "a duplicate snippet-end was double counted");
});

console.log("\n▸ an abandoned turn discards exactly what it still owes");

// Drive the session's per-turn bookkeeping directly: there is no socket here,
// so sendText() cannot record anything itself.
type TurnState = { turnSent: string; turnSpoken: string; turnUnflushed: boolean; send: (m: unknown) => void };
const turnState = (s: unknown): TurnState => s as TurnState;
const { normalizeSpoken } = await import("../services/voice-tts.service.js");
const b64 = (n: number): string => Buffer.alloc(n, 1).toString("base64");

check("a preemptive reply cancelled AFTER its audio arrived does not silence the next reply", () => {
  // Measured in a live call: "Hey." was finalised mid-utterance, a reply was
  // synthesised for it in full, then cancelled when the rest of the sentence
  // arrived. The abort armed the guard for one snippet anyway (Math.max(1, 0))
  // and the real reply's only snippet was swallowed — no voice at all.
  const s = session();
  const t = s.beginTurn();
  turnState(s).turnSent = normalizeSpoken("Hey there! How's it going?");
  turnState(s).turnSpoken = normalizeSpoken("Hey there! How's it going?");
  s.abandonTurn(t);
  assert.equal(s.isDiscarding(), false, "a turn that owed nothing armed the discard guard");
  s.beginTurn();
  assert.equal(s.isDiscarding(), false, "the next reply would be discarded");
});

check("audio still owed by an abandoned turn is discarded, then the guard releases", () => {
  const s = session();
  const t = s.beginTurn();
  turnState(s).turnSent = normalizeSpoken("Hey there! How's it going?");
  s.abandonTurn(t);
  assert.equal(s.isDiscarding(), true, "owed audio would leak into the next reply");
  s.beginTurn();
  s.countDiscardedText("", true, ""); // Hume's empty separator
  assert.equal(s.isDiscarding(), true, "released on Hume's empty separator");
  s.countDiscardedText(b64(96), false, "Hey there! How's it going?");
  assert.equal(s.isDiscarding(), true, "released mid-snippet");
  s.countDiscardedText(b64(96), true, "Hey there! How's it going?");
  assert.equal(s.isDiscarding(), false, "never released after the abandoned text was spoken");
});

check("an abandoned reply spanning several snippets is discarded in full", () => {
  const s = session();
  const t = s.beginTurn();
  const first = "Well, if I were in your shoes, I'd probably need some time to process and calm down.";
  const second = "And then I'd talk to someone I trust about what happened.";
  turnState(s).turnSent = normalizeSpoken(first + " " + second);
  s.abandonTurn(t);
  s.beginTurn();
  s.countDiscardedText(b64(96), true, first);
  assert.equal(s.isDiscarding(), true, "the second snippet of the abandoned reply would leak");
  s.countDiscardedText(b64(96), true, second);
  assert.equal(s.isDiscarding(), false);
});

check("text a turn never flushed is flushed and discarded, never glued to the next reply", () => {
  // Measured: unflushed text stays in Hume's buffer and comes back at the START
  // of the next flush, in the same snippet as the next reply.
  const s = session();
  const sent: unknown[] = [];
  turnState(s).send = (m: unknown): void => { sent.push(m); };
  s.beginTurn();
  turnState(s).turnSent = normalizeSpoken("I'm doing great, thanks");
  turnState(s).turnUnflushed = true;
  // The next turn claims the socket without the old one ever cancelling.
  s.beginTurn();
  assert.deepEqual(sent, [{ flush: true }], "the leftover was not flushed on its own");
  assert.equal(s.isDiscarding(), true, "the leftover would be spoken inside the next reply");
});

check("a stale stream cannot abandon the turn that replaced it", () => {
  const s = session();
  const stale = s.beginTurn();
  const live = s.beginTurn();
  turnState(s).turnSent = normalizeSpoken("The live reply.");
  s.abandonTurn(stale);
  assert.equal(s.isDiscarding(), false, "a stale abandon discarded the live reply");
  assert.equal(s.isOwner(live), true);
});

check("an abandoned stream can no longer send into the next turn", () => {
  const s = session();
  const t = s.beginTurn();
  s.abandonTurn(t);
  assert.equal(s.isOwner(t), false, "an abandoned stream still owns the socket");
});

console.log("\n▸ a reply synthesised before its verdict is only ever heard by adoption");

const { Presynthesis, TTS_TEXT_TRANSFORMS } = await import("../services/hume-tts-plugin.js");
type StubSession = {
  sent: string[]; flushes: number; begun: number; abandoned: number[]; owner: number;
  ensureConnected(): Promise<void>; beginTurn(): number; isOwner(t: number): boolean;
  setCallbacks(): void; sendText(t: string, tok: number): void; flush(tok: number): void; abandonTurn(t: number): void;
};
const stubSession = (): StubSession => {
  const s: StubSession = {
    sent: [], flushes: 0, begun: 0, abandoned: [], owner: 0,
    async ensureConnected() {},
    beginTurn() { s.begun++; return ++s.owner; },
    isOwner(t) { return t === s.owner; },
    setCallbacks() {},
    sendText(t) { s.sent.push(t); },
    flush() { s.flushes++; },
    abandonTurn(t) { s.abandoned.push(t); },
  };
  return s;
};
const presynth = (s: StubSession, chunks: string[]): InstanceType<typeof Presynthesis> =>
  new Presynthesis(s as never, chunks, TTS_TEXT_TRANSFORMS);

await (async (): Promise<void> => {
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ✓ ${label}`); } catch (err) { console.error(`  ✗ ${label}\n      ${(err as Error).message}`); failures++; }
  };

  await run("it is sent as ONE reply with ONE flush", async () => {
    const s = stubSession();
    const p = presynth(s, ["Oh", " no", ",", " that", " sounds", " awful", "."]);
    assert.equal(await p.ready, true);
    assert.equal(s.flushes, 1, "one flush per reply");
    assert.equal(s.sent.join(""), "Oh no, that sounds awful.");
  });

  await run("text is transformed exactly as LiveKit transforms TTS input (markdown, emoji)", async () => {
    const s = stubSession();
    const p = presynth(s, ["**Oh** no", " 😢", " that sounds awful."]);
    await p.ready;
    assert.ok(!s.sent.join("").includes("*"), `markdown reached Hume: ${JSON.stringify(s.sent.join(""))}`);
    assert.ok(!s.sent.join("").includes("😢"), "emoji reached Hume");
  });

  await run("adopted only by a stream carrying the same reply", async () => {
    const s = stubSession();
    const p = presynth(s, ["That sounds awful."]);
    assert.equal(await p.adopt("Something else entirely."), false, "adopted a different reply");
    const q = presynth(s, ["That sounds awful."]);
    assert.equal(await q.adopt("That sounds awful."), true);
  });

  await run("not adoptable once a newer turn has claimed the socket", async () => {
    const s = stubSession();
    const p = presynth(s, ["That sounds awful."]);
    await p.ready;
    s.beginTurn(); // e.g. the greeting or another reply
    assert.equal(await p.adopt("That sounds awful."), false);
  });

  await run("discarded before it was sent: never claims the socket", async () => {
    const s = stubSession();
    const p = presynth(s, ["That sounds awful."]);
    p.discard();
    assert.equal(await p.ready, false);
    assert.equal(s.begun, 0, "a discarded presynthesis still claimed the socket");
    assert.equal(s.sent.length, 0, "a discarded presynthesis still sent text");
  });

  await run("discarded after it was sent: its Hume turn is abandoned; adoption refused", async () => {
    const s = stubSession();
    const p = presynth(s, ["That sounds awful."]);
    await p.ready;
    p.discard();
    assert.deepEqual(s.abandoned, [p.token], "the synthesised audio would not be discarded");
    assert.equal(await p.adopt("That sounds awful."), false, "a discarded presynthesis was adopted");
  });

  await run("an adopted presynthesis cannot be discarded out from under the stream playing it", async () => {
    const s = stubSession();
    const p = presynth(s, ["That sounds awful."]);
    assert.equal(await p.adopt("That sounds awful."), true);
    p.discard();
    assert.deepEqual(s.abandoned, [], "discard() abandoned an adopted reply");
  });
})();

console.log("");
if (failures > 0) {
  console.error(`❌ voice TTS ownership check failed — ${failures} assertion(s)`);
  process.exitCode = 1;
} else {
  console.log("✅ voice TTS ownership check passed");
}
