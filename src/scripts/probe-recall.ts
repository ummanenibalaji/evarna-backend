import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { retrieveMemories } from "../services/memory-retrieval.service.js";

async function main(): Promise<void> {
  const characterId = process.argv[2];
  const query = process.argv[3] ?? "Do you remember what I told you about my sister?";
  if (!characterId) throw new Error("usage: tsx src/scripts/probe-recall.ts <characterId> [query]");
  await mongoose.connect(env.MONGODB_URI);
  const block = await retrieveMemories(characterId, query);
  console.log("--- retrieveMemories result ---");
  console.log(block || "(EMPTY)");
  await mongoose.disconnect();
}
main().catch(async (e) => { console.error(e); await mongoose.disconnect().catch(() => {}); process.exit(1); });
