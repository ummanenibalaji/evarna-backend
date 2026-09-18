/**
 * Two guards on creating and deleting characters, asserted through the real
 * routes (buildApp + inject, real session tokens, no stubs).
 *
 *   npm run check:character-guards
 *
 * ⚠️  Talks to the real MONGODB_URI from .env. Creates users with addresses
 * ending in @evarna.test, plus their characters, a session and a turn, and
 * deletes all of it on the way out. Redis is optional: the only Redis call on
 * these paths is a best-effort cache invalidation.
 *
 *   1. POST /characters/create refuses an account that has not finished
 *      onboarding. Sign-in creates the account before the date of birth is
 *      asked, so without this a client could skip POST /users/onboard — and the
 *      under-15 floor with it — and still get a companion.
 *   2. DELETE /studio/characters/:id deletes only the caller's own studio
 *      characters, and soft-deletes them like DELETE /characters/:id does:
 *      sessions and transcript stay, because sessions are the voice-minute
 *      ledger and deleting them would hand the minutes back.
 */
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../config/database.js";
import { disconnectRedis } from "../config/redis.js";
import { buildApp } from "../app.js";
import { User } from "../models/user.model.js";
import { Character } from "../models/character.model.js";
import { Session } from "../models/session.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { Memory } from "../models/memory.model.js";
import { MemorySummary } from "../models/memory-summary.model.js";
import { findOrCreateUser, issueSessionToken } from "../services/auth.service.js";

// Real ids from src/data/voices.ts — an unknown voice is a 400 by design.
const VOICE_FEMALE = "c050bc97-0e14-44ba-8c23-ae353fee972d";
const VOICE_MALE = "944adf80-0d6e-4909-b6fa-078784d6f8c5";

const stamp = Date.now();
const ownerEmail = `guards-check-owner-${stamp}@evarna.test`;
const strangerEmail = `guards-check-stranger-${stamp}@evarna.test`;

const NOT_ONBOARDED_BODY = {
  success: false,
  error: "Finish setting up your account first.",
  code: "NOT_ONBOARDED",
};

const COMPANION = { archetype: "bestfriend", gender: "female", voice_id: VOICE_FEMALE, name: "Maya" };

const yearsAgo = (n: number): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};

const onboardBody = (dob: string) => ({
  display_name: "[guards-check]",
  gender: "nonbinary",
  date_of_birth: dob,
  communication_style: "calm",
  intent: "character guards check",
  companion: { name: "Iris", archetype: "mentor", gender: "female", voice_id: VOICE_FEMALE },
});

let failures = 0;
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n      ${(err as Error).message.split("\n")[0]}`);
    failures++;
  }
}

async function main(): Promise<void> {
  await connectDatabase();
  const app = await buildApp();
  await app.ready();
  const userIds: string[] = [];

  type Method = "GET" | "POST" | "DELETE";
  const call = async (method: Method, url: string, token: string | null, payload?: unknown) => {
    const res = await app.inject({
      method,
      url: `/api/v1${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as Record<string, unknown> | undefined,
    });
    return { status: res.statusCode, json: res.json() as Record<string, unknown> & { data?: Record<string, unknown> } };
  };
  const tokenFor = async (email: string): Promise<{ id: string; token: string }> => {
    const u = await findOrCreateUser("email", { sub: email, email, email_verified: true });
    const id = u._id.toString();
    userIds.push(id);
    return { id, token: await issueSessionToken(id, u.token_version) };
  };

  try {
    const owner = await tokenFor(ownerEmail);
    const stranger = await tokenFor(strangerEmail);
    const companionsOf = (id: string) => Character.countDocuments({ user_id: id, mode: "companion" });

    // ── 1. companion creation waits for onboarding ─────────────────────────
    console.log("\n▸ POST /characters/create requires a finished onboarding");

    await check("a signed-in account that never onboarded is refused with 409 NOT_ONBOARDED", async () => {
      const res = await call("POST", "/characters/create", owner.token, COMPANION);
      assert.equal(res.status, 409, `got ${res.status}: ${JSON.stringify(res.json)}`);
      assert.deepEqual(res.json, NOT_ONBOARDED_BODY);
      assert.equal(await companionsOf(owner.id), 0, "a companion row was written anyway");
    });

    await check("a malformed body is still a 400 VALIDATION_ERROR", async () => {
      const res = await call("POST", "/characters/create", owner.token, { archetype: "mentor" });
      assert.equal(res.status, 400, `got ${res.status}`);
      assert.equal(res.json.code, "VALIDATION_ERROR");
    });

    await check("an under-15 onboarding is refused and leaves the gate shut", async () => {
      const young = await call("POST", "/users/onboard", owner.token, onboardBody(yearsAgo(14)));
      assert.equal(young.status, 403, `got ${young.status}`);
      assert.equal(young.json.code, "UNDER_MINIMUM_AGE");
      const res = await call("POST", "/characters/create", owner.token, COMPANION);
      assert.equal(res.status, 409, `a refused minor could still create a companion (${res.status})`);
      assert.equal(await companionsOf(owner.id), 0);
    });

    let onboardCompanionId = "";
    await check("POST /users/onboard itself is unaffected", async () => {
      const res = await call("POST", "/users/onboard", owner.token, onboardBody("1995-01-01"));
      assert.equal(res.status, 201, `got ${res.status}: ${JSON.stringify(res.json)}`);
      onboardCompanionId = String(res.json.data?.["character_id"] ?? "");
      assert.ok(Types.ObjectId.isValid(onboardCompanionId), "onboard returned no character_id");
    });

    await check("once onboarded, the same request creates the companion", async () => {
      const res = await call("POST", "/characters/create", owner.token, COMPANION);
      assert.equal(res.status, 201, `got ${res.status}: ${JSON.stringify(res.json)}`);
      assert.equal(await companionsOf(owner.id), 2);
    });

    // ── 2. studio delete ───────────────────────────────────────────────────
    console.log("\n▸ DELETE /studio/characters/:id");

    const created = await call("POST", "/studio/characters", owner.token, {
      kind: "custom",
      name: "Marcus",
      backstory: "A retired sea captain.",
      voice_id: VOICE_MALE,
      gender: "male",
    });
    assert.equal(created.status, 201, `studio create failed: ${JSON.stringify(created.json)}`);
    const studioId = String(created.json.data?.["character_id"]);
    const studioObjId = new Types.ObjectId(studioId);

    // History attached to the character, to prove a delete keeps it.
    const session = await Session.create({
      user_id: owner.id,
      character_id: studioObjId,
      mode: "studio",
      session_type: "voice_call",
      status: "completed",
      started_at: new Date(Date.now() - 120_000),
      ended_at: new Date(),
      duration_seconds: 120,
      voice_minutes_consumed: 2,
    });
    await ConversationTurn.create({
      session_id: session._id,
      character_id: studioObjId,
      user_id: owner.id,
      role: "user",
      content_text: "[guards-check] hello",
    });

    const isActive = async (id: string) =>
      (await Character.findById(id).select("is_active").lean())?.is_active;

    await check("unauthenticated → 401", async () => {
      const res = await call("DELETE", `/studio/characters/${studioId}`, null);
      assert.equal(res.status, 401);
    });

    await check("another user's studio character → 404, and it stays", async () => {
      const res = await call("DELETE", `/studio/characters/${studioId}`, stranger.token);
      assert.equal(res.status, 404, `got ${res.status}`);
      assert.equal(await isActive(studioId), true, "a stranger deactivated someone else's character");
    });

    await check("ids that are not ObjectIds → 404, never a 500", async () => {
      for (const bad of ["not-an-id", "abcdefghijkl", "0".repeat(25)]) {
        const res = await call("DELETE", `/studio/characters/${bad}`, owner.token);
        assert.equal(res.status, 404, `"${bad}" → ${res.status}`);
      }
    });

    await check("an id that does not exist → 404", async () => {
      const res = await call("DELETE", `/studio/characters/${new Types.ObjectId().toString()}`, owner.token);
      assert.equal(res.status, 404);
    });

    await check("the caller's own COMPANION → 404, and it stays", async () => {
      const res = await call("DELETE", `/studio/characters/${onboardCompanionId}`, owner.token);
      assert.equal(res.status, 404, `got ${res.status}`);
      assert.equal(await isActive(onboardCompanionId), true, "the studio route deleted a companion");
    });

    await check("the owner's studio character → 200 { success: true }", async () => {
      const res = await call("DELETE", `/studio/characters/${studioId}`, owner.token);
      assert.equal(res.status, 200, `got ${res.status}: ${JSON.stringify(res.json)}`);
      assert.deepEqual(res.json, { success: true });
    });

    await check("it is deactivated and gone from GET /studio/characters", async () => {
      assert.equal(await isActive(studioId), false);
      const list = await call("GET", "/studio/characters", owner.token);
      const ids = ((list.json.data?.["characters"] ?? []) as Array<{ _id: string }>).map((c) => c._id);
      assert.ok(!ids.includes(studioId), "a deleted character is still listed");
    });

    await check("its session and transcript are kept (the minutes ledger)", async () => {
      assert.equal(await Session.countDocuments({ character_id: studioObjId }), 1);
      assert.equal(await ConversationTurn.countDocuments({ character_id: studioObjId }), 1);
    });

    await check("deleting it again → 404", async () => {
      const res = await call("DELETE", `/studio/characters/${studioId}`, owner.token);
      assert.equal(res.status, 404);
    });
  } finally {
    const filter = { user_id: { $in: userIds } };
    await Promise.all([
      ConversationTurn.deleteMany(filter),
      Memory.deleteMany(filter),
      MemorySummary.deleteMany(filter),
      Session.deleteMany(filter),
      Character.deleteMany(filter),
    ]);
    await User.deleteMany({ _id: { $in: userIds } });
    await User.deleteMany({ email: { $in: [ownerEmail, strangerEmail] } });
    const left = await Character.countDocuments(filter) + await User.countDocuments({ _id: { $in: userIds } });
    console.log(`\n  cleanup: ${left === 0 ? "nothing left behind" : `${left} row(s) LEFT BEHIND`}`);
    await app.close();
    await mongoose.disconnect();
    await Promise.race([disconnectRedis().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ character guards check failed — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("✅ character guards check passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
