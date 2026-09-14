import type { FastifyInstance } from "fastify";
import { getEntitlementSnapshot, toEntitlementView } from "../services/entitlement.service.js";
import { getUserId } from "../middleware/auth.js";

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
}
