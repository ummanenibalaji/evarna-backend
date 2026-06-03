import { env } from "./env.js";

// BullMQ must not share the app's IORedis client — it uses blocking commands
// and requires maxRetriesPerRequest: null.
export function getBullMQConnection(): Record<string, unknown> {
  const url = new URL(env.REDIS_URL);
  const conn: Record<string, unknown> = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
  if (url.password) conn.password = decodeURIComponent(url.password);
  if (url.username) conn.username = url.username;
  const db = url.pathname.replace(/^\//, "");
  if (db) conn.db = Number(db);
  if (url.protocol === "rediss:") conn.tls = {};
  return conn;
}
