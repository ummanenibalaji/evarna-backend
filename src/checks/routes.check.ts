/**
 * Asserts the auth boundary across EVERY registered route.
 *
 *   npm run check:routes
 *
 * Needs no MongoDB, no Redis and no network: a request with no token is
 * rejected by the onRequest hook before any handler or database call runs, so
 * the whole app can be built and injected against in-process.
 *
 * Routes are enumerated from Fastify rather than listed by hand, so a route
 * added later is covered automatically — adding an unprotected endpoint fails
 * this check instead of shipping quietly.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

// Dynamic: ESM evaluates every static import before the module body, which
// would read config/env.js before the defaults above are set.
const { buildApp } = await import("../app.js");
const { PUBLIC_ROUTES_FOR_TEST, SELF_AUTHENTICATED_ROUTES_FOR_TEST } = await import("../middleware/auth.js");
const { issueSessionToken } = await import("../services/auth.service.js");

interface RouteRow { method: string; url: string }

let failures = 0;
const pass = (label: string): void => { console.log(`  ✓ ${label}`); };
const fail = (label: string, detail: string): void => {
  console.error(`  ✗ ${label}\n      ${detail}`);
  failures++;
};

// A concrete value for every path parameter so the router matches. It never
// reaches a handler on the unauthenticated path — the hook rejects first — but
// the URL still has to route somewhere.
const concreteUrl = (url: string): string =>
  url.replace(/:[A-Za-z_]+/g, "000000000000000000000000");

const captured: RouteRow[] = [];
const app = await buildApp({ onRoute: (r) => captured.push(r) });
await app.ready();

// HEAD is auto-generated alongside GET and shares its hooks; OPTIONS is
// answered by @fastify/cors ahead of our hook and carries no data.
const routes = captured.filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS");

console.log(`\nDiscovered ${routes.length} routes`);

console.log("\nAllowlisted routes must be reachable without a token");
for (const url of PUBLIC_ROUTES_FOR_TEST) {
  const row = routes.find((r) => r.url === url);
  if (!row) {
    fail(`${url} is on the allowlist`, "but no such route is registered — stale allowlist entry");
    continue;
  }
  const res = await app.inject({ method: row.method as "GET", url, payload: row.method === "GET" ? undefined : {} });
  if (res.statusCode === 401) {
    fail(`${row.method} ${url} should be public`, "got 401 — the allowlist is not taking effect");
  } else {
    pass(`${row.method} ${url} → ${res.statusCode}, not 401`);
  }
}

console.log("\nEvery other route must refuse an unauthenticated request");
const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES_FOR_TEST.has(r.url));
for (const row of protectedRoutes) {
  const res = await app.inject({
    method: row.method as "GET",
    url: concreteUrl(row.url),
    payload: row.method === "GET" || row.method === "DELETE" ? undefined : {},
  });
  if (res.statusCode !== 401) {
    fail(
      `${row.method} ${row.url} does NOT require authentication`,
      `got ${res.statusCode}, expected 401. Either add it to PUBLIC_ROUTES deliberately, or find out why the hook skipped it.`,
    );
  } else {
    pass(`${row.method} ${row.url} → 401`);
  }
}

console.log("\nA forged token is refused");
for (const row of protectedRoutes.slice(0, 3)) {
  const res = await app.inject({
    method: row.method as "GET",
    url: concreteUrl(row.url),
    headers: { authorization: "Bearer not-a-real-token" },
    payload: row.method === "GET" || row.method === "DELETE" ? undefined : {},
  });
  if (res.statusCode !== 401) {
    fail(`${row.method} ${row.url} accepted a forged token`, `got ${res.statusCode}, expected 401`);
  } else {
    pass(`${row.method} ${row.url} rejects a forged token`);
  }
}

// Behind a load balancer, request.ip must be the user, or the per-IP limit on
// sign-in codes is one limit for the whole app. With no proxy configured it must
// ignore X-Forwarded-For, or anyone can forge their way past that limit.
console.log("\nClient IP behind a proxy");
{
  const { parseTrustProxy } = await import("../app.js");
  const { default: Fastify } = await import("fastify");
  const ipFor = async (setting: string): Promise<string> => {
    const probe = Fastify({ trustProxy: parseTrustProxy(setting) });
    probe.get("/ip", async (req) => req.ip);
    const res = await probe.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "203.0.113.9" } });
    await probe.close();
    return res.body;
  };
  const trusted = await ipFor("1");
  trusted === "203.0.113.9"
    ? pass("TRUST_PROXY=1 uses the forwarded client address")
    : fail("TRUST_PROXY=1 uses the forwarded client address", `got ${trusted}`);
  const direct = await ipFor("");
  direct !== "203.0.113.9"
    ? pass("unset TRUST_PROXY ignores a client-supplied X-Forwarded-For")
    : fail("unset TRUST_PROXY ignores a client-supplied X-Forwarded-For", "a forged header was trusted");
  const parsed = [parseTrustProxy("false"), parseTrustProxy("true"), parseTrustProxy("2"), parseTrustProxy("10.0.0.0/8")];
  JSON.stringify(parsed) === JSON.stringify([false, true, 2, "10.0.0.0/8"])
    ? pass("TRUST_PROXY parses booleans, hop counts and address ranges")
    : fail("TRUST_PROXY parses booleans, hop counts and address ranges", JSON.stringify(parsed));
}

// The hook skips these, so the handler is the only thing standing between the
// internet and the conversation pipeline. It must refuse an app session token:
// that token is valid everywhere else, and the voice-model token travels
// through a third party.
console.log("\nSelf-authenticated routes accept only their own token");
const appToken = await issueSessionToken("000000000000000000000000", 0);
for (const url of SELF_AUTHENTICATED_ROUTES_FOR_TEST) {
  const row = routes.find((r) => r.url === url);
  if (!row) {
    fail(`${url} is self-authenticated`, "but no such route is registered");
    continue;
  }
  const res = await app.inject({ method: row.method as "POST", url, headers: { authorization: `Bearer ${appToken}` }, payload: {} });
  if (res.statusCode !== 401) {
    fail(`${row.method} ${url} accepted an app session token`, `got ${res.statusCode}, expected 401`);
  } else {
    pass(`${row.method} ${url} refuses an app session token`);
  }
}

await app.close();

console.log(
  failures === 0
    ? `\nAll ${routes.length} routes behave correctly.\n`
    : `\n${failures} route check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
