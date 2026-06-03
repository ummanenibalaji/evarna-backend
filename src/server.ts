import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { connectRedis } from "./config/redis.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger } from "./utils/logger.js";
import { userRoutes } from "./routes/user.routes.js";
import { characterRoutes } from "./routes/character.routes.js";
import { sessionRoutes } from "./routes/session.routes.js";
import { conversationRoutes } from "./routes/conversation.routes.js";
import { memoryRoutes } from "./routes/memory.routes.js";
import { voiceRoutes } from "./routes/voice.routes.js";
import { startMemoryWorker } from "./workers/memory.worker.js";
import { startStaleSessionCleanup } from "./services/stale-session.service.js";

const app = Fastify({ logger: false });

await app.register(cors, { origin: true });

app.setErrorHandler(errorHandler);

app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

// Sprint 1
await app.register(userRoutes, { prefix: "/api/v1/users" });
await app.register(characterRoutes, { prefix: "/api/v1/characters" });

// Sprint 2
await app.register(sessionRoutes, { prefix: "/api/v1/sessions" });
await app.register(conversationRoutes, { prefix: "/api/v1/conversations" });

// Sprint 3
await app.register(memoryRoutes, { prefix: "/api/v1/memories" });

// Sprint 4
await app.register(voiceRoutes, { prefix: "/api/v1/voice" });

async function start(): Promise<void> {
  await connectDatabase();
  await connectRedis();
  startMemoryWorker();
  startStaleSessionCleanup();

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`Whisper backend listening on port ${env.PORT}`);
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
