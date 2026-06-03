import "dotenv/config";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, type JobContext, type JobProcess, WorkerOptions } from "@livekit/agents";
import { connectDatabase } from "../config/database.js";
import { connectRedis } from "../config/redis.js";
import { env } from "../config/env.js";
import { runVoicePipeline } from "../services/voice.service.js";
import { VOICE_AGENT_NAME } from "../services/livekit-token.service.js";
import { logger } from "../utils/logger.js";

export default defineAgent({
  prewarm: async (_proc: JobProcess) => {
    // One-time setup per worker process: connect to MongoDB + Redis
    await connectDatabase();
    await connectRedis();
    logger.info("Voice worker prewarm complete");
  },

  entry: async (ctx: JobContext) => {
    try {
      await runVoicePipeline(ctx);
    } catch (err) {
      logger.error({ err }, "Voice pipeline crashed");
      ctx.shutdown("pipeline-error");
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET || !env.LIVEKIT_URL) {
    logger.error(
      "LiveKit credentials missing — set LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL"
    );
    process.exit(1);
  }

  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: VOICE_AGENT_NAME,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      wsURL: env.LIVEKIT_URL,
    })
  );
}
