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
const { PUBLIC_ROUTES_FOR_TEST } = await import("../middleware/auth.js");

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

await app.close();

console.log(
  failures === 0
    ? `\nAll ${routes.length} routes behave correctly.\n`
    : `\n${failures} route check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
