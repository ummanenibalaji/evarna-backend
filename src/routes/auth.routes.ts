import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { User } from "../models/user.model.js";
import {
  verifyProviderToken,
  requestEmailCode,
  verifyEmailCode,
  findOrCreateUser,
  issueSessionToken,
  revokeAllSessions,
  AuthError,
  RateLimitedError,
} from "../services/auth.service.js";
import { getUserId } from "../middleware/auth.js";
import { isMinorNow } from "../utils/age.js";
import type { AuthSessionResponse } from "../types/user.types.js";

const ProviderBodySchema = z.object({ id_token: z.string().min(1) });
const EmailRequestSchema = z.object({ email: z.string().email() });
const EmailVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Both provider routes are the same three steps — verify the provider's
  // signature, resolve or create our user, issue our own token — so they share
  // one implementation rather than being copy-pasted.
  const providerSignIn = (provider: "google" | "apple") =>
    async (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
      const parsed = ProviderBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: "id_token is required" });
      }

      try {
        const identity = await verifyProviderToken(provider, parsed.data.id_token);
        const user = await findOrCreateUser(provider, identity);
        const token = await issueSessionToken(user._id.toString(), user.token_version);

        const body: AuthSessionResponse = {
          token,
          user_id: user._id.toString(),
          onboarding_completed: user.onboarding_completed,
        };
        return reply.send({ success: true, data: body });
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.status(401).send({ success: false, error: err.message, code: "AUTH_FAILED" });
        }
        throw err;
      }
    };

  // POST /api/v1/auth/google
  app.post("/google", providerSignIn("google"));

  // POST /api/v1/auth/apple
  // Required by App Store Guideline 4.8 wherever Google sign-in is offered.
  app.post("/apple", providerSignIn("apple"));

  // POST /api/v1/auth/email/request — send a one-time code
  app.post("/email/request", async (request, reply) => {
    const parsed = EmailRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "A valid email is required" });
    }

    let result: Awaited<ReturnType<typeof requestEmailCode>>;
    try {
      result = await requestEmailCode(parsed.data.email, request.ip);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return reply.status(429).send({
          success: false,
          error: err.message,
          code: "RATE_LIMITED",
        });
      }
      if (err instanceof AuthError) {
        return reply.status(502).send({ success: false, error: err.message });
      }
      throw err;
    }

    // The response never reveals whether that address has an account —
    // anything else turns this endpoint into an account-existence oracle. It
    // DOES report whether a mail actually went out, which is not the same
    // thing: it used to answer `sent: true` with no provider configured, so
    // the app told people to check an inbox nothing was ever sent to.
    return reply.send({
      success: true,
      data: {
        sent: result.delivered,
        // Development only; the service refuses to produce this in production.
        ...(result.devCode ? { dev_code: result.devCode } : {}),
      },
    });
  });

  // POST /api/v1/auth/email/verify — exchange the code for a session
  app.post("/email/verify", async (request, reply) => {
    const parsed = EmailVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      });
    }

    try {
      const identity = await verifyEmailCode(parsed.data.email, parsed.data.code);
      const user = await findOrCreateUser("email", identity);
      const token = await issueSessionToken(user._id.toString(), user.token_version);

      const body: AuthSessionResponse = {
        token,
        user_id: user._id.toString(),
        onboarding_completed: user.onboarding_completed,
      };
      return reply.send({ success: true, data: body });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(401).send({ success: false, error: err.message, code: "AUTH_FAILED" });
      }
      throw err;
    }
  });

  // GET /api/v1/auth/me — who the current token belongs to.
  // The client calls this on launch to decide between onboarding and home.
  app.get("/me", async (request, reply) => {
    const userId = getUserId(request);
    const user = await User.findById(userId)
      .select("display_name email gender date_of_birth communication_style onboarding_completed created_at")
      .lean();

    if (!user) {
      // Token verified but the user is gone — deleted account with a live
      // token. Treat as signed out.
      return reply.status(401).send({ success: false, error: "Account not found", code: "UNAUTHENTICATED" });
    }

    return reply.send({
      success: true,
      data: {
        user_id: userId,
        email: user.email ?? null,
        display_name: user.display_name ?? null,
        gender: user.gender ?? null,
        communication_style: user.communication_style ?? null,
        onboarding_completed: user.onboarding_completed,
        // Derived live, never read from the stored snapshot.
        is_minor: isMinorNow(user.date_of_birth),
        member_since: user.created_at,
      },
    });
  });

  // POST /api/v1/auth/logout — sign out of every device.
  // There is no per-device sign-out: tokens are stateless and a device list
  // would be a table to store and clean up for a feature nobody has asked for.
  app.post("/logout", async (request, reply) => {
    await revokeAllSessions(getUserId(request));
    return reply.send({ success: true, data: { signed_out: true } });
  });
}
