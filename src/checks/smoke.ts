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
import { connectRedis, disconnectRedis, getRedis } from "../config/redis.js";

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
  const requested = await api("POST", "/auth/email/request", null, { email });
  assert.equal(
    requested.status,
    200,
    `auth/email/request failed: ${JSON.stringify(requested.json)}`,
  );

  const raw = await getRedis().get(`otp:${email.toLowerCase()}`);
  assert.ok(
    raw,
    `no one-time code at redis key otp:${email.toLowerCase()} — ` +
    "is the server on the same REDIS_URL as this check?",
  );
  const { code } = JSON.parse(raw) as { code: string; attempts: number };

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

  console.log(`\n✅ smoke check passed — ${passed} assertions`);
  console.log(`   test data is named "${SMOKE_PREFIX}-*" if you want to purge it.`);
  console.log(`   users left behind: A (${a.user_id}), minor (${minorSession.user_id}), reborn B (${reborn.user_id}).`);
}

// ponytail: uncovered on purpose — PATCH /users/me (a field write with no
// safety or ownership rule of its own) and context compression (it needs a
// dozen+ LLM turns to trip the window, which this check will not pay for).
// Both belong in a slower nightly run if they ever regress.

run()
  .then(() => disconnectRedis())
  .catch(async (err) => {
    console.error(`\n❌ smoke check FAILED after ${passed} passing assertions\n`);
    console.error(err instanceof Error ? err.message : err);
    await disconnectRedis().catch(() => {});
    process.exit(1);
  });
