import { Session } from "../models/session.model.js";
import { enqueueMemoryExtraction } from "../queues/memory.queue.js";
import { logger } from "../utils/logger.js";

export type SessionEndStatus = "completed" | "interrupted";

/**
 * End a session by ID. Shared by the HTTP route and the stale-session cleanup.
 *
 * - Updates status, ended_at, duration_seconds on the session document.
 * - Enqueues a BullMQ memory-extraction job (jobId-deduplicated, safe to call twice).
 *
 * Returns the updated duration_seconds, or null if the session was not found
 * or was already ended.
 */
export async function endSessionById(
  sessionId: string,
  status: SessionEndStatus = "completed",
  endedAt: Date = new Date(),
): Promise<number | null> {
  const session = await Session.findById(sessionId);
  if (!session || session.status !== "active") return null;

  const duration_seconds = Math.floor(
    (endedAt.getTime() - session.started_at.getTime()) / 1000,
  );

  session.ended_at = endedAt;
  session.duration_seconds = duration_seconds;
  session.status = status;
  await session.save();

  void enqueueMemoryExtraction({
    sessionId,
    characterId: session.character_id.toString(),
    userId: session.user_id,
  }).catch((err) =>
    logger.error({ err, sessionId }, "endSessionById: failed to enqueue memory extraction"),
  );

  return duration_seconds;
}
