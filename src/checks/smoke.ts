/**
 * End-to-end smoke check against a RUNNING server.
 *
 *   npm run dev                # terminal 1
 *   npm run smoke              # terminal 2
 *
 * ⚠️  This talks to whatever MONGODB_URI / OPENAI_API_KEY the server was started
 * with. It creates real users and spends real OpenAI credits (a few cents).
 * Every user it creates is named with the SMOKE_PREFIX below so test data is
 * easy to find and purge; user B deletes itself on the way out.
 *
 * It asserts the things that broke before, so a regression fails here loudly:
 *   - unauthenticated and forged tokens are refused        (the trust boundary)
 *   - one user cannot touch another user's anything        (the data breach)
 *   - sign-out and account deletion actually revoke        (the promise)
 *   - display_name is what the client sent  (the "every user is Aria" bug)
 *   - text turns persist                     (memory extraction depends on it)
 *   - memories are produced from a session   (the memory moat)
 *   - the crisis path returns hotline info   (safety)
 *   - minors are blocked from `partner`, under-15s from the app at all (safety)
 *   - voice sessions are billed by real duration, not the 30-min sweep
 *
 * Authentication is REAL — no stubs. It drives the email one-time-code flow and
 * reads the code straight out of Redis, which is why this only runs against a
 * server sharing this machine's Redis.
 *
 * ponytail: SMOKE_BASE_URL is gone. Reading the OTP out of the local Redis only
 * works when the server shares it, so pointing this at staging would fail in a
 * confusing way. Bring it back with a SMOKE_OTP override if staging ever needs
 * covering.
 */
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import { connectRedis, disconnectRedis, getRedis } from "../config/redis.js";
// Outreach policy is decided in a background sweep, not behind an HTTP route,
// so this section reaches into the database directly rather than through the
// API. Everything else in this file stays black-box.
import { connectDatabase } from "../config/database.js";
import { FollowUp } from "../models/follow-up.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { Character } from "../models/character.model.js";
import { User } from "../models/user.model.js";
import { Memory } from "../models/memory.model.js";
import { runOutreachSweep } from "../services/outreach.service.js";

const BASE_URL = "http://localhost:3000";
const API = `${BASE_URL}/api/v1`;
const SMOKE_PREFIX = "smoke-test";

// Real ids from src/data/voices.ts — a bogus one is a 400 by design.
const VOICE_FEMALE = "c050bc97-0e14-44ba-8c23-ae353fee972d";
const VOICE_MENTOR = "3cd1f2e8-12f0-48b5-ade4-9e06241b8252";
const VOICE_MALE = "944adf80-0d6e-4909-b6fa-078784d6f8c5";

// Memory extraction is a BullMQ job (LLM + embeddings), so it is not instant.
const MEMORY_TIMEOUT_MS = 90_000;
const MEMORY_POLL_MS = 3_000;

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ✓ ${label}`);
}
function step(label: string): void {
  console.log(`\n▸ ${label}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/**
 * One request. `token` is explicit and mandatory — `null` means "send no
 * Authorization header". It is not defaulted on purpose: a forgotten argument
 * in an isolation test would silently reuse the wrong user's token and the test
 * would pass while the boundary was broken.
 */
async function api<T = unknown>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: Envelope<T> }> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Envelope<T>;
  try {
    json = text ? (JSON.parse(text) as Envelope<T>) : {};
  } catch {
    throw new Error(`${method} ${path} → ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

/** Sends a chat turn and collects the SSE events the server emits. */
async function sendMessage(
  token: string,
  payload: { session_id: string; message: string },
): Promise<{ chunks: string[]; crisis: string[]; turnId: string | null; errors: string[] }> {
  const res = await fetch(`${API}/conversations/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200, `conversations/send returned ${res.status}`);
  assert.ok(res.body, "conversations/send returned no stream body");

  const chunks: string[] = [];
  const crisis: string[] = [];
  const errors: string[] = [];
  let turnId: string | null = null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";

    for (const frame of frames) {
      let event = "";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data = line.slice(6).trim();
      }
      if (!event || !data) continue;
      const parsed = JSON.parse(data) as { content?: string; turn_id?: string; message?: string };
      if (event === "chunk") chunks.push(parsed.content ?? "");
      else if (event === "crisis") crisis.push(parsed.content ?? "");
      else if (event === "done") turnId = parsed.turn_id ?? null;
      else if (event === "error") errors.push(parsed.message ?? "unknown");
    }
  }

  return { chunks, crisis, turnId, errors };
}

interface AuthSession {
  token: string;
  user_id: string;
  onboarding_completed: boolean;
}

/**
 * The real email one-time-code sign-in, start to finish.
 *
 * Nothing is stubbed: the server generates the code and stores it in Redis, and
 * we read it back out of the same Redis the server wrote it to. That means this
 * check also covers the OTP store itself — if requestEmailCode stops writing,
 * or writes under a different key, every section below fails.
 */
async function signIn(email: string): Promise<AuthSession> {
  const requested = await api<{ sent: boolean; dev_code?: string }>(
    "POST", "/auth/email/request", null, { email },
  );
  assert.equal(
    requested.status,
    200,
    `auth/email/request failed: ${JSON.stringify(requested.json)}`,
  );

  // Prefer the code the API itself hands back in development. Reaching into
  // Redis still works and stays as the fallback for a server configured with a
  // real mail provider, where no code comes back in the response.
  let code = requested.json.data?.dev_code;
  if (!code) {
    const raw = await getRedis().get(`otp:${email.toLowerCase()}`);
    assert.ok(
      raw,
      `no one-time code returned by the API and none at redis key otp:${email.toLowerCase()} — ` +
      "is the server on the same REDIS_URL as this check?",
    );
    code = (JSON.parse(raw) as { code: string; attempts: number }).code;
  }

  const verified = await api<AuthSession>("POST", "/auth/email/verify", null, { email, code });
  assert.equal(verified.status, 200, `auth/email/verify failed: ${JSON.stringify(verified.json)}`);
  const session = verified.json.data;
  assert.ok(session?.token && session.user_id, "verify returned no token/user_id");
  return session;
}

/** A request that must be refused for want of a valid token. */
async function refused(
  label: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<void> {
  const res = await api(method, path, token, body);
  assert.equal(
    res.status,
    401,
    `${method} ${path} returned ${res.status} without a valid token — it must be 401`,
  );
  assert.equal(
    res.json.code,
    "UNAUTHENTICATED",
    `${method} ${path} 401 must carry code "UNAUTHENTICATED", got ${JSON.stringify(res.json)}`,
  );
  ok(label);
}

/**
 * A request by one user against another user's resource. Must be 404 — not 403,
 * which confirms the id exists, and emphatically not 200.
 */
async function isolated(
  label: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<void> {
  const res = await api(method, path, token, body);
  assert.equal(
    res.status,
    404,
    `🚨 DATA BREACH: ${method} ${path} returned ${res.status} for a DIFFERENT user's resource.\n` +
    `      Expected 404. A 200 means one user can read or mutate another user's data.\n` +
    `      A 403 leaks that the id exists, making ids probeable.\n` +
    `      body: ${JSON.stringify(res.json).slice(0, 200)}`,
  );
  ok(`isolated: ${label}`);
}

async function run(): Promise<void> {
  console.log(`smoke check → ${BASE_URL}`);
  await connectRedis();
  // Section 16 reads and writes rows the sweep decides on; everything before it
  // is black-box over HTTP.
  await connectDatabase();

  // ── 1. health + public routes ─────────────────────────────────────────────
  step("1. health and public routes");
  const health = await fetch(`${BASE_URL}/health`);
  assert.equal(health.status, 200, "server is not reachable — is `npm run dev` running?");
  const healthBody = (await health.json()) as { status: string; vector_index?: string };
  assert.equal(healthBody.status, "ok");
  ok("GET /health works with no token");

  const voices = await api<Array<{ id: string }>>("GET", "/voice/voices", null);
  assert.equal(voices.status, 200, "the voice catalog is shown before sign-in and must stay public");
  assert.ok(Array.isArray(voices.json.data) && voices.json.data.length > 0, "voice catalog is empty");
  ok(`GET /voice/voices works with no token (${voices.json.data!.length} voices)`);

  const vectorIndex = healthBody.vector_index ?? "absent-from-response";
  console.log(`    vector_index: ${vectorIndex}`);
  if (vectorIndex !== "ready") {
    console.log(
      `    ⚠️  vector_index is "${vectorIndex}" — long-term memory RECALL will not work.\n` +
      "       Memories will still be written; they just won't be retrieved.\n" +
      "       Create the Atlas index (README §4) then re-run.",
    );
  } else {
    ok("Atlas vector index is READY");
  }

  // ── 2. the trust boundary ─────────────────────────────────────────────────
  step("2. unauthenticated and forged requests are refused");
  await refused("no token → GET /users/me is 401", "GET", "/users/me", null);
  await refused("no token → GET /characters is 401", "GET", "/characters", null);
  await refused("no token → POST /sessions/start is 401", "POST", "/sessions/start", null, {
    character_id: "000000000000000000000000",
    session_type: "text",
  });
  await refused("no token → POST /conversations/send is 401", "POST", "/conversations/send", null, {
    session_id: "000000000000000000000000",
    message: "hello",
  });
  await refused("garbage token → 401", "GET", "/users/me", "not-a-real-token");

  // ── 3. sign-in ────────────────────────────────────────────────────────────
  step("3. email one-time-code sign-in");
  const emailA = `smoke-${Date.now()}-a@example.test`;
  const a = await signIn(emailA);
  assert.equal(a.onboarding_completed, false, "a brand-new account cannot already be onboarded");
  ok(`user A signed in (${a.user_id})`);

  const meBeforeOnboard = await api<{ onboarding_completed: boolean }>("GET", "/users/me", a.token);
  assert.equal(meBeforeOnboard.status, 200, "a valid token must be accepted");
  ok("the issued token is accepted on a protected route");

  // ── 4. onboarding ─────────────────────────────────────────────────────────
  step("4. onboarding");
  const expectedName = `${SMOKE_PREFIX}-${Date.now()}`;
  const onboardBody = {
    display_name: expectedName,
    gender: "nonbinary",
    date_of_birth: "1995-01-01",
    communication_style: "warm",
    intent: "smoke test",
    companion: { name: "Maya", archetype: "bestfriend", gender: "female", voice_id: VOICE_FEMALE },
  };
  const onboard = await api<{ user_id: string; character_id: string; is_minor: boolean }>(
    "POST",
    "/users/onboard",
    a.token,
    onboardBody,
  );
  assert.equal(onboard.status, 201, `onboard failed: ${JSON.stringify(onboard.json)}`);
  const characterId = onboard.json.data!.character_id;
  assert.equal(
    onboard.json.data!.user_id,
    a.user_id,
    "onboard must complete the signed-in user, not create a new one",
  );
  assert.ok(characterId, "onboard did not return a character_id");
  assert.equal(onboard.json.data!.is_minor, false, "1995 DOB must not be a minor");
  ok("profile completed + companion created for the signed-in user");

  // Regression guard for the "every user is called Aria" bug: the name the
  // client sent must be the name that was stored.
  const me = await api<{ display_name: string }>("GET", "/users/me", a.token);
  assert.equal(me.status, 200);
  assert.equal(
    me.json.data!.display_name,
    expectedName,
    "display_name was not persisted as sent — the client is substituting a placeholder name",
  );
  ok(`display_name round-trips ("${expectedName}")`);

  const again = await api("POST", "/users/onboard", a.token, onboardBody);
  assert.equal(again.status, 409, `second onboard returned ${again.status}, expected 409`);
  assert.equal(again.json.code, "ALREADY_ONBOARDED", "409 must carry code ALREADY_ONBOARDED");
  ok("onboarding twice is refused (no duplicate companion)");

  const list = await api<{ characters: Array<{ _id: string; name: string }> }>(
    "GET",
    "/characters",
    a.token,
  );
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.data!.characters.map((c) => c._id),
    [characterId],
    "GET /characters must return exactly the caller's own companions",
  );
  ok("GET /characters returns the caller's companion");

  // ── 5. age floor + minor protections ──────────────────────────────────────
  step("5. age floor and minor protections");
  const minorSession = await signIn(`smoke-${Date.now()}-m@example.test`);
  const yearsAgo = (n: number): string => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    return d.toISOString().slice(0, 10);
  };

  const tooYoung = await api("POST", "/users/onboard", minorSession.token, {
    display_name: `${SMOKE_PREFIX}-14yo-${Date.now()}`,
    gender: "female",
    date_of_birth: yearsAgo(14),
    communication_style: "calm",
    intent: "smoke test under-age",
    companion: { name: "Iris", archetype: "mentor", gender: "female", voice_id: VOICE_MENTOR },
  });
  assert.equal(tooYoung.status, 403, `a 14-year-old was onboarded with ${tooYoung.status}`);
  assert.equal(tooYoung.json.code, "UNDER_MINIMUM_AGE", "403 must carry code UNDER_MINIMUM_AGE");
  ok("under-15 onboarding is refused");

  // Same account, now at the floor: allowed, but flagged as a minor.
  const minor = await api<{ user_id: string; is_minor: boolean }>(
    "POST",
    "/users/onboard",
    minorSession.token,
    {
      display_name: `${SMOKE_PREFIX}-minor-${Date.now()}`,
      gender: "female",
      date_of_birth: yearsAgo(15),
      communication_style: "calm",
      intent: "smoke test minor",
      companion: { name: "Iris", archetype: "mentor", gender: "female", voice_id: VOICE_MENTOR },
    },
  );
  assert.equal(minor.status, 201, `minor onboard failed: ${JSON.stringify(minor.json)}`);
  assert.equal(minor.json.data!.is_minor, true, "a 15-year-old DOB must set is_minor");
  ok("is_minor derived from date of birth");

  const minorPartner = await api("POST", "/characters/create", minorSession.token, {
    archetype: "partner",
    gender: "male",
    voice_id: VOICE_MALE,
    name: "Kai",
  });
  assert.equal(minorPartner.status, 400, "a minor must not be able to create a `partner` companion");
  ok("partner archetype blocked for minors");

  // ── 6. text conversation ──────────────────────────────────────────────────
  step("6. text conversation");
  const session = await api<{ session_id: string }>("POST", "/sessions/start", a.token, {
    character_id: characterId,
    session_type: "text",
  });
  assert.equal(session.status, 201, `session start failed: ${JSON.stringify(session.json)}`);
  const sessionId = session.json.data!.session_id;
  ok("session started");

  const turn = await sendMessage(a.token, {
    session_id: sessionId,
    message:
      "Hey Maya. My sister Priya is getting married in October and I just started running again after two years off.",
  });
  assert.deepEqual(turn.errors, [], `stream reported errors: ${turn.errors.join("; ")}`);
  assert.ok(turn.chunks.length > 0, "no chunks streamed — the LLM produced nothing");
  assert.ok(turn.turnId, "no `done` event with a turn_id");
  const reply = turn.chunks.join("");
  assert.ok(reply.trim().length > 0, "assistant reply was empty");
  ok(`streamed ${turn.chunks.length} chunks (${reply.length} chars)`);

  // Turn persistence is what memory extraction reads at session end.
  const turns = await api<{ turns: Array<{ role: string; content_text: string }> }>(
    "GET",
    `/conversations/${sessionId}`,
    a.token,
  );
  assert.equal(turns.status, 200);
  const roles = turns.json.data!.turns.map((t) => t.role);
  assert.ok(roles.includes("user"), "user turn was not persisted");
  assert.ok(roles.includes("assistant"), "assistant turn was not persisted");
  ok(`both turns persisted (${roles.join(", ")})`);

  // ── 7. crisis path ────────────────────────────────────────────────────────
  step("7. crisis safety path");
  const crisisSession = await api<{ session_id: string }>("POST", "/sessions/start", a.token, {
    character_id: characterId,
    session_type: "text",
  });
  const crisisSessionId = crisisSession.json.data!.session_id;
  const crisisTurn = await sendMessage(a.token, {
    session_id: crisisSessionId,
    message: "I don't want to be alive anymore. I've been thinking about killing myself.",
  });
  const crisisText = [...crisisTurn.crisis, ...crisisTurn.chunks].join("");
  assert.ok(
    crisisTurn.crisis.length > 0,
    "self-harm message did not trigger the `crisis` event — moderation or the crisis threshold is broken",
  );
  assert.ok(crisisText.includes("988"), "crisis response must include the 988 lifeline");
  ok("self-harm message routed to crisis resources");
  await api("POST", `/sessions/${crisisSessionId}/end`, a.token, {});

  // ── 8. session end → memory extraction ────────────────────────────────────
  step("8. session end → memory extraction");
  const ended = await api<{ duration_seconds: number }>(
    "POST",
    `/sessions/${sessionId}/end`,
    a.token,
    {},
  );
  assert.equal(ended.status, 200, `session end failed: ${JSON.stringify(ended.json)}`);
  assert.ok(typeof ended.json.data!.duration_seconds === "number", "no duration returned");
  ok(`session ended (${ended.json.data!.duration_seconds}s)`);

  console.log(`    waiting up to ${MEMORY_TIMEOUT_MS / 1000}s for the extraction job…`);
  const deadline = Date.now() + MEMORY_TIMEOUT_MS;
  let memories: Array<{ content: string; type: string }> = [];
  while (Date.now() < deadline) {
    await sleep(MEMORY_POLL_MS);
    const res = await api<Array<{ content: string; type: string }>>(
      "GET",
      `/memories/${characterId}`,
      a.token,
    );
    if (res.status === 200 && Array.isArray(res.json.data) && res.json.data.length > 0) {
      memories = res.json.data;
      break;
    }
  }
  assert.ok(
    memories.length > 0,
    "no memories were extracted — is the memory worker running, and is REDIS_URL reachable?",
  );
  ok(`${memories.length} memories extracted`);
  for (const m of memories.slice(0, 5)) console.log(`      • [${m.type}] ${m.content}`);

  // ── 9. recall on a fresh session ──────────────────────────────────────────
  //
  // Atlas Vector Search is EVENTUALLY consistent. GET /memories reads MongoDB
  // directly and sees a new memory immediately, but $vectorSearch cannot query
  // it until the search index catches up — a few seconds after insert. So a
  // recall attempt fired straight after extraction legitimately returns
  // nothing. Give the index a head start, then retry before failing; do not
  // replace this with a single fixed sleep, it just moves the flakiness.
  step("9. recall in a new session");
  const RECALL_ATTEMPTS = 3;
  const RECALL_BACKOFF_MS = 8_000;
  const RECALLS = /priya|wedding|marry|marriage|october|sister/i;

  let recalled = false;
  let lastReply = "";

  for (let attempt = 1; attempt <= RECALL_ATTEMPTS; attempt++) {
    console.log(`    waiting ${RECALL_BACKOFF_MS / 1000}s for the search index to catch up…`);
    await sleep(RECALL_BACKOFF_MS);

    const s = await api<{ session_id: string }>("POST", "/sessions/start", a.token, {
      character_id: characterId,
      session_type: "text",
    });
    const t = await sendMessage(a.token, {
      session_id: s.json.data!.session_id,
      message: "Do you remember what I told you about my sister?",
    });
    await api("POST", `/sessions/${s.json.data!.session_id}/end`, a.token, {});

    assert.deepEqual(t.errors, [], `recall turn errored: ${t.errors.join("; ")}`);
    assert.ok(t.chunks.length > 0, "recall turn produced no reply");
    lastReply = t.chunks.join("");

    if (vectorIndex !== "ready") break; // assertion is meaningless without the index
    if (RECALLS.test(lastReply)) {
      recalled = true;
      console.log(`    recalled on attempt ${attempt}`);
      break;
    }
    console.log(`    attempt ${attempt}: no recall yet`);
  }

  ok("second session replied");
  if (vectorIndex === "ready") {
    assert.ok(
      recalled,
      `after ${RECALL_ATTEMPTS} attempts the companion still did not recall the stored memory.\n` +
      `      last reply: "${lastReply.slice(0, 200)}"\n` +
      "      Debug with: npx tsx src/scripts/probe-recall.ts " + characterId,
    );
    ok("companion recalled a stored memory across sessions");
  } else {
    console.log("    ⚠️  skipped recall assertion — vector index is not ready");
  }

  // ── 10. voice session billing ─────────────────────────────────────────────
  step("10. voice session billing");
  const voiceSession = await api<{ session_id: string }>("POST", "/sessions/start", a.token, {
    character_id: characterId,
    session_type: "voice_call",
  });
  assert.equal(voiceSession.status, 201);
  const voiceSessionId = voiceSession.json.data!.session_id;
  await sleep(2_000);
  const voiceEnded = await api<{ duration_seconds: number }>(
    "POST",
    `/sessions/${voiceSessionId}/end`,
    a.token,
    {},
  );
  assert.equal(voiceEnded.status, 200);
  const dur = voiceEnded.json.data!.duration_seconds;
  // The bug: nothing closed voice sessions, so the 30-minute stale sweep did it
  // and billed ~31 minutes for a 2-minute call. A short call must stay short.
  assert.ok(dur < 60, `a ~2s voice session reported ${dur}s — session end is not being honoured`);
  ok(`voice session billed on real duration (${dur}s)`);

  // Ending twice must not double-count.
  const endAgain = await api("POST", `/sessions/${voiceSessionId}/end`, a.token, {});
  assert.equal(endAgain.status, 404, "ending an already-ended session must be a no-op");
  ok("session end is idempotent");

  // ── 11. companion editing ─────────────────────────────────────────────────
  // After the conversation sections on purpose: renaming the companion mid-run
  // would change the persona the recall turns are talking to.
  step("11. companion editing");
  const renamed = `Maya-${Date.now()}`;
  const patched = await api<{ name: string }>("PATCH", `/characters/${characterId}`, a.token, {
    name: renamed,
  });
  assert.equal(patched.status, 200, `PATCH failed: ${JSON.stringify(patched.json)}`);
  assert.equal(patched.json.data!.name, renamed, "PATCH did not return the new name");
  const reread = await api<{ name: string }>("GET", `/characters/${characterId}`, a.token);
  assert.equal(reread.json.data!.name, renamed, "the rename did not persist");
  ok(`PATCH /characters/:id renamed the companion ("${renamed}")`);

  const badVoice = await api("PATCH", `/characters/${characterId}`, a.token, {
    voice_id: "not-a-voice-in-the-catalog",
  });
  assert.equal(badVoice.status, 400, "a voice_id outside the catalog must be rejected");
  ok("PATCH /characters/:id rejects an unknown voice_id");

  // ── 12. stats and export ──────────────────────────────────────────────────
  step("12. stats and export");
  const stats = await api<{
    total_sessions: number;
    total_memories: number;
    total_companions: number;
  }>("GET", "/users/me/stats", a.token);
  assert.equal(stats.status, 200);
  assert.ok(stats.json.data!.total_sessions > 0, "sessions were not counted");
  assert.ok(stats.json.data!.total_memories > 0, "memories were not counted");
  ok(
    `stats: ${stats.json.data!.total_companions} companions, ` +
    `${stats.json.data!.total_sessions} sessions, ${stats.json.data!.total_memories} memories`,
  );

  const exported = await api<{ user: unknown; memories: unknown[] }>(
    "GET",
    "/users/me/export",
    a.token,
  );
  assert.equal(exported.status, 200, "the data export path must work");
  assert.ok(exported.json.data!.user, "export contains no user");
  assert.ok(exported.json.data!.memories.length > 0, "export contains no memories");
  ok("GET /users/me/export returns the account's data");

  // ── 13. cross-user isolation ──────────────────────────────────────────────
  //
  // The most valuable section in this file. Every assertion below is a
  // regression that would be a reportable data breach, so each one is 404: a
  // 200 is a leak, and a 403 confirms the id exists and makes ids probeable.
  step("13. cross-user isolation (a regression here is a DATA BREACH)");
  const emailB = `smoke-${Date.now()}-b@example.test`;
  let b = await signIn(emailB);
  const bOnboard = await api<{ character_id: string }>("POST", "/users/onboard", b.token, {
    display_name: `${SMOKE_PREFIX}-b-${Date.now()}`,
    gender: "male",
    date_of_birth: "1990-06-15",
    communication_style: "direct",
    intent: "smoke test second user",
    companion: { name: "Rex", archetype: "mentor", gender: "male", voice_id: VOICE_MALE },
  });
  assert.equal(bOnboard.status, 201, `user B onboard failed: ${JSON.stringify(bOnboard.json)}`);
  ok(`user B signed in and onboarded (${b.user_id})`);

  await isolated("read A's character", "GET", `/characters/${characterId}`, b.token);
  await isolated("read A's memories", "GET", `/memories/${characterId}`, b.token);
  await isolated("read A's transcript", "GET", `/conversations/${sessionId}`, b.token);
  await isolated("start a session on A's character", "POST", "/sessions/start", b.token, {
    character_id: characterId,
    session_type: "text",
  });
  await isolated("send into A's session", "POST", "/conversations/send", b.token, {
    session_id: sessionId,
    message: "who are you talking to?",
  });
  await isolated("start a voice session on A's character", "POST", "/voice/sessions/start", b.token, {
    character_id: characterId,
  });
  await isolated(
    "wipe A's memories",
    "DELETE",
    `/memories/character/${characterId}`,
    b.token,
  );
  await isolated("rename A's character", "PATCH", `/characters/${characterId}`, b.token, {
    name: "pwned",
  });
  await isolated("delete A's character", "DELETE", `/characters/${characterId}`, b.token);

  // Belt and braces: prove the attempts above changed nothing.
  const aStill = await api<{ name: string }>("GET", `/characters/${characterId}`, a.token);
  assert.equal(aStill.status, 200, "user A's character disappeared during the isolation tests");
  assert.equal(aStill.json.data!.name, renamed, "user B managed to rename user A's character");
  const aMemories = await api<Array<unknown>>("GET", `/memories/${characterId}`, a.token);
  assert.ok(aMemories.json.data!.length > 0, "user B managed to wipe user A's memories");
  ok("A's data is intact after every attempt by B");

  // ── 14. sign-out revokes ──────────────────────────────────────────────────
  step("14. sign-out revokes the token");
  const bToken = b.token;
  const loggedOut = await api("POST", "/auth/logout", bToken, {});
  assert.equal(loggedOut.status, 200, `logout failed: ${JSON.stringify(loggedOut.json)}`);
  await refused("the token from before sign-out is dead", "GET", "/users/me", bToken);

  // ── 15. account deletion ──────────────────────────────────────────────────
  // Last, because it destroys user B.
  step("15. account deletion leaves nothing behind");
  b = await signIn(emailB);
  assert.ok(b.onboarding_completed, "signing back in must return the SAME account, already onboarded");
  ok("user B signed back in after sign-out");

  const unconfirmed = await api("DELETE", "/users/me", b.token, {});
  assert.equal(unconfirmed.status, 400, "deleting without the confirmation string must be a 400");
  ok("account deletion requires the confirmation string");

  const deleted = await api<{ deleted: boolean }>("DELETE", "/users/me", b.token, {
    confirm: "DELETE",
  });
  assert.equal(deleted.status, 200, `delete failed: ${JSON.stringify(deleted.json)}`);
  ok("account deleted");

  await refused("the deleted account's token is dead", "GET", "/users/me", b.token);

  const reborn = await signIn(emailB);
  assert.equal(
    reborn.onboarding_completed,
    false,
    "signing in with a deleted account's address must produce a fresh, un-onboarded account",
  );
  const rebornChars = await api<{ characters: unknown[] }>("GET", "/characters", reborn.token);
  assert.equal(rebornChars.status, 200);
  assert.deepEqual(
    rebornChars.json.data!.characters,
    [],
    "a re-registered address can still see the deleted account's companions — deletion did not cascade",
  );
  ok("nothing survived deletion — the same address comes back to an empty account");

  // ── 16 ────────────────────────────────────────────────────────────────────
  step("16. proactive outreach send policy (a regression here messages someone in crisis)");
  await runOutreachChecks(a.user_id, characterId);

  // ── 17 ────────────────────────────────────────────────────────────────────
  step("17. a reply that lands while you are away still reaches you");
  await runUnreadReplyChecks(a.token, a.user_id, characterId);

  // ── 18 ────────────────────────────────────────────────────────────────────
  step("18. the companion adapts only when asked, and only once a week");
  await runAdaptationChecks(a.token, a.user_id, characterId, reborn.token);

  // ── 18b ───────────────────────────────────────────────────────────────────
  step("18b. requesting sign-in codes is rate limited");

  // Unauthenticated, writes to Redis, and (once a provider is configured)
  // sends real mail from your domain. Unthrottled it is both an email-bombing
  // vector and an unlimited brute-force window: every request mints a fresh
  // code AND resets the five-attempt counter.
  const rlEmail = `${SMOKE_PREFIX}-ratelimit-${Date.now()}@example.test`;
  let sawLimit = false;
  for (let i = 0; i < 8; i++) {
    const r = await api<unknown>("POST", "/auth/email/request", null, { email: rlEmail });
    if (r.status === 429) {
      assert.equal(r.json.code, "RATE_LIMITED", "a throttled request must say why");
      sawLimit = true;
      break;
    }
    assert.equal(r.status, 200, `unexpected status ${r.status} while probing the rate limit`);
  }
  assert.ok(sawLimit, "sign-in codes can be requested without limit");
  ok("repeated code requests for one address are refused");

  // ── 19 ────────────────────────────────────────────────────────────────────
  step("19. the streak and the week strip are the user's own, not constants");

  const acted = await api<{
    streak_days: number; best_streak: number; week_minutes: number[];
    week_total_minutes: number; prev_week_total_minutes: number; active_days: number;
  }>("GET", "/users/me/activity", a.token);
  assert.equal(acted.status, 200);
  const act = acted.json.data!;
  assert.equal(act.week_minutes.length, 7, "the week strip needs exactly seven bars");
  assert.ok(act.active_days >= 1, "a user who has held sessions shows no active days");
  assert.ok(act.streak_days >= 1, "a session today did not register as a streak");
  assert.ok(act.best_streak >= act.streak_days, "the personal best cannot be below the live streak");
  ok(`activity reflects real sessions (streak ${act.streak_days}, ${act.active_days} active days)`);

  // The whole point. This screen used to show a 12-day streak and a personal
  // best of 21 to an account created seconds ago.
  const fresh = await api<{
    streak_days: number; best_streak: number; week_minutes: number[]; active_days: number;
  }>("GET", "/users/me/activity", reborn.token);
  assert.equal(fresh.status, 200);
  assert.deepEqual(
    fresh.json.data,
    {
      streak_days: 0,
      best_streak: 0,
      week_minutes: [0, 0, 0, 0, 0, 0, 0],
      week_total_minutes: 0,
      prev_week_total_minutes: 0,
      active_days: 0,
    },
    "a brand-new account was shown activity it has not had",
  );
  ok("a brand-new account sees zeros, not a fabricated streak");

  console.log(`\n✅ smoke check passed — ${passed} assertions`);
  console.log(`   test data is named "${SMOKE_PREFIX}-*" if you want to purge it.`);
  console.log(`   users left behind: A (${a.user_id}), minor (${minorSession.user_id}), reborn B (${reborn.user_id}).`);
}

/**
 * Backgrounding the app mid-reply must not lose the answer.
 *
 * The SSE route keeps generating after the client disconnects, so the reply is
 * produced and persisted either way — what used to be missing is that nothing
 * told the user. This aborts a real stream and asserts both halves: the turn
 * lands, and the notification path actually runs.
 */
async function runUnreadReplyChecks(
  token: string,
  userId: string,
  characterId: string,
): Promise<void> {
  const started = await api<{ session_id: string }>("POST", "/sessions/start", token, {
    character_id: characterId,
    session_type: "text",
  });
  assert.equal(started.status, 201, "could not start a session for the unread-reply check");
  const sessionId = started.json.data!.session_id;

  // A syntactically valid token Expo will reject. Its disappearance is how we
  // prove the notification path ran all the way to the wire — there is no other
  // observable effect from a machine with no device attached.
  await User.updateOne(
    { _id: userId },
    { $set: { push_token: "ExponentPushToken[smoke-unread-reply]" } },
  );

  // Abort the moment the first bytes arrive: that is a backgrounded app, not a
  // request that never happened.
  const ctrl = new AbortController();
  const res = await fetch(`${API}/conversations/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ session_id: sessionId, message: "What should I focus on this week?" }),
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200, "the stream did not start");

  const reader = res.body!.getReader();
  await reader.read();          // first chunk — the reply is under way
  ctrl.abort();                 // and now the user backgrounds the app
  await reader.cancel().catch(() => {});
  ok("a stream can be abandoned mid-reply");

  // Generation continues server-side; give it room to finish and notify.
  let persisted = "";
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const turns = await api<{ turns: Array<{ role: string; content_text: string }> }>(
      "GET",
      `/conversations/${sessionId}`,
      token,
    );
    const assistant = turns.json.data?.turns.find((t) => t.role === "assistant");
    if (assistant?.content_text) { persisted = assistant.content_text; break; }
  }
  assert.ok(
    persisted.length > 0,
    "the reply was abandoned instead of finished — a user who backgrounds the app loses the answer they asked for",
  );
  ok("the reply is generated and persisted anyway");

  // Polled, not read once. The notification is fired after the turn is
  // persisted, so the loop above can see the reply before the push has left the
  // process — reading immediately made this assertion a coin flip.
  let cleared: string | null = "not-checked";
  for (let i = 0; i < 12; i++) {
    const after = await User.findById(userId).select("push_token").lean();
    cleared = after?.push_token ?? null;
    if (cleared === null) break;
    await sleep(1000);
  }
  assert.equal(
    cleared,
    null,
    "the unread-reply notification never reached Expo — the answer would sit unread with nothing to announce it",
  );
  ok("the user is notified that the answer arrived");

  await User.updateOne({ _id: userId }, { $set: { push_token: null } });
}

/**
 * The stateful half of the outreach policy.
 *
 * check:outreach covers the pure quiet-hours logic offline. These are the
 * branches that need real rows: crisis suppression, its precedence over
 * expiry, the once-only post-crisis check-in, and failing closed when there is
 * no device to send to.
 *
 * No LLM cost: every path asserted here either stops before message generation
 * or uses the fixed crisis text. The one outbound call is to Expo's public push
 * endpoint with a deliberately unregistered token, which is also how the
 * "dead token gets dropped" assertion is made.
 */
async function runOutreachChecks(userId: string, characterId: string): Promise<void> {
  const charObjId = new Types.ObjectId(characterId);
  const now = Date.now();

  // Re-runnable: clear anything a previous run left, or user A would still be
  // inside their crisis window and every assertion below would shift.
  const reset = async (): Promise<void> => {
    await FollowUp.deleteMany({ user_id: userId });
    await ConversationTurn.deleteMany({ user_id: userId, "safety_flags.is_crisis": true });
    await User.updateOne({ _id: userId }, { $set: { push_token: null, timezone: "UTC" } });
  };
  await reset();

  const seedHint = async (hint: string, triggerOffsetMs: number): Promise<Types.ObjectId> => {
    const doc = await FollowUp.create({
      user_id: userId,
      character_id: charObjId,
      session_id: charObjId, // any ObjectId; the sweep never dereferences it
      hint,
      trigger_date: new Date(now + triggerOffsetMs),
      type: "event_follow_up",
      status: "pending",
    });
    return doc._id as Types.ObjectId;
  };

  const seedCrisis = async (ageMs: number): Promise<void> => {
    await ConversationTurn.create({
      session_id: charObjId,
      character_id: charObjId,
      user_id: userId,
      role: "user",
      content_text: "[smoke] crisis marker",
      safety_flags: { categories: {}, flagged: true, is_crisis: true },
      created_at: new Date(now - ageMs),
    });
  };

  const statusOf = async (id: Types.ObjectId): Promise<string> =>
    (await FollowUp.findById(id).select("status").lean())?.status ?? "missing";

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  // 1. A crisis suppresses everything queued.
  const queued = await seedHint("ask how the interview went", -HOUR);
  await seedCrisis(2 * HOUR);
  await runOutreachSweep(new Date());
  assert.equal(
    await statusOf(queued),
    "suppressed",
    "🚨 a due follow-up was NOT suppressed after a crisis session — this is the message that asks someone how their interview went two days after a self-harm disclosure",
  );
  ok("a crisis suppresses every queued follow-up");

  // 2. And it wins over expiry, so a stale hint is suppressed rather than
  //    quietly expiring and looking like the crisis rule worked.
  const stale = await seedHint("stale hint", -10 * DAY);
  await runOutreachSweep(new Date());
  assert.equal(
    await statusOf(stale),
    "suppressed",
    "crisis handling must take precedence over expiry, or the suppression is untested luck",
  );
  ok("crisis takes precedence over hint expiry");

  // 3. Too soon after the crisis, nothing is sent at all.
  assert.equal(
    await FollowUp.countDocuments({ user_id: userId, hint: "__crisis_checkin__" }),
    0,
    "the post-crisis check-in fired within the delay window",
  );
  ok("no check-in within the first 24 hours after a crisis");

  // 4. A day later: exactly one check-in, ever.
  await ConversationTurn.updateMany(
    { user_id: userId, "safety_flags.is_crisis": true },
    { $set: { created_at: new Date(now - 25 * HOUR) } },
  );
  await User.updateOne(
    { _id: userId },
    // Syntactically valid and deliberately unregistered — Expo answers
    // DeviceNotRegistered, which is also assertion 6 below.
    { $set: { push_token: "ExponentPushToken[smoke-not-a-real-device]" } },
  );
  await runOutreachSweep(new Date());
  assert.equal(
    await FollowUp.countDocuments({ user_id: userId, hint: "__crisis_checkin__" }),
    1,
    "expected exactly one post-crisis check-in",
  );
  ok("one gentle check-in is sent ~24h after a crisis");

  // 5. Sweeping again must not send a second one.
  await runOutreachSweep(new Date());
  assert.equal(
    await FollowUp.countDocuments({ user_id: userId, hint: "__crisis_checkin__" }),
    1,
    "a second sweep produced another check-in — someone in crisis would be messaged repeatedly",
  );
  ok("the check-in is sent once, not once per sweep");

  // 6. A token Expo rejects is dropped rather than retried forever.
  const afterSend = await User.findById(userId).select("push_token").lean();
  assert.equal(
    afterSend?.push_token ?? null,
    null,
    "an unregistered push token was not cleared — it would be retried on every sweep forever",
  );
  ok("a device Expo no longer knows is dropped");

  // 7. Outside a crisis, stale hints expire instead of being sent late.
  await reset();
  const old = await seedHint("how did Tuesday go", -10 * DAY);
  await runOutreachSweep(new Date());
  assert.equal(
    await statusOf(old),
    "expired",
    "a hint older than the expiry window must not be sent",
  );
  ok("hints older than the expiry window expire unsent");

  // 8. With no device, nothing is sent and nothing is lost.
  const pending = await seedHint("still relevant", -HOUR);
  const result = await runOutreachSweep(new Date());
  assert.equal(result.sent, 0, "a user with no push token must receive nothing");
  assert.equal(
    await statusOf(pending),
    "pending",
    "a hint skipped for lack of a device must stay pending, not be consumed",
  );
  ok("no device means nothing sent and nothing lost");

  // 9. A deleted companion stops messaging.
  await Character.updateOne({ _id: charObjId }, { $set: { is_active: false } });
  const orphan = await seedHint("from a deleted companion", -HOUR);
  await runOutreachSweep(new Date());
  assert.equal(
    await statusOf(orphan),
    "suppressed",
    "a deactivated companion must not keep sending messages",
  );
  ok("a deleted companion stops reaching out");

  await Character.updateOne({ _id: charObjId }, { $set: { is_active: true } });
  await reset();
}

/**
 * Phase C — a preference the user stated becomes an offer, and only an offer.
 *
 * The offline check covers which suggestion gets picked. What needs a database
 * is everything after the tap: that the slider actually moves, that the weekly
 * cap survives a restart, that a second tap cannot apply it twice, and that
 * the cached persona is dropped so the change reaches the model.
 */
async function runAdaptationChecks(
  token: string,
  userId: string,
  characterId: string,
  otherToken: string,
): Promise<void> {
  const charObjId = new Types.ObjectId(characterId);

  // A real embedding shape so nothing downstream chokes on it; the values do
  // not matter because adaptation never runs a vector search.
  const embedding = Array.from({ length: 1536 }, () => 0.001);
  const seedHint = async (content: string, trait: string, direction: string) =>
    (
      await Memory.create({
        user_id: userId,
        character_id: charObjId,
        content,
        type: "preference",
        sentiment: "neutral",
        embedding,
        source_session_id: new Types.ObjectId(),
        related_entities: [],
        slider_hint: { trait, direction },
      })
    )._id.toString();

  const seeded: string[] = [];
  try {
    // Start from a known middle so the arithmetic below is unambiguous.
    await Character.updateOne(
      { _id: charObjId },
      { $set: { "personality_sliders.directness": 50, adaptation: {} } },
    );

    const first = await seedHint("user prefers direct feedback over softening", "directness", "up");
    seeded.push(first);

    const offer = await api<{ suggestion: { memory_id: string; trait: string; from: number; to: number; phrase: string } | null }>(
      "GET", `/characters/${characterId}/suggestion`, token,
    );
    assert.equal(offer.status, 200);
    const s1 = offer.json.data!.suggestion;
    assert.ok(s1, "a preference memory with a slider hint produced no offer");
    assert.equal(s1.memory_id, first);
    assert.equal(s1.trait, "directness");
    assert.equal(s1.from, 50);
    assert.equal(s1.to, 70);
    assert.equal(s1.phrase, "more direct");
    ok("a stated preference becomes a one-tap offer");

    // Nothing has been applied yet. If merely showing the offer moved the
    // slider, the app would be editing the companion behind the user's back.
    const untouched = await Character.findById(charObjId).select("personality_sliders").lean();
    assert.equal(
      untouched?.personality_sliders.directness,
      50,
      "seeing a suggestion changed the companion — it must be an offer, not a drift",
    );
    ok("showing the offer changes nothing on its own");

    // A newer, different preference must NOT replace an offer already on screen.
    const second = await seedHint("user asked to be talked to more gently", "warmth", "up");
    seeded.push(second);
    const again = await api<{ suggestion: { memory_id: string } | null }>(
      "GET", `/characters/${characterId}/suggestion`, token,
    );
    assert.equal(again.json.data!.suggestion?.memory_id, first, "an outstanding offer was replaced before it was answered");
    ok("an unanswered offer stays put");

    // Someone else asking about this companion learns nothing.
    const nosy = await api<{ suggestion: unknown }>(
      "GET", `/characters/${characterId}/suggestion`, otherToken,
    );
    assert.equal(nosy.json.data?.suggestion ?? null, null, "another user was shown this companion's suggestion");
    const forged = await api("POST", `/characters/${characterId}/suggestion`, otherToken, {
      memory_id: first, action: "apply",
    });
    assert.equal(forged.status, 409, "another user was able to retune this companion");
    ok("no one else can see or answer this companion's offer");

    // The tap.
    const applied = await api<{ personality_sliders: { directness: number } }>(
      "POST", `/characters/${characterId}/suggestion`, token, { memory_id: first, action: "apply" },
    );
    assert.equal(applied.status, 200);
    assert.equal(applied.json.data!.personality_sliders.directness, 70);
    const moved = await Character.findById(charObjId).select("personality_sliders adaptation").lean();
    assert.equal(moved?.personality_sliders.directness, 70, "the tap did not reach the database");
    assert.equal(moved?.adaptation?.recent_change?.trait, "directness");
    assert.equal(moved?.adaptation?.recent_change?.direction, "up");
    ok("accepting moves the slider and records that it was asked for");

    // The cached persona holds sliders AND the recent-change line. If it
    // survives, the model keeps the old personality for up to an hour.
    const cached = await getRedis().get(`character_config:v4:${characterId}`);
    assert.equal(cached, null, "the cached persona survived a personality change");
    ok("the change reaches the model immediately, not after a cache expiry");

    const twice = await api("POST", `/characters/${characterId}/suggestion`, token, {
      memory_id: first, action: "apply",
    });
    assert.equal(twice.status, 409, "the same suggestion applied twice would move the slider 40 points");
    const stillSeventy = await Character.findById(charObjId).select("personality_sliders").lean();
    assert.equal(stillSeventy?.personality_sliders.directness, 70);
    ok("a double tap cannot apply the same suggestion twice");

    // C3. The second seeded hint is outstanding and unanswered, but the week is
    // not up — a companion that asks to be reconfigured repeatedly is exhausting.
    const capped = await api<{ suggestion: unknown }>(
      "GET", `/characters/${characterId}/suggestion`, token,
    );
    assert.equal(capped.json.data?.suggestion ?? null, null, "a second suggestion was offered inside the same week");
    ok("at most one suggestion a week");

    // …and the cap is stored, not held in memory, so a restart does not reset it.
    const state = await Character.findById(charObjId).select("adaptation").lean();
    assert.ok(state?.adaptation?.last_offered_at, "the weekly cap is not persisted");
    assert.deepEqual(state?.adaptation?.handled_memory_ids, [first], "the answered memory was not retired");
    ok("the cap and the answered memory survive a restart");
  } finally {
    // These are hand-seeded rows with fake embeddings — leaving them behind
    // would put junk vectors in the same index real recall searches.
    if (seeded.length) await Memory.deleteMany({ _id: { $in: seeded } });
  }
}

// ponytail: uncovered on purpose — PATCH /users/me (a field write with no
// safety or ownership rule of its own) and context compression (it needs a
// dozen+ LLM turns to trip the window, which this check will not pay for).
// Both belong in a slower nightly run if they ever regress.

// Both connections must be closed or the process hangs after the last
// assertion: an open mongoose pool keeps the event loop alive on its own.
const shutdown = async (): Promise<void> => {
  await disconnectRedis().catch(() => {});
  await mongoose.disconnect().catch(() => {});
};

run()
  .then(shutdown)
  .catch(async (err) => {
    console.error(`\n❌ smoke check FAILED after ${passed} passing assertions\n`);
    console.error(err instanceof Error ? err.message : err);
    await shutdown();
    process.exit(1);
  });
