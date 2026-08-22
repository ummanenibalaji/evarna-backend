import { Queue } from "bullmq";
import { getBullMQConnection } from "../config/bullmq.js";

export const MEMORY_QUEUE_NAME = "evarna-memory";

export const JOB_NAMES = {
  EXTRACTION: "memory-extraction",
  USAGE_SUMMARY: "usage-summary",
  OUTREACH_SWEEP: "outreach-sweep",
} as const;

/** How often to look for follow-ups that have come due. */
const OUTREACH_SWEEP_MINUTES = 15;

export interface MemoryExtractionPayload {
  sessionId: string;
  characterId: string;
  userId: string;
}

export interface UsageSummaryPayload {
  characterId: string;
  userId: string;
}

let memoryQueue: Queue | null = null;

export function getMemoryQueue(): Queue {
  if (!memoryQueue) {
    memoryQueue = new Queue(MEMORY_QUEUE_NAME, {
      connection: getBullMQConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return memoryQueue;
}

export async function enqueueMemoryExtraction(
  payload: MemoryExtractionPayload
): Promise<void> {
  // jobId deduplicates: re-enqueueing for same session is a no-op
  await getMemoryQueue().add(JOB_NAMES.EXTRACTION, payload, {
    jobId: `extraction_${payload.sessionId}`,
  });
}

export async function enqueueUsageSummary(
  payload: UsageSummaryPayload
): Promise<void> {
  await getMemoryQueue().add(JOB_NAMES.USAGE_SUMMARY, payload);
}


/**
 * Schedule the recurring outreach sweep.
 *
 * A BullMQ repeatable job rather than setInterval, deliberately.
 * stale-session.service.ts uses setInterval, which is survivable for a cleanup
 * that is idempotent — but this one sends push notifications, and two server
 * instances with their own timers would send two. Redis holds the schedule, so
 * the job fires once no matter how many processes are running.
 *
 * The fixed jobId makes re-registration on every boot a no-op rather than
 * stacking a new schedule each restart.
 */
export async function scheduleOutreachSweep(): Promise<void> {
  await getMemoryQueue().add(
    JOB_NAMES.OUTREACH_SWEEP,
    {},
    {
      jobId: "outreach-sweep-recurring",
      repeat: { every: OUTREACH_SWEEP_MINUTES * 60 * 1000 },
      // A missed sweep is not worth retrying — the next one is 15 minutes away
      // and the hints are still pending.
      attempts: 1,
      removeOnComplete: 20,
      removeOnFail: 20,
    },
  );
}
