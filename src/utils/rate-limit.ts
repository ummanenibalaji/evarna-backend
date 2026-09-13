import { getRedis } from "../config/redis.js";

/**
 * Fixed-window counter. INCR, with the expiry set only on the first hit so a
 * steady stream of requests cannot keep extending the window. Returns whether
 * this hit is within the limit.
 *
 * ponytail: fixed window, so a burst straddling a boundary can reach twice the
 * limit. Fine for abuse ceilings; use a sliding window if these become billing.
 */
export async function withinLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const redis = getRedis();
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= limit;
}
