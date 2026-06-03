import dns from "node:dns";
import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

// Some local VPN/DNS proxies leave Node's resolver pointed at a loopback
// address that refuses SRV queries, which breaks Atlas mongodb+srv:// lookups
// (querySrv ECONNREFUSED). Fall back to public DNS only in that case.
function ensureResolvableDns(): void {
  const loopback = dns.getServers().every((s) => s.startsWith("127.") || s === "::1");
  if (loopback) {
    dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
    logger.warn("DNS resolver was loopback-only; switched to public DNS for SRV lookups");
  }
}

export async function connectDatabase(): Promise<void> {
  ensureResolvableDns();


  mongoose.connection.on("connected", () =>
    logger.info("MongoDB connected")
  );
  mongoose.connection.on("disconnected", () =>
    logger.warn("MongoDB disconnected")
  );
  mongoose.connection.on("error", (err) =>
    logger.error({ err }, "MongoDB connection error")
  );

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
