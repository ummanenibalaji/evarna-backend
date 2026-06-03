import { Queue } from "bullmq";
import { getBullMQConnection } from "../config/bullmq.js";

export const MEMORY_QUEUE_NAME = "whisper-memory";

export const JOB_NAMES = {
  EXTRACTION: "memory-extraction",
  USAGE_SUMMARY: "usage-summary",
} as const;

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
