/**
 * Delete memories extracted from Studio sessions so they rebuild correctly.
 *
 *   npm run purge:studio-memories          # dry run — counts and samples only
 *   npm run purge:studio-memories -- --yes # actually delete
 *
 * Why this exists: until per-mode extraction landed, every Studio session was
 * distilled with the companion prompt ("extract facts about the USER"). That
 * recorded the assistant's performance as biography — a character playing the
 * user's dismissive manager became a fact about their manager, and a horror
 * plot became something that happened to them. Those memories are retrieved and
 * stated back as true, so they are worse than having none.
 *
 * There is no migration that fixes them: the information needed to tell a real
 * fact from a rehearsed one is not in the memory row, only in the transcript.
 * Deleting is the honest option — the transcripts are untouched, so anything
 * genuinely worth keeping is re-extracted correctly the next time a session
 * with that character ends.
 *
 * Also removes usage summaries for studio characters. Those were always
 * companion-shaped ("relationship_trajectory") and are no longer generated for
 * studio, but any already written would still be injected into every turn.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { Character } from "../models/character.model.js";
import { Memory } from "../models/memory.model.js";
import { MemorySummary } from "../models/memory-summary.model.js";

const APPLY = process.argv.includes("--yes");

async function main(): Promise<void> {
  await connectDatabase();

  const studio = await Character.find({ mode: "studio" })
    .select("_id name studio_config user_id")
    .lean();

  if (studio.length === 0) {
    console.log("\nNo studio characters exist. Nothing to purge.\n");
    await mongoose.disconnect();
    return;
  }

  const ids = studio.map((c) => c._id);
  const [memoryCount, summaryCount] = await Promise.all([
    Memory.countDocuments({ character_id: { $in: ids } }),
    MemorySummary.countDocuments({ character_id: { $in: ids } }),
  ]);

  console.log(`\nStudio characters: ${studio.length}`);
  for (const c of studio) {
    const n = await Memory.countDocuments({ character_id: c._id });
    const kind = c.studio_config?.scenario_id ?? c.studio_config?.kind ?? "unknown";
    console.log(`  · ${c.name}  [${kind}]  ${n} memories`);
  }
  console.log(`\nTotal to delete: ${memoryCount} memories, ${summaryCount} usage summaries`);

  if (memoryCount > 0) {
    // Show what is actually there before removing it. If these read like real
    // facts about a person rather than practice notes, that is the bug this
    // script exists for.
    const sample = await Memory.find({ character_id: { $in: ids } })
      .select("content type")
      .limit(10)
      .lean();
    console.log("\nSample of what will be deleted:");
    for (const m of sample) console.log(`  · [${m.type}] ${m.content}`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --yes to delete.\n");
    await mongoose.disconnect();
    return;
  }

  const [mem, sum] = await Promise.all([
    Memory.deleteMany({ character_id: { $in: ids } }),
    MemorySummary.deleteMany({ character_id: { $in: ids } }),
  ]);

  console.log(
    `\nDeleted ${mem.deletedCount} memories and ${sum.deletedCount} usage summaries.`,
  );
  console.log("Transcripts are untouched — memories rebuild as sessions end.\n");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("purge failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
