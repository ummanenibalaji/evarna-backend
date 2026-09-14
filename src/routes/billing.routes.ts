import type { FastifyInstance } from "fastify";
import { getEntitlementSnapshot, toEntitlementView } from "../services/entitlement.service.js";
import {
  RevenueCatNotConfiguredError,
  syncFromRevenueCat,
  usersInEvent,
  webhookAuthorized,
} from "../services/revenuecat.service.js";
import { getUserId } from "../middleware/auth.js";
import { User } from "../models/user.model.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/billing/entitlement
   *
   * One call that answers everything the app used to invent: which plan this
   * person is on, how many voice seconds are left, when the allowance comes
   * back, and what the store sells. The settings screen showed "Renews on June
   * 1, 2026" and the top-up sheet "You have 12 minutes remaining" to every
   * account, on every launch, including its first.
   *
   * Read-only by design — it never creates a subscription document, so calling
   * it cannot change what someone is entitled to.
   */
  app.get("/entitlement", async (request, reply) => {
    const snapshot = await getEntitlementSnapshot(getUserId(request));
    return reply.send({ success: true, data: toEntitlementView(snapshot) });
  });

  /**
   * POST /api/v1/billing/sync
   *
   * Called by the app right after a purchase or a restore, so the new plan shows
   * immediately instead of whenever RevenueCat's webhook lands. Reads the store
   * and returns the updated entitlement.
   */
  app.post("/sync", async (request, reply) => {
    const userId = getUserId(request);
    try {
      await syncFromRevenueCat(userId);
    } catch (err) {
      if (err instanceof RevenueCatNotConfiguredError) {
        return reply.status(503).send({ success: false, error: "Billing isn't set up on this server.", code: "BILLING_NOT_CONFIGURED" });
      }
      logger.error({ err, userId }, "billing: store sync failed");
      return reply.status(502).send({ success: false, error: "Couldn't reach the store. Try again in a moment.", code: "STORE_UNAVAILABLE" });
    }
    const snapshot = await getEntitlementSnapshot(userId);
    return reply.send({ success: true, data: toEntitlementView(snapshot) });
  });

  /**
   * POST /api/v1/billing/revenuecat
   *
   * RevenueCat's webhook. Skipped by the global auth hook (it carries RevenueCat's
   * shared secret, not an app token) and checked here before anything else. Any
   * event re-reads the affected customers; a failure answers 500 so RevenueCat
   * retries.
   */
  app.post("/revenuecat", async (request, reply) => {
    if (!webhookAuthorized(request.headers.authorization, env.REVENUECAT_WEBHOOK_AUTH)) {
      return reply.status(401).send({ success: false, error: "Unauthorized", code: "UNAUTHENTICATED" });
    }
    const event = (request.body as { event?: unknown } | null)?.event;
    if (!event || typeof event !== "object") {
      return reply.status(400).send({ success: false, error: "Expected a RevenueCat event" });
    }
    const e = event as Record<string, unknown>;
    if (e["type"] === "TEST") return reply.send({ success: true });

    try {
      for (const userId of usersInEvent(e)) {
        if (await User.exists({ _id: userId })) await syncFromRevenueCat(userId);
      }
    } catch (err) {
      logger.error({ err, type: e["type"] }, "billing: RevenueCat webhook sync failed; RevenueCat will retry");
      return reply.status(500).send({ success: false, error: "Sync failed" });
    }
    return reply.send({ success: true });
  });
}
