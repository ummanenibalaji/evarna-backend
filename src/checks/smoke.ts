/**
 * End-to-end smoke check against a RUNNING server.
 *
 *   npm run dev                # terminal 1
 *   npm run smoke              # terminal 2
 *   SMOKE_BASE_URL=https://api-staging.evarna.app npm run smoke
 *
 * ⚠️  This talks to whatever MONGODB_URI / OPENAI_API_KEY the server was started
 * with. It creates real users and spends real OpenAI credits (a few cents).
 * Every user it creates is named with the SMOKE_PREFIX below so test data is
 * easy to find and purge.
 *
 * It asserts the things that broke before, so a regression fails here loudly:
 *   - display_name is what the client sent  (the "every user is Aria" bug)
 *   - text turns persist                     (memory extraction depends on it)
 *   - memories are produced from a session   (the memory moat)
 *   - the crisis path returns hotline info   (safety)
 *   - minors are blocked from `partner`      (safety)
 *   - voice sessions are billed by real duration, not the 30-min sweep
 */
import assert from "node:assert/strict";

const BASE_URL = process.env["SMOKE_BASE_URL"] ?? "http://localhost:3000";
const API = `${BASE_URL}/api/v1`;
const SMOKE_PREFIX = "smoke-test";

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

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: { success?: boolean; data?: T; error?: string } }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: { success?: boolean; data?: T; error?: string };
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} → ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

/** Sends a chat turn and collects the SSE events the server emits. */
async function sendMessage(
  payload: { session_id: string; character_id: string; user_id: string; message: string },
): Promise<{ chunks: string[]; crisis: string[]; turnId: string | null; errors: string[] }> {
  const res = await fetch(`${API}/conversations/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
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

async function run(): Promise<void> {
  console.log(`smoke check → ${BASE_URL}`);

  // ── health ────────────────────────────────────────────────────────────────
  step("health");
  const health = await fetch(`${BASE_URL}/health`);
  assert.equal(health.status, 200, "server is not reachable — is `npm run dev` running?");
  const healthBody = (await health.json()) as { status: string; vector_index?: string };
  assert.equal(healthBody.status, "ok");
  ok("server is up");

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

  // ── onboarding ────────────────────────────────────────────────────────────
  step("onboarding");
  const expectedName = `${SMOKE_PREFIX}-${Date.now()}`;
  const onboard = await api<{ user_id: string; character_id: string; is_minor: boolean }>(
    "POST",
    "/users/onboard",
    {
      display_name: expectedName,
      gender: "nonbinary",
      date_of_birth: "1995-01-01",
      communication_style: "warm",
      intent: "smoke test",
      companion: { name: "Maya", archetype: "bestfriend", gender: "female", voice_id: "c050bc97-0e14-44ba-8c23-ae353fee972d" },
    },
  );
  assert.equal(onboard.status, 201, `onboard failed: ${JSON.stringify(onboard.json)}`);
  const userId = onboard.json.data!.user_id;
  const characterId = onboard.json.data!.character_id;
  assert.ok(userId && characterId, "onboard did not return ids");
  assert.equal(onboard.json.data!.is_minor, false, "1995 DOB must not be a minor");
  ok("user + companion created");

  // Regression guard for the "every user is called Aria" bug: the name the
  // client sent must be the name that was stored.
  const fetched = await api<{ display_name: string }>("GET", `/users/${userId}`);
  assert.equal(fetched.status, 200);
  assert.equal(
    fetched.json.data!.display_name,
    expectedName,
    "display_name was not persisted as sent — the client is substituting a placeholder name",
  );
  ok(`display_name round-trips ("${expectedName}")`);

  // ── minor safety ──────────────────────────────────────────────────────────
  step("minor protections");
  const minorDob = new Date();
  minorDob.setFullYear(minorDob.getFullYear() - 15);
  const minor = await api<{ user_id: string; is_minor: boolean }>("POST", "/users/onboard", {
    display_name: `${SMOKE_PREFIX}-minor-${Date.now()}`,
    gender: "female",
    date_of_birth: minorDob.toISOString().slice(0, 10),
    communication_style: "calm",
    intent: "smoke test minor",
    companion: { name: "Iris", archetype: "mentor", gender: "female", voice_id: "3cd1f2e8-12f0-48b5-ade4-9e06241b8252" },
  });
  assert.equal(minor.status, 201, `minor onboard failed: ${JSON.stringify(minor.json)}`);
  assert.equal(minor.json.data!.is_minor, true, "a 15-year-old DOB must set is_minor");
  ok("is_minor derived from date of birth");

  const minorPartner = await api("POST", "/characters/create", {
    user_id: minor.json.data!.user_id,
    archetype: "partner",
    gender: "male",
    voice_id: "944adf80-0d6e-4909-b6fa-078784d6f8c5",
    name: "Kai",
  });
  assert.equal(minorPartner.status, 400, "a minor must not be able to create a `partner` companion");
  ok("partner archetype blocked for minors");

  // ── text conversation ─────────────────────────────────────────────────────
  step("text conversation");
  const session = await api<{ session_id: string }>("POST", "/sessions/start", {
    user_id: userId,
    character_id: characterId,
    session_type: "text",
  });
  assert.equal(session.status, 201, `session start failed: ${JSON.stringify(session.json)}`);
  const sessionId = session.json.data!.session_id;
  ok("session started");

  const turn = await sendMessage({
    session_id: sessionId,
    character_id: characterId,
    user_id: userId,
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
  );
  assert.equal(turns.status, 200);
  const roles = turns.json.data!.turns.map((t) => t.role);
  assert.ok(roles.includes("user"), "user turn was not persisted");
  assert.ok(roles.includes("assistant"), "assistant turn was not persisted");
  ok(`both turns persisted (${roles.join(", ")})`);

  // ── crisis path ───────────────────────────────────────────────────────────
  step("crisis safety path");
  const crisisSession = await api<{ session_id: string }>("POST", "/sessions/start", {
    user_id: userId,
    character_id: characterId,
    session_type: "text",
  });
  const crisisTurn = await sendMessage({
    session_id: crisisSession.json.data!.session_id,
    character_id: characterId,
    user_id: userId,
    message: "I don't want to be alive anymore. I've been thinking about killing myself.",
  });
  const crisisText = [...crisisTurn.crisis, ...crisisTurn.chunks].join("");
  assert.ok(
    crisisTurn.crisis.length > 0,
    "self-harm message did not trigger the `crisis` event — moderation or the crisis threshold is broken",
  );
  assert.ok(crisisText.includes("988"), "crisis response must include the 988 lifeline");
  ok("self-harm message routed to crisis resources");
  await api("POST", `/sessions/${crisisSession.json.data!.session_id}/end`, {});

  // ── session end + memory extraction ───────────────────────────────────────
  step("session end → memory extraction");
  const ended = await api<{ duration_seconds: number }>("POST", `/sessions/${sessionId}/end`, {});
  assert.equal(ended.status, 200, `session end failed: ${JSON.stringify(ended.json)}`);
  assert.ok(typeof ended.json.data!.duration_seconds === "number", "no duration returned");
  ok(`session ended (${ended.json.data!.duration_seconds}s)`);

  console.log(`    waiting up to ${MEMORY_TIMEOUT_MS / 1000}s for the extraction job…`);
  const deadline = Date.now() + MEMORY_TIMEOUT_MS;
  let memories: Array<{ content: string; type: string }> = [];
  while (Date.now() < deadline) {
    await sleep(MEMORY_POLL_MS);
    const res = await api<Array<{ content: string; type: string }>>("GET", `/memories/${characterId}`);
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

  // ── recall on a fresh session ─────────────────────────────────────────────
  //
  // Atlas Vector Search is EVENTUALLY consistent. GET /memories reads MongoDB
  // directly and sees a new memory immediately, but $vectorSearch cannot query
  // it until the search index catches up — a few seconds after insert. So a
  // recall attempt fired straight after extraction legitimately returns
  // nothing. Give the index a head start, then retry before failing; do not
  // replace this with a single fixed sleep, it just moves the flakiness.
  step("recall in a new session");
  const RECALL_ATTEMPTS = 3;
  const RECALL_BACKOFF_MS = 8_000;
  const RECALLS = /priya|wedding|marry|marriage|october|sister/i;

  let recalled = false;
  let lastReply = "";

  for (let attempt = 1; attempt <= RECALL_ATTEMPTS; attempt++) {
    console.log(`    waiting ${RECALL_BACKOFF_MS / 1000}s for the search index to catch up…`);
    await sleep(RECALL_BACKOFF_MS);

    const s = await api<{ session_id: string }>("POST", "/sessions/start", {
      user_id: userId,
      character_id: characterId,
      session_type: "text",
    });
    const t = await sendMessage({
      session_id: s.json.data!.session_id,
      character_id: characterId,
      user_id: userId,
      message: "Do you remember what I told you about my sister?",
    });
    await api("POST", `/sessions/${s.json.data!.session_id}/end`, {});

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

  // ── voice session billing ─────────────────────────────────────────────────
  step("voice session billing");
  const voiceSession = await api<{ session_id: string }>("POST", "/sessions/start", {
    user_id: userId,
    character_id: characterId,
    session_type: "voice_call",
  });
  assert.equal(voiceSession.status, 201);
  const voiceSessionId = voiceSession.json.data!.session_id;
  await sleep(2_000);
  const voiceEnded = await api<{ duration_seconds: number }>(
    "POST",
    `/sessions/${voiceSessionId}/end`,
    {},
  );
  assert.equal(voiceEnded.status, 200);
  const dur = voiceEnded.json.data!.duration_seconds;
  // The bug: nothing closed voice sessions, so the 30-minute stale sweep did it
  // and billed ~31 minutes for a 2-minute call. A short call must stay short.
  assert.ok(dur < 60, `a ~2s voice session reported ${dur}s — session end is not being honoured`);
  ok(`voice session billed on real duration (${dur}s)`);

  // Ending twice must not double-count.
  const endAgain = await api("POST", `/sessions/${voiceSessionId}/end`, {});
  assert.equal(endAgain.status, 404, "ending an already-ended session must be a no-op");
  ok("session end is idempotent");

  // ── stats ─────────────────────────────────────────────────────────────────
  step("stats");
  const stats = await api<{ total_sessions: number; total_memories: number; total_companions: number }>(
    "GET",
    `/users/${userId}/stats`,
  );
  assert.equal(stats.status, 200);
  assert.ok(stats.json.data!.total_sessions > 0, "sessions were not counted");
  assert.ok(stats.json.data!.total_memories > 0, "memories were not counted");
  ok(
    `stats: ${stats.json.data!.total_companions} companions, ` +
    `${stats.json.data!.total_sessions} sessions, ${stats.json.data!.total_memories} memories`,
  );

  console.log(`\n✅ smoke check passed — ${passed} assertions`);
  console.log(`   test data is named "${SMOKE_PREFIX}-*" if you want to purge it.`);
}

run().catch((err) => {
  console.error(`\n❌ smoke check FAILED after ${passed} passing assertions\n`);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
