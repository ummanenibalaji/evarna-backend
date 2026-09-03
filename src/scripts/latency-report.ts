/**
 * Reads the per-turn latency lines emitted by VoiceTurnTimer and prints P50 and
 * P95 for the whole pipeline and for each stage.
 *
 * Usage:
 *   npm run latency-report -- <logfile> [<logfile> ...]
 *   npm run voice-worker | tee voice.log      # then point this at voice.log
 *   cat voice.log | npm run latency-report    # stdin also works
 *
 * The voice worker is the process that logs these, so its output is the file
 * you want. Lines that are not JSON, or are JSON but not latency lines, are
 * ignored — piping a whole mixed log at this is fine.
 *
 * Targets this reports against (the 90ms figure in the original brief is not
 * reachable — it is shorter than a single mobile network round trip):
 *   P50 ttfb under 800ms
 *   P95 ttfb under 1200ms
 */
import { readFileSync } from "node:fs";
import { VOICE_LATENCY_MSG } from "../services/voice-metrics.service.js";

const P50_TARGET_MS = 800;
const P95_TARGET_MS = 1200;

interface LatencyLine {
  msg?: string;
  roomName?: string;
  turn?: number;
  ttfb_ms?: number;
  stt_ms?: number | null;
  llm_ms?: number | null;
  tts_ms?: number | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  // Nearest-rank: with a handful of samples this is honest, where a smoothed
  // interpolation would invent precision the sample size cannot support.
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

function describe(label: string, values: number[], target?: number): string {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return `${label.padEnd(22)} no samples`;

  const sorted = [...usable].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

  const verdict =
    target === undefined ? "" : p50 <= target ? "  ✓ within target" : `  ✗ over ${target}ms target`;

  return (
    `${label.padEnd(22)} n=${String(usable.length).padEnd(5)} ` +
    `p50=${Math.round(p50).toString().padStart(5)}ms  ` +
    `p95=${Math.round(p95).toString().padStart(5)}ms  ` +
    `mean=${Math.round(mean).toString().padStart(5)}ms  ` +
    `min=${Math.round(sorted[0]!).toString().padStart(5)}ms  ` +
    `max=${Math.round(sorted[sorted.length - 1]!).toString().padStart(5)}ms${verdict}`
  );
}

function parse(text: string): LatencyLine[] {
  const out: LatencyLine[] = [];
  for (const line of text.split("\n")) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(start)) as LatencyLine;
      if (parsed.msg === VOICE_LATENCY_MSG && typeof parsed.ttfb_ms === "number") {
        out.push(parsed);
      }
    } catch {
      // Not a JSON log line — pino pretty output, a stack trace, whatever.
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  let text: string;
  if (files.length > 0) {
    text = files.map((f) => readFileSync(f, "utf8")).join("\n");
  } else if (!process.stdin.isTTY) {
    text = await readStdin();
  } else {
    console.error("usage: npm run latency-report -- <logfile> [...]  (or pipe a log on stdin)");
    process.exitCode = 1;
    return;
  }

  const rows = parse(text);
  if (rows.length === 0) {
    console.error(
      `No "${VOICE_LATENCY_MSG}" lines found.\n` +
        "These are emitted by the VOICE WORKER (npm run voice-worker), one per\n" +
        "answered turn. A call with no completed turns produces none.",
    );
    process.exitCode = 1;
    return;
  }

  const calls = new Set(rows.map((r) => r.roomName ?? "unknown"));

  console.log("");
  console.log("  Voice latency — end of their sentence to first sound back");
  console.log("  " + "─".repeat(94));
  console.log(`  ${rows.length} turns across ${calls.size} call(s)`);
  console.log("");
  console.log("  " + describe("ttfb (total)", rows.map((r) => r.ttfb_ms!), P50_TARGET_MS));
  console.log("  " + "─".repeat(94));
  console.log("  " + describe("  stt (speech→final)", rows.map((r) => r.stt_ms ?? NaN)));
  console.log("  " + describe("  llm (final→token)", rows.map((r) => r.llm_ms ?? NaN)));
  console.log("  " + describe("  tts (token→audio)", rows.map((r) => r.tts_ms ?? NaN)));
  console.log("");

  const ttfb = rows.map((r) => r.ttfb_ms!).sort((a, b) => a - b);
  const p50 = percentile(ttfb, 50);
  const p95 = percentile(ttfb, 95);
  console.log(`  Targets: p50 < ${P50_TARGET_MS}ms, p95 < ${P95_TARGET_MS}ms`);
  console.log(
    `  Result:  p50 ${Math.round(p50)}ms ${p50 <= P50_TARGET_MS ? "PASS" : "FAIL"}, ` +
      `p95 ${Math.round(p95)}ms ${p95 <= P95_TARGET_MS ? "PASS" : "FAIL"}`,
  );
  if (rows.length < 20) {
    console.log(`  Note:    ${rows.length} turns is a thin sample — the lane exit criteria ask for 20.`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
