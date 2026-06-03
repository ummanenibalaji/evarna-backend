import { Session } from "../models/session.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { endSessionById } from "./session.service.js";
import { logger } from "../utils/logger.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 min with no turns → stale
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // run every 5 min

async function runCleanup(): Promise<void> {
  const idleCutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);

  // Sessions open for at least 30 min (started before cutoff) and still active
  const candidates = await Session.find({
    status: "active",
    started_at: { $lt: idleCutoff },
  })
    .select("_id started_at")
    .lean();

  if (candidates.length === 0) return;

  const results = await Promise.allSettled(
    candidates.map(async (session) => {
      // Skip sessions with a turn in the last 30 min — still live
      const recentTurn = await ConversationTurn.findOne({
        session_id: session._id,
        created_at: { $gte: idleCutoff },
      })
        .select("_id")
        .lean();

      if (recentTurn) return;

      // Idle — close via the shared service (updates DB + enqueues memory extraction)
      const duration = await endSessionById(session._id.toString(), "interrupted");
      if (duration !== null) {
        logger.info({ sessionId: session._id, duration }, "Stale session auto-closed");
      }
    }),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    logger.error({ count: failed.length }, "Stale cleanup: some sessions failed to close");
  }
}

export function startStaleSessionCleanup(): void {
  // Run once at startup to catch anything left open from a previous crash/restart
  void runCleanup().catch((err) => logger.error({ err }, "Stale cleanup: initial run failed"));

  setInterval(() => {
    void runCleanup().catch((err) => logger.error({ err }, "Stale cleanup: interval run failed"));
  }, CHECK_INTERVAL_MS);

  logger.info("Stale session cleanup started (interval: 5 min, idle threshold: 30 min)");
}
