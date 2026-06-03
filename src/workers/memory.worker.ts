import { Worker } from "bullmq";
import { getBullMQConnection } from "../config/bullmq.js";
import {
  MEMORY_QUEUE_NAME,
  JOB_NAMES,
  type MemoryExtractionPayload,
  type UsageSummaryPayload,
} from "../queues/memory.queue.js";
import { runMemoryExtraction } from "../services/memory-extraction.service.js";
import { generateUsageSummary } from "../services/memory-summary.service.js";
import { logger } from "../utils/logger.js";

export function startMemoryWorker(): Worker {
  const worker = new Worker(
    MEMORY_QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case JOB_NAMES.EXTRACTION: {
          const payload = job.data as MemoryExtractionPayload;
          logger.info({ sessionId: payload.sessionId }, "Running memory extraction");
          await runMemoryExtraction(payload);
          break;
        }

        case JOB_NAMES.USAGE_SUMMARY: {
          const payload = job.data as UsageSummaryPayload;
          logger.info({ characterId: payload.characterId }, "Running usage summary");
          await generateUsageSummary(payload.characterId, payload.userId);
          break;
        }

        default:
          logger.warn({ jobName: job.name }, "Unknown memory queue job — skipping");
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, jobName: job.name }, "Memory job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err }, "Memory job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "Memory worker error");
  });

  logger.info("Memory worker started");
  return worker;
}
