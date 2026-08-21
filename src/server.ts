import "dotenv/config";
import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { connectDatabase, checkVectorSearchIndex } from "./config/database.js";
import { connectRedis } from "./config/redis.js";
import { logger } from "./utils/logger.js";
import { startMemoryWorker } from "./workers/memory.worker.js";
import { startStaleSessionCleanup } from "./services/stale-session.service.js";

async function start(): Promise<void> {
  await connectDatabase();
  await connectRedis();
  // Awaited, not fire-and-forget: in production a missing index exits here,
  // and /health must not report "unverified" just because we raced startup.
  await checkVectorSearchIndex();
  startMemoryWorker();
  startStaleSessionCleanup();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`Evarna backend listening on port ${env.PORT}`);
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
