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

// Call this after connectDatabase() to warn loudly if the Atlas Vector Search
// index is missing. Without it, memory retrieval silently returns empty results
// on every turn and the entire memory moat is dead.
export async function checkVectorSearchIndex(): Promise<void> {
  const INDEX_NAME = "memory_vector_index";
  const COLLECTION = "memories";

  try {
    const db = mongoose.connection.db;
    if (!db) {
      logger.warn("checkVectorSearchIndex: db not available yet — skipping");
      return;
    }

    // listSearchIndexes() is Atlas-only; on local MongoDB it may throw.
    const indexes = await db.collection(COLLECTION).listSearchIndexes().toArray();
    const idx = indexes.find((i) => i.name === INDEX_NAME);

    if (!idx) {
      logger.warn(
        `\n${"=".repeat(70)}\n` +
        `⚠️  ATLAS VECTOR SEARCH INDEX "${INDEX_NAME}" NOT FOUND\n` +
        `   Memory retrieval will silently return empty on every conversation.\n` +
        `   The memory moat is DISABLED until you create this index.\n\n` +
        `   Fix: Atlas UI → your cluster → Search → Create Search Index\n` +
        `        Collection: ${COLLECTION} | Index name: ${INDEX_NAME}\n` +
        `        See README §4 for the exact JSON definition.\n` +
        `${"=".repeat(70)}`
      );
      return;
    }

    if (idx.status !== "READY") {
      logger.warn(
        { status: idx.status as string },
        `Atlas Vector Search index "${INDEX_NAME}" exists but status is ${String(idx.status)} — memory retrieval may fail until it becomes READY`
      );
      return;
    }

    logger.info(`Atlas Vector Search index "${INDEX_NAME}" is READY — memory retrieval active`);
  } catch (err) {
    // Non-Atlas MongoDB (local dev without Atlas) will throw "not supported".
    // Downgrade to a warning so the server still starts.
    logger.warn(
      { err },
      `Could not verify Atlas Vector Search index "${INDEX_NAME}" — ` +
      "this is expected on local/non-Atlas MongoDB. Memory retrieval may fail on Atlas if the index is missing."
    );
  }
}
