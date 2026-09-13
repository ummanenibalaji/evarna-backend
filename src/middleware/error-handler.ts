import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { logger } from "../utils/logger.js";
import { UsageLimitError } from "../services/usage.service.js";

export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply
): void {
  // Thrown before any work starts (and before an SSE stream is hijacked), so a
  // limit is always an ordinary JSON 429 the app can show as-is.
  if (error instanceof UsageLimitError) {
    reply.status(429).send({ success: false, error: error.message, code: "USAGE_LIMIT_REACHED", limit: error.limit });
    return;
  }

  logger.error({ err: error }, "Unhandled request error");

  const statusCode = error.statusCode ?? 500;
  const message =
    statusCode >= 500 ? "Internal server error" : error.message;

  reply.status(statusCode).send({ success: false, error: message });
}
