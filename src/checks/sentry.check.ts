/**
 * Crash reporting sends what it should, and nothing it should not.
 *
 *   npm run check:sentry
 *
 * Offline: a local HTTP server stands in for Sentry and records what arrives.
 * It goes through the real SDK and the real logger hook, so it fails if errors
 * stop being reported, or if a user's email or words start leaking into one.
 */
import http from "node:http";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

const received: string[] = [];
const ingest = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
  req.on("end", () => { received.push(body); res.writeHead(200).end("{}"); });
});
await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
const { port } = ingest.address() as AddressInfo;

process.env["SENTRY_DSN"] = `http://publickey@127.0.0.1:${port}/1`;
process.env["JWT_SECRET"] ??= "check-only-secret-not-used-anywhere-real";
process.env["MONGODB_URI"] ??= "mongodb://unused/check";
process.env["REDIS_URL"] ??= "redis://unused";
process.env["OPENAI_API_KEY"] ??= "unused";

// Dynamic: env.js must read the values above, and static imports run first.
const { initSentry, flushSentry } = await import("../config/sentry.js");
const { logger } = await import("../utils/logger.js");

assert.equal(initSentry(), true, "a DSN must enable reporting");

const EMAIL = "someone@example.com";
const WORDS = "the private thing the user said";
logger.error({ err: new Error("probe: server fault"), email: EMAIL, message: WORDS }, "probe failed");
logger.error({ err: Object.assign(new Error("probe: bad request"), { statusCode: 400 }) }, "client mistake");
logger.warn({ err: new Error("probe: only a warning") }, "warning");
logger.error("an error line with no error object");
await flushSentry(5000);
ingest.close();

// Each envelope is newline-delimited JSON: a header, then item header / payload
// pairs. Sentry also attaches the source lines around each stack frame, and
// this file's source contains every probe string, so that code is stripped
// before searching. What is left is the data that was actually sent.
const events = received.flatMap((body) => {
  const lines = body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return lines.flatMap((line, i) => (line["type"] === "event" ? [lines[i + 1]!] : []));
});
const all = JSON.stringify(events, (key, value) =>
  key === "pre_context" || key === "context_line" || key === "post_context" ? undefined : value,
);
assert.equal(events.length, 1, `expected exactly 1 event, got ${events.length}`);
assert.ok(all.includes("probe: server fault"), "a logged server error must be reported");
assert.ok(all.includes('"log":"probe failed"'), "the log line's message must travel with it");
assert.ok(!all.includes("an error line with no error object"), "an error line without an error object must not be reported");
assert.ok(!all.includes("probe: bad request"), "a 4xx is the caller's mistake and must not be reported");
assert.ok(!all.includes("probe: only a warning"), "warnings must not be reported");
assert.ok(!all.includes(EMAIL), "an email address from the log fields reached Sentry");
assert.ok(!all.includes(WORDS), "a user's words from the log fields reached Sentry");

console.log("  ✓ a logged server error reaches Sentry, with its log message");
console.log("  ✓ 4xx errors, warnings and error lines without an error are not reported");
console.log("  ✓ no email or user text from the log fields leaves the server");
console.log("\nsentry check passed");
process.exit(0);
