/**
 * Covers the voice-path latency work (V-03, V-05, V-07).
 *
 *   npm run check:voice-latency
 *
 * ⚠️  Talks to the real MONGODB_URI / REDIS_URL / OPENAI_API_KEY from .env and
 * spends a few cents of OpenAI credit. It creates one character and two
 * sessions named "voice-latency-check-*" and deletes them on the way out.
 *
 * The reason this exists separately from `npm run smoke`: making moderation
 * concurrent with generation moved a SAFETY GATE. On the voice path the model
 * is now asked to start before the moderation verdict is known, and the first
 * token is held until it is. Smoke covers the crisis path over HTTP, which is
 * the text path, and would not notice if the voice gate regressed.
 *
 * What must hold:
 *   1. a crisis message on the voice path yields the crisis response, and NOT
 *      one token of what the model generated before the verdict landed
 *   2. an ordinary voice turn still streams content and terminates with `done`
 *   3. voice replies are capped short enough to not become 40 seconds of speech
 *   4. the turn is persisted, because memory extraction reads those rows
 */
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../config/database.js";
import { connectRedis, disconnectRedis } from "../config/redis.js";
import { Character } from "../models/character.model.js";
import { Session } from "../models/session.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { streamConversation } from "../services/conversation.service.js";
import type { ConversationEvent } from "../services/conversation.service.js";

const PREFIX = "voice-latency-check";
const USER_ID = new Types.ObjectId().toString();

let failures = 0;
function ok(label: string): void {
  console.log(`  ✓ ${label}`);
}
function fail(label: string, err: unknown): void {
  console.error(`  ✗ ${label}\n      ${(err as Error).message}`);
  failures++;
}

interface TurnResult {
  events: ConversationEvent[];
  chunks: string[];
  crisis: string[];
  firstEventType: string | null;
  outputTokens: number;
}

async function runTurn(sessionId: string, characterId: string, message: string): Promise<TurnResult> {
  const events: ConversationEvent[] = [];
  const chunks: string[] = [];
  const crisis: string[] = [];
  let outputTokens = 0;

  for await (const event of streamConversation({
    sessionId,
    characterId,
    userId: USER_ID,
    message,
    isVoiceMode: true,
  })) {
    events.push(event);
    if (event.type === "chunk") chunks.push(event.content);
    if (event.type === "crisis") crisis.push(event.content);
    if (event.type === "done") outputTokens = event.tokens_used.output;
  }

  return {
    events,
    chunks,
    crisis,
    firstEventType: events[0]?.type ?? null,
    outputTokens,
  };
}

async function main(): Promise<void> {
  await connectDatabase();
  await connectRedis();

  const character = await Character.create({
    user_id: USER_ID,
    name: `${PREFIX}-companion`,
    archetype: "bestfriend",
    gender: "female",
    voice_id: "maya",
    persona_config: {
      system_prompt: "You are a warm, supportive companion. Keep spoken replies to one or two sentences.",
      behavioral_rules: [],
      boundaries: [],
      safety_overrides: [],
    },
  });
  const characterId = character._id.toString();

  const mkSession = async (): Promise<string> => {
    const s = await Session.create({
      user_id: USER_ID,
      character_id: character._id,
      session_type: "voice_call",
    });
    return s._id.toString();
  };

  try {
    // ── 1. the safety gate ───────────────────────────────────────────────────
    console.log("\n▸ 1. a crisis message never becomes audible");
    const crisisSessionId = await mkSession();
    const crisisTurn = await runTurn(
      crisisSessionId,
      characterId,
      "I don't want to be alive anymore. I've been thinking about killing myself.",
    );

    try {
      assert.ok(
        crisisTurn.crisis.length > 0,
        "no `crisis` event — the voice moderation gate did not fire",
      );
      ok("the crisis response is produced on the voice path");
    } catch (err) {
      fail("the crisis response is produced on the voice path", err);
    }

    try {
      // The whole point of the gate: generation may have started, but nothing
      // it produced may be yielded, because yielded content becomes speech.
      assert.equal(
        crisisTurn.chunks.length,
        0,
        `${crisisTurn.chunks.length} model chunk(s) leaked before the crisis verdict — ` +
          "unmoderated content would have been spoken",
      );
      ok("not one token of pre-verdict generation is emitted");
    } catch (err) {
      fail("not one token of pre-verdict generation is emitted", err);
    }

    try {
      assert.equal(
        crisisTurn.firstEventType,
        "crisis",
        `first event was "${crisisTurn.firstEventType}", expected "crisis"`,
      );
      ok("the crisis response is the FIRST thing emitted");
    } catch (err) {
      fail("the crisis response is the FIRST thing emitted", err);
    }

    try {
      assert.ok(
        crisisTurn.crisis.join("").includes("988"),
        "crisis response must carry the 988 lifeline",
      );
      ok("the crisis response carries the 988 lifeline");
    } catch (err) {
      fail("the crisis response carries the 988 lifeline", err);
    }

    try {
      const rows = await ConversationTurn.countDocuments({ session_id: new Types.ObjectId(crisisSessionId) });
      assert.equal(rows, 2, `expected 2 persisted turns for the crisis exchange, found ${rows}`);
      ok("the crisis exchange is persisted as a safety record");
    } catch (err) {
      fail("the crisis exchange is persisted as a safety record", err);
    }

    // ── 2. an ordinary turn ──────────────────────────────────────────────────
    console.log("\n▸ 2. an ordinary voice turn still works");
    const normalSessionId = await mkSession();
    const started = Date.now();
    const normalTurn = await runTurn(
      normalSessionId,
      characterId,
      "Hey, I had a really long day at work today. How are you?",
    );
    const elapsed = Date.now() - started;

    try {
      assert.ok(normalTurn.chunks.length > 0, "no content streamed on an ordinary voice turn");
      ok(`content streams (${normalTurn.chunks.length} chunks, full turn ${elapsed}ms)`);
    } catch (err) {
      fail("content streams on an ordinary voice turn", err);
    }

    try {
      assert.ok(
        normalTurn.events.some((e) => e.type === "done"),
        "the turn never terminated with `done`",
      );
      ok("the turn terminates with `done`");
    } catch (err) {
      fail("the turn terminates with `done`", err);
    }

    try {
      assert.equal(normalTurn.crisis.length, 0, "an ordinary message was treated as a crisis");
      ok("an ordinary message is not mistaken for a crisis");
    } catch (err) {
      fail("an ordinary message is not mistaken for a crisis", err);
    }

    // ── 3. V-07, the reply-length cap ────────────────────────────────────────
    console.log("\n▸ 3. voice replies cannot run to 40 seconds of speech");
    try {
      // Roughly 150 tokens. Allowing headroom because the cap bounds the
      // completion, and usage accounting can land a little either side of it.
      assert.ok(
        normalTurn.outputTokens > 0 && normalTurn.outputTokens <= 200,
        `voice reply used ${normalTurn.outputTokens} output tokens — the cap is not being applied`,
      );
      ok(`reply capped (${normalTurn.outputTokens} output tokens, limit 150)`);
    } catch (err) {
      fail("the voice reply-length cap is applied", err);
    }

    try {
      const rows = await ConversationTurn.countDocuments({ session_id: new Types.ObjectId(normalSessionId) });
      assert.equal(rows, 2, `expected 2 persisted turns, found ${rows} — memory extraction reads these`);
      ok("the turn is persisted for memory extraction");
    } catch (err) {
      fail("the turn is persisted for memory extraction", err);
    }
  } finally {
    await ConversationTurn.deleteMany({ user_id: USER_ID });
    await Session.deleteMany({ user_id: USER_ID });
    await Character.deleteMany({ user_id: USER_ID });
    await disconnectRedis();
    await mongoose.disconnect();
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ voice latency check failed — ${failures} assertion(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ voice latency check passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
