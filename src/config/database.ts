import dns from "node:dns";
import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

// Some local VPN/DNS proxies leave Node's resolver pointed at a loopback
// address that refuses SRV queries, which breaks Atlas mongodb+srv:// lookups
// (querySrv ECONNREFUSED). Fall back to public DNS only in that case.
function ensureResolvableDns(): void {
  const loopback = dns.getServers().every((s) => s.startsWith("127.") || s === "::1");
  if (loopback) {
    dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
    logger.warn("DNS resolver was loopback-only; switched to public DNS for SRV lookups");
  }
}

export async function connectDatabase(): Promise<void> {
  ensureResolvableDns();


  mongoose.connection.on("connected", () =>
    logger.info("MongoDB connected")
  );
  mongoose.connection.on("disconnected", () =>
    logger.warn("MongoDB disconnected")
  );
  mongoose.connection.on("error", (err) =>
    logger.error({ err }, "MongoDB connection error")
  );

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

// ─── Atlas Vector Search index status ────────────────────────────────────────
// Long-term memory recall depends entirely on this index. Without it,
// $vectorSearch throws, retrieveMemories() swallows the error, and every
// conversation runs with no memory — with no user-visible symptom. So the
// status is recorded here and surfaced on GET /health rather than being
// buried in a startup log line nobody reads.

export type VectorIndexStatus =
  | "ready"        // index exists and is queryable — memory recall works
  | "not_ready"    // index exists but is still building — recall fails for now
  | "missing"      // index absent — recall is dead until it is created
  | "unverified";  // could not check (non-Atlas MongoDB, or db not up yet)

// The mongo driver types listSearchIndexes() as { name: string }, but Atlas
// also returns status/queryable. Widen it rather than reaching past the types.
interface SearchIndexInfo {
  name?: string;
  status?: string;
  queryable?: boolean;
}

let vectorIndexStatus: VectorIndexStatus = "unverified";

export function getVectorIndexStatus(): VectorIndexStatus {
  return vectorIndexStatus;
}

// Call this after connectDatabase(). In production a missing index is fatal:
// better to refuse to boot than to serve a companion that has quietly lost its
// memory. A still-building index is transient, so it only warns (exiting there
// would crash-loop for the duration of the index build).
export async function checkVectorSearchIndex(): Promise<VectorIndexStatus> {
  const INDEX_NAME = "memory_vector_index";
  const COLLECTION = "memories";

  try {
    const db = mongoose.connection.db;
    if (!db) {
      logger.warn("checkVectorSearchIndex: db not available yet — skipping");
      vectorIndexStatus = "unverified";
      return vectorIndexStatus;
    }

    // listSearchIndexes() is Atlas-only; on local MongoDB it may throw.
    const indexes = (await db
      .collection(COLLECTION)
      .listSearchIndexes()
      .toArray()) as SearchIndexInfo[];
    const idx = indexes.find((i) => i.name === INDEX_NAME);

    if (!idx) {
      vectorIndexStatus = "missing";
      logger.error(
        `\n${"=".repeat(70)}\n` +
        `⚠️  ATLAS VECTOR SEARCH INDEX "${INDEX_NAME}" NOT FOUND\n` +
        `   Memory retrieval will silently return empty on every conversation.\n` +
        `   The memory moat is DISABLED until you create this index.\n\n` +
        `   Fix: Atlas UI → your cluster → Search → Create Search Index\n` +
        `        Collection: ${COLLECTION} | Index name: ${INDEX_NAME}\n` +
        `        See README §4 for the exact JSON definition.\n` +
        `${"=".repeat(70)}`
      );
      if (env.NODE_ENV === "production") {
        logger.error("Refusing to start in production without the vector search index");
        process.exit(1);
      }
      return vectorIndexStatus;
    }

    if (idx.status !== "READY") {
      vectorIndexStatus = "not_ready";
      logger.warn(
        { status: idx.status ?? "unknown" },
        `Atlas Vector Search index "${INDEX_NAME}" exists but status is ${idx.status ?? "unknown"} — memory retrieval will fail until it becomes READY`
      );
      return vectorIndexStatus;
    }

    vectorIndexStatus = "ready";
    logger.info(`Atlas Vector Search index "${INDEX_NAME}" is READY — memory retrieval active`);
    return vectorIndexStatus;
  } catch (err) {
    // Non-Atlas MongoDB (local dev without Atlas) will throw "not supported".
    // Don't exit even in production — crashing over a driver quirk on an
    // otherwise healthy database is worse than flagging it on /health.
    vectorIndexStatus = "unverified";
    logger.warn(
      { err },
      `Could not verify Atlas Vector Search index "${INDEX_NAME}" — ` +
      "this is expected on local/non-Atlas MongoDB. Memory retrieval may fail on Atlas if the index is missing."
    );
    return vectorIndexStatus;
  }
}
