import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { logger } from "../utils/logger.js";

export function errorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply
): void {
  logger.error({ err: error }, "Unhandled request error");

  const statusCode = error.statusCode ?? 500;
  const message =
    statusCode >= 500 ? "Internal server error" : error.message;

  reply.status(statusCode).send({ success: false, error: message });
}
