import "dotenv/config";
import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { connectDatabase, checkVectorSearchIndex, disconnectDatabase } from "./config/database.js";
import { connectRedis, disconnectRedis } from "./config/redis.js";
import { assertEmailDeliverable } from "./services/auth.service.js";
import { logger } from "./utils/logger.js";
import { flushSentry, initSentry } from "./config/sentry.js";
import { startMemoryWorker } from "./workers/memory.worker.js";
import { startStaleSessionCleanup } from "./services/stale-session.service.js";
import { closeMemoryQueue, scheduleOutreachSweep } from "./queues/memory.queue.js";

// Under the 30 seconds most platforms allow between SIGTERM and SIGKILL.
const SHUTDOWN_GRACE_MS = 25_000;

async function start(): Promise<void> {
  initSentry();
  // Before anything else: a production server that cannot deliver a sign-in
  // code cannot sign anyone in, and that used to surface only as users
  // mysteriously never receiving one.
  assertEmailDeliverable();
  if (env.NODE_ENV === "production" && !env.TRUST_PROXY) {
    logger.warn("TRUST_PROXY is unset: behind a load balancer every user shares one IP for rate limiting");
  }

  await connectDatabase();
  await connectRedis();
  // Awaited, not fire-and-forget: in production a missing index exits here,
  // and /health must not report "unverified" just because we raced startup.
  await checkVectorSearchIndex();
  const memoryWorker = startMemoryWorker();
  const staleTimer = startStaleSessionCleanup();
  await scheduleOutreachSweep();

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`Evarna backend listening on port ${env.PORT}`);

  // Every deploy sends SIGTERM. Without this the process died mid-reply, mid
  // memory-extraction job, and with its Redis locks still held.
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown: draining");
    setTimeout(() => {
      logger.warn("shutdown: grace period over, exiting with work still in flight");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();

    try {
      clearInterval(staleTimer);
      // Stops accepting connections and waits for in-flight requests, including
      // a reply that is still streaming.
      await app.close();
      // Lets the memory job in progress finish rather than abandoning it.
      await memoryWorker.close();
      await closeMemoryQueue();
      await disconnectRedis();
      await disconnectDatabase();
      await flushSentry();
      logger.info("shutdown: clean");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "shutdown: failed");
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  void flushSentry().finally(() => process.exit(1));
});
