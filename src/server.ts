import "dotenv/config";
import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { connectDatabase, checkVectorSearchIndex } from "./config/database.js";
import { connectRedis } from "./config/redis.js";
import { assertEmailDeliverable } from "./services/auth.service.js";
import { logger } from "./utils/logger.js";
import { startMemoryWorker } from "./workers/memory.worker.js";
import { startStaleSessionCleanup } from "./services/stale-session.service.js";
import { scheduleOutreachSweep } from "./queues/memory.queue.js";

async function start(): Promise<void> {
  // Before anything else: a production server that cannot deliver a sign-in
  // code cannot sign anyone in, and that used to surface only as users
  // mysteriously never receiving one.
  assertEmailDeliverable();

  await connectDatabase();
  await connectRedis();
  // Awaited, not fire-and-forget: in production a missing index exits here,
  // and /health must not report "unverified" just because we raced startup.
  await checkVectorSearchIndex();
  startMemoryWorker();
  startStaleSessionCleanup();
  await scheduleOutreachSweep();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`Evarna backend listening on port ${env.PORT}`);
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
