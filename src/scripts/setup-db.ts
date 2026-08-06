/**
 * One-shot database bootstrap for a fresh MongoDB Atlas cluster.
 *
 *   npm run setup:db
 *
 * Idempotent — safe to re-run. It:
 *   1. connects using MONGODB_URI from .env
 *   2. creates the `memories` collection if absent
 *      (Atlas cannot create a search index on a collection that doesn't exist)
 *   3. creates the `memory_vector_index` Atlas Vector Search index
 *   4. waits for that index to reach READY
 *   5. builds the regular Mongoose indexes declared on the models
 *
 * Step 3 is the one that is easy to forget and impossible to notice: without it
 * $vectorSearch throws, retrieveMemories() swallows the error, and every
 * conversation runs with no long-term memory and no visible symptom.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";

// Must match memory-retrieval.service.ts and config/database.ts.
const INDEX_NAME = "memory_vector_index";
const COLLECTION = "memories";

// 1536 dims = OpenAI text-embedding-3-small (see MODELS.EMBEDDING).
// The two filter fields are the ones retrieveMemories() filters on; a filter
// field must be declared in the index or the query fails.
const INDEX_DEFINITION = {
  fields: [
    { type: "vector", path: "embedding", numDimensions: 1536, similarity: "cosine" },
    { type: "filter", path: "character_id" },
    { type: "filter", path: "is_deleted" },
  ],
};

const READY_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SearchIndexInfo {
  name?: string;
  status?: string;
  queryable?: boolean;
}

async function main(): Promise<void> {
  // Show which cluster/db we are about to touch, with credentials stripped.
  const redacted = env.MONGODB_URI.replace(/\/\/[^@]*@/, "//<credentials>@");
  console.log(`connecting to ${redacted}`);

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error("connected but no database handle — is a database name present in MONGODB_URI?");

  console.log(`✓ connected — database "${db.databaseName}"`);

  // ── 1. collection ─────────────────────────────────────────────────────────
  const existing = await db.listCollections({ name: COLLECTION }).toArray();
  if (existing.length === 0) {
    await db.createCollection(COLLECTION);
    console.log(`✓ created collection "${COLLECTION}"`);
  } else {
    console.log(`· collection "${COLLECTION}" already exists`);
  }

  const collection = db.collection(COLLECTION);

  // ── 2. vector search index ────────────────────────────────────────────────
  let indexes: SearchIndexInfo[];
  try {
    indexes = (await collection.listSearchIndexes().toArray()) as SearchIndexInfo[];
  } catch (err) {
    console.error(
      "\n✗ This cluster does not support Atlas Search index management.\n" +
      "  Atlas Vector Search requires a real Atlas cluster (M0 free tier is fine).\n" +
      "  A local/self-hosted mongod cannot do vector search — long-term memory\n" +
      "  recall will not work against it.\n",
    );
    throw err;
  }

  if (indexes.some((i) => i.name === INDEX_NAME)) {
    console.log(`· search index "${INDEX_NAME}" already exists`);
  } else {
    await collection.createSearchIndex({
      name: INDEX_NAME,
      type: "vectorSearch",
      definition: INDEX_DEFINITION,
    });
    console.log(`✓ created search index "${INDEX_NAME}"`);
  }

  // ── 3. wait for READY ─────────────────────────────────────────────────────
  console.log("waiting for the index to become READY (usually 1-2 min)…");
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let status = "UNKNOWN";

  while (Date.now() < deadline) {
    const current = (await collection.listSearchIndexes().toArray()) as SearchIndexInfo[];
    status = current.find((i) => i.name === INDEX_NAME)?.status ?? "UNKNOWN";
    if (status === "READY") break;
    if (status === "FAILED") throw new Error(`index "${INDEX_NAME}" build FAILED — check the Atlas UI`);
    process.stdout.write(`  status: ${status}\r`);
    await sleep(POLL_MS);
  }

  if (status !== "READY") {
    console.log(
      `\n⚠️  index is still "${status}" after ${READY_TIMEOUT_MS / 1000}s.\n` +
      "   It will most likely finish on its own — check GET /health later.",
    );
  } else {
    console.log(`\n✓ index "${INDEX_NAME}" is READY — memory recall will work`);
  }

  // ── 4. regular model indexes ──────────────────────────────────────────────
  // The Mongoose schemas declare compound indexes that otherwise only get built
  // lazily. Import the models so their schemas register, then sync.
  await import("../models/user.model.js");
  await import("../models/character.model.js");
  await import("../models/session.model.js");
  await import("../models/conversation-turn.model.js");
  await import("../models/memory.model.js");
  await import("../models/memory-summary.model.js");

  for (const name of Object.keys(mongoose.models)) {
    await mongoose.models[name]!.syncIndexes();
  }
  console.log(`✓ synced indexes for ${Object.keys(mongoose.models).length} models`);

  await mongoose.disconnect();
  console.log("\nDone. Next: npm run dev, then curl localhost:3000/health");
}

main().catch(async (err) => {
  console.error("\n✗ setup failed:", err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
