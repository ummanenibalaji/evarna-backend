/**
 * Offline check for the auth trust boundary and the age rules.
 *
 *   npm run check:auth
 *
 * Deliberately needs no MongoDB, no Redis and no network: it exercises the
 * pure logic where a mistake is silent and expensive — token forgery, token
 * reuse after sign-out, and the age thresholds that gate access and content.
 * The parts that need a live database (ownership 404s) are covered by
 * `npm run smoke`, which is slower and spends API credit.
 */
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

import { SignJWT } from "jose";

// Dynamic, not static: ESM evaluates every static import before the module body
// runs, so a top-level `import` of anything that reads config/env.js would blow
// up on the missing vars this file just set above.
const { issueSessionToken, verifySessionToken, assertEmailDeliverable } = await import(
  "../services/auth.service.js"
);
const { ageInYears, isMinorNow, isUnderMinimumAge, MIN_AGE_YEARS } = await import("../utils/age.js");

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

async function rejects(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.error(`  ✗ ${label} — it was ACCEPTED`);
    failures++;
  } catch {
    console.log(`  ✓ ${label}`);
  }
}

// Fixed "now" so a test never changes meaning on a birthday or a leap year.
const NOW = new Date("2026-08-21T12:00:00Z");
const yearsAgo = (n: number, offsetDays = 0): Date =>
  new Date(Date.UTC(NOW.getUTCFullYear() - n, NOW.getUTCMonth(), NOW.getUTCDate() + offsetDays));

async function main(): Promise<void> {
  const USER = "68a1b2c3d4e5f60718293a4b";
  const secret = new TextEncoder().encode(process.env["JWT_SECRET"]!);

  console.log("\nSession tokens");
  const token = await issueSessionToken(USER, 3);
  const claims = await verifySessionToken(token);
  check("round-trips the user id", claims.userId === USER);
  check("round-trips the token version", claims.tokenVersion === 3);

  // The version is what makes "sign out everywhere" work: the middleware
  // compares it against the user document and rejects a mismatch. If this
  // stopped being carried, revocation would silently become a no-op.
  check("token version is carried, not defaulted", (await verifySessionToken(await issueSessionToken(USER, 9))).tokenVersion === 9);

  await rejects("rejects a tampered payload", async () => {
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "000000000000000000000000", v: 0 })).toString("base64url");
    return verifySessionToken(`${h}.${forged}.${s}`);
  });

  await rejects("rejects a token signed with a different secret", async () =>
    verifySessionToken(
      await new SignJWT({ v: 0 })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER)
        .setIssuer("evarna")
        .setAudience("evarna-app")
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode("a-different-secret-entirely")),
    ),
  );

  await rejects("rejects a token from the wrong issuer", async () =>
    verifySessionToken(
      await new SignJWT({ v: 0 })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER)
        .setIssuer("somebody-else")
        .setAudience("evarna-app")
        .setExpirationTime("30d")
        .sign(secret),
    ),
  );

  await rejects("rejects a token for the wrong audience", async () =>
    verifySessionToken(
      await new SignJWT({ v: 0 })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER)
        .setIssuer("evarna")
        .setAudience("some-other-app")
        .setExpirationTime("30d")
        .sign(secret),
    ),
  );

  await rejects("rejects an expired token", async () =>
    verifySessionToken(
      await new SignJWT({ v: 0 })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER)
        .setIssuer("evarna")
        .setAudience("evarna-app")
        .setExpirationTime(Math.floor(NOW.getTime() / 1000) - 60)
        .sign(secret),
    ),
  );

  // "alg": "none" is the oldest JWT attack there is. jose refuses it, but this
  // asserts the refusal rather than assuming it.
  await rejects("rejects an unsigned (alg=none) token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: USER, v: 0, iss: "evarna", aud: "evarna-app", exp: 9999999999 }),
    ).toString("base64url");
    return verifySessionToken(`${header}.${payload}.`);
  });

  await rejects("rejects a token with no subject", async () =>
    verifySessionToken(
      await new SignJWT({ v: 0 })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("evarna")
        .setAudience("evarna-app")
        .setExpirationTime("30d")
        .sign(secret),
    ),
  );

  console.log("\nAge rules");
  check("age is computed from the date, not the year", ageInYears(yearsAgo(18, 1), NOW) === 17);
  check("a birthday today counts", ageInYears(yearsAgo(18), NOW) === 18);

  check(`${MIN_AGE_YEARS - 1}-year-old is under the access floor`, isUnderMinimumAge(yearsAgo(MIN_AGE_YEARS - 1), NOW));
  check(`${MIN_AGE_YEARS}-year-old is allowed in`, !isUnderMinimumAge(yearsAgo(MIN_AGE_YEARS), NOW));
  check("someone one day short of the floor is refused", isUnderMinimumAge(yearsAgo(MIN_AGE_YEARS, 1), NOW));

  check("15-year-old is still a minor for content purposes", isMinorNow(yearsAgo(15), NOW));
  check("17-year-old is a minor", isMinorNow(yearsAgo(17), NOW));
  check("18-year-old is not a minor", !isMinorNow(yearsAgo(18), NOW));
  // The whole reason this function exists: the stored is_minor flag never
  // changed, so a user who turned 18 stayed restricted for life.
  check("someone one day past 18 is no longer restricted", !isMinorNow(yearsAgo(18, -1), NOW));
  check("a missing date of birth is not treated as a minor", !isMinorNow(undefined, NOW));

  console.log("\nPublic route allowlist");
  const { PUBLIC_ROUTES_FOR_TEST } = await import("../middleware/auth.js");
  const expected = [
    "/health",
    "/api/v1/auth/google",
    "/api/v1/auth/apple",
    "/api/v1/auth/email/request",
    "/api/v1/auth/email/verify",
    "/api/v1/voice/voices",
  ].sort();
  const actual = [...PUBLIC_ROUTES_FOR_TEST].sort();
  // Pinned exactly. Adding a route here means anyone on the internet can call
  // it, so it should be a deliberate edit to this list too — not something that
  // slips in unnoticed.
  check(
    `allowlist is exactly the ${expected.length} intended routes`,
    JSON.stringify(actual) === JSON.stringify(expected),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }

  console.log("\nEmail code delivery");

  // Sign-in used to report `sent: true` with no mail provider configured, so a
  // production deploy that forgot the key looked healthy while nobody could
  // get in. These two assertions are the whole guard.
  const boots = (nodeEnv: string, key: string): boolean => {
    try {
      assertEmailDeliverable(nodeEnv, key);
      return true;
    } catch {
      return false;
    }
  };

  check("production refuses to boot with no mail provider", !boots("production", ""));
  check("production boots once a provider is configured", boots("production", "re_test_key"));
  check("development still runs without one", boots("development", ""));

  console.log(
    failures === 0
      ? "\nAll auth checks passed.\n"
      : `\n${failures} auth check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("auth check crashed:", err);
  process.exit(1);
});
