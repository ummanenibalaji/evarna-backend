import { Session } from "../models/session.model.js";
import { Character } from "../models/character.model.js";
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

  // `endedAt` can come from the client (POST /sessions/:id/end), and voice
  // minutes are billed from the duration recorded here. Sending the session's
  // own start time recorded 0 seconds, so an hour-long call cost nothing and
  // could be repeated. A voice session therefore ends at the server's clock,
  // always; a text session may say it ended earlier, but never before it began
  // or after now.
  const now = new Date();
  const startedAt = session.started_at.getTime();
  const end =
    session.session_type === "text"
      ? new Date(Math.min(now.getTime(), Math.max(startedAt, endedAt.getTime())))
      : now;

  const duration_seconds = Math.floor((end.getTime() - startedAt) / 1000);

  session.ended_at = end;
  session.duration_seconds = duration_seconds;
  session.status = status;

  // FIX 12: track voice minutes when ended via HTTP (webhook path uses finalizeSession)
  const voiceMinutes = Math.ceil(duration_seconds / 60);
  if (session.session_type === "voice_call") {
    session.voice_minutes_consumed = voiceMinutes;
  }

  await session.save();

  if (session.session_type === "voice_call") {
    void Character.updateOne(
      { _id: session.character_id },
      { $inc: { total_voice_minutes: voiceMinutes } },
    ).catch((err) =>
      logger.error({ err, sessionId }, "endSessionById: failed to update voice minutes"),
    );
  }

  // A session the user asked us not to remember must leave nothing behind.
  // The turns themselves still exist (they are the transcript the user just
  // had, and account deletion removes them), but nothing is distilled into
  // long-term memory, which is what "nothing will be saved" promises.
  if (session.memory_enabled === false) {
    logger.info({ sessionId }, "endSessionById: session opted out of memory — skipping extraction");
    return duration_seconds;
  }

  void enqueueMemoryExtraction({
    sessionId,
    characterId: session.character_id.toString(),
    userId: session.user_id,
  }).catch((err) =>
    logger.error({ err, sessionId }, "endSessionById: failed to enqueue memory extraction"),
  );

  return duration_seconds;
}
