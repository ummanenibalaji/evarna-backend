import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { getVectorIndexStatus } from "./config/database.js";
import { errorHandler } from "./middleware/error-handler.js";
import { registerAuth } from "./middleware/auth.js";
import mongoose from "mongoose";
import { env } from "./config/env.js";
import { getRedis } from "./config/redis.js";
import { authRoutes } from "./routes/auth.routes.js";
import { userRoutes } from "./routes/user.routes.js";
import { characterRoutes } from "./routes/character.routes.js";
import { sessionRoutes } from "./routes/session.routes.js";
import { conversationRoutes } from "./routes/conversation.routes.js";
import { memoryRoutes } from "./routes/memory.routes.js";
import { voiceRoutes } from "./routes/voice.routes.js";
import { studioRoutes } from "./routes/studio.routes.js";
import { reportRoutes } from "./routes/report.routes.js";

/**
 * Build the Fastify app without connecting to anything.
 *
 * Split out of server.ts so the auth boundary can be asserted in-process:
 * checks/routes.check.ts builds this, enumerates every registered route and
 * verifies each one refuses an unauthenticated request. That check needs no
 * MongoDB and no Redis, because a request with no token is rejected before any
 * handler or database call runs.
 *
 * server.ts owns everything with a side effect — connections, workers, the
 * stale-session sweep, listen().
 */
export interface BuildAppOptions {
  /**
   * Called once per registered route. Fastify has no public route list, and
   * the onRoute hook only sees routes registered after it — so capturing them
   * has to happen here, at the top of the factory. checks/routes.check.ts uses
   * this to assert the auth boundary across every route rather than a
   * hand-maintained list that would go stale the first time someone adds one.
   */
  onRoute?: (route: { method: string; url: string }) => void;
}

/**
 * How many proxies in front of us to trust for the client's address.
 *
 * Behind a load balancer every request arrives from the balancer, so without
 * this `request.ip` is the same for every user, and the per-IP limit on sign-in
 * codes becomes one limit shared by the whole app. Trusting it when there is NO
 * proxy is just as wrong: X-Forwarded-For is then written by the client, and
 * anyone can dodge the limit by setting it. So it is explicit per deployment:
 *   TRUST_PROXY=1            one hop (a typical load balancer or PaaS router)
 *   TRUST_PROXY=10.0.0.0/8   only proxies in this range
 *   unset                    direct connections (local development)
 */
export function parseTrustProxy(raw: string): boolean | number | string {
  const v = raw.trim();
  if (!v || v === "false") return false;
  if (v === "true") return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: parseTrustProxy(env.TRUST_PROXY) });

  if (opts.onRoute) {
    const report = opts.onRoute;
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) report({ method, url: route.url });
    });
  }

  await app.register(cors, { origin: true });
  app.setErrorHandler(errorHandler);

  // Registered before any route plugin so every route registered below
  // inherits the hook. Routes are protected by default; the allowlist inside
  // middleware/auth.ts is the only way to opt out.
  registerAuth(app);

  // vector_index is reported here because a missing index disables long-term
  // memory with no other visible symptom. "ready" is the only value that means
  // memory recall actually works.
  //
  // 503 unless MongoDB and Redis are both reachable, so a load balancer stops
  // sending traffic to an instance that can only fail. During shutdown Fastify
  // itself answers 503, which drains the instance the same way.
  app.get("/health", async (_request, reply) => {
    const mongo = mongoose.connection.readyState === 1;
    const redisClient = getRedis();
    const redis =
      redisClient.status === "ready" &&
      (await Promise.race([
        redisClient.ping().then((r) => r === "PONG", () => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]));
    const healthy = mongo && redis;
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      ts: new Date().toISOString(),
      mongo,
      redis,
      vector_index: getVectorIndexStatus(),
    });
  });

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(userRoutes, { prefix: "/api/v1/users" });
  await app.register(characterRoutes, { prefix: "/api/v1/characters" });
  await app.register(sessionRoutes, { prefix: "/api/v1/sessions" });
  await app.register(conversationRoutes, { prefix: "/api/v1/conversations" });
  await app.register(memoryRoutes, { prefix: "/api/v1/memories" });
  await app.register(voiceRoutes, { prefix: "/api/v1/voice" });
  await app.register(studioRoutes, { prefix: "/api/v1/studio" });
  await app.register(reportRoutes, { prefix: "/api/v1/reports" });

  return app;
}
