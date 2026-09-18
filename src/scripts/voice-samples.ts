/**
 * Render each catalog voice's preview line to an MP3 the app ships with.
 *
 *   npm run voice:samples                       # writes ../evarna-frontend/assets/voices
 *   npm run voice:samples -- --out <directory>
 *
 * Onboarding promises "tap any voice to hear a preview". The previews are
 * rendered once, with the same Hume voices and model the live call uses, and
 * bundled — a preview needs no network, no session and costs nothing per tap.
 * Each voice also gets a greeting with no name in it, which the Meet screen
 * plays: the preview says "I'm Maya", but the user may name the companion
 * anything. Re-run after changing EVARNA_VOICES or HUME_VOICE_MAP.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVARNA_VOICES, resolveHumeVoice } from "../data/voices.js";

const outFlag = process.argv.indexOf("--out");
const outDir = resolve(outFlag !== -1 && process.argv[outFlag + 1] ? process.argv[outFlag + 1]! : "../evarna-frontend/assets/voices");

const GREETING = "Hi. It's really good to finally meet you.";

async function main(): Promise<void> {
  const apiKey = process.env["HUME_API_KEY"];
  if (!apiKey) throw new Error("HUME_API_KEY is not set");
  mkdirSync(outDir, { recursive: true });

  for (const voice of EVARNA_VOICES) {
    for (const [suffix, text] of [["", voice.previewText], ["-greeting", GREETING]] as const) {
      const res = await fetch("https://api.hume.ai/v0/tts/file", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hume-Api-Key": apiKey },
        body: JSON.stringify({
          utterances: [{ text, voice: resolveHumeVoice(voice.id) }],
          format: { type: "mp3" },
          version: "2",
        }),
      });
      if (!res.ok) throw new Error(`${voice.name}: Hume responded ${res.status} ${await res.text()}`);
      const audio = Buffer.from(await res.arrayBuffer());
      const file = resolve(outDir, `${voice.id}${suffix}.mp3`);
      writeFileSync(file, audio);
      console.log(`  ${voice.name.padEnd(6)} ${(audio.length / 1024).toFixed(0).padStart(3)} KB  ${file}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
