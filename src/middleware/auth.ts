import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { User } from "../models/user.model.js";
import { verifySessionToken } from "../services/auth.service.js";
import { logger } from "../utils/logger.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The authenticated user's id. Populated by the global onRequest hook for
     * every route that is not on the public allowlist below.
     *
     * Handlers may treat this as always present: a request that reached a
     * protected handler has already been rejected if it had no valid token.
     * It is typed optional only because the public routes share the type.
     */
    userId?: string;
  }
}

// Everything else requires a verified token. This is an allowlist rather than
// per-route opt-in deliberately: a new route added without thinking is
// protected by default, which is the failure mode we want.
//
// Matched against the full path, after prefixes are applied.
const PUBLIC_ROUTES = new Set<string>([
  "/health",
  "/api/v1/auth/google",
  "/api/v1/auth/apple",
  "/api/v1/auth/email/request",
  "/api/v1/auth/email/verify",
  // The voice catalog is shown during sign-up, before a token exists, and
  // contains no user data.
  "/api/v1/voice/voices",
]);

/** Exposed so checks/auth.check.ts can pin the allowlist contents. */
export const PUBLIC_ROUTES_FOR_TEST: ReadonlySet<string> = PUBLIC_ROUTES;

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest("userId", undefined);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // routerPath is undefined for 404s; fall back to the raw url without query.
    const path = request.url.split("?")[0] ?? "";
    if (PUBLIC_ROUTES.has(path)) return;

    const token = bearerToken(request);
    if (!token) {
      return reply
        .status(401)
        .send({ success: false, error: "Authentication required", code: "UNAUTHENTICATED" });
    }

    let claims;
    try {
      claims = await verifySessionToken(token);
    } catch {
      return reply
        .status(401)
        .send({ success: false, error: "Session expired. Please sign in again.", code: "UNAUTHENTICATED" });
    }

    // The version check is what makes revocation work: signing out everywhere
    // bumps token_version, and every previously issued token stops matching.
    // It costs one indexed lookup per request; if that ever shows up in a
    // profile, cache it in Redis keyed by user id.
    const user = await User.findById(claims.userId).select("token_version").lean();
    if (!user || (user.token_version ?? 0) !== claims.tokenVersion) {
      return reply
        .status(401)
        .send({ success: false, error: "Session expired. Please sign in again.", code: "UNAUTHENTICATED" });
    }

    request.userId = claims.userId;
  });

  logger.info({ publicRoutes: PUBLIC_ROUTES.size }, "auth: request authentication enabled");
}

/**
 * The authenticated user id, for handlers that would otherwise write
 * `request.userId!` everywhere. Throws rather than returning undefined so a
 * route accidentally added to the public allowlist fails loudly instead of
 * quietly operating on `undefined`.
 */
export function getUserId(request: FastifyRequest): string {
  const id = request.userId;
  if (!id) throw new Error("getUserId called on an unauthenticated route");
  return id;
}
