import { getRedis } from "../config/redis.js";
import { approximateTokens } from "../utils/token-counter.js";
import { logger } from "../utils/logger.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";

const SESSION_TTL = 7200;    // 2 hours
const CHARACTER_TTL = 3600;  // 1 hour
const MAX_TURNS = 30;

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function characterKey(characterId: string): string {
  return `character_config:${characterId}`;
}

export async function getSessionContext(
  sessionId: string
): Promise<IRedisSessionContext | null> {
  const redis = getRedis();
  const raw = await redis.get(sessionKey(sessionId));
  if (!raw) return null;
  return JSON.parse(raw) as IRedisSessionContext;
}

export async function initSessionContext(sessionId: string): Promise<void> {
  const redis = getRedis();
  const fresh: IRedisSessionContext = {
    compressed_summary: "",
    turns: [],
    total_token_count: 0,
  };
  await redis.setex(sessionKey(sessionId), SESSION_TTL, JSON.stringify(fresh));
}

export async function appendTurn(
  sessionId: string,
  role: string,
  content: string
): Promise<void> {
  const redis = getRedis();
  const ctx = (await getSessionContext(sessionId)) ?? {
    compressed_summary: "",
    turns: [],
    total_token_count: 0,
  };

  ctx.turns.push({ role, content });

  // Keep only the last MAX_TURNS verbatim
  if (ctx.turns.length > MAX_TURNS) {
    ctx.turns = ctx.turns.slice(-MAX_TURNS);
  }

  // Recalculate total token count
  const summaryTokens = ctx.compressed_summary
    ? approximateTokens(ctx.compressed_summary)
    : 0;
  const turnTokens = ctx.turns.reduce(
    (sum, t) => sum + approximateTokens(t.content),
    0
  );
  ctx.total_token_count = summaryTokens + turnTokens;

  await redis.setex(sessionKey(sessionId), SESSION_TTL, JSON.stringify(ctx));
}

export async function setSessionContext(
  sessionId: string,
  ctx: IRedisSessionContext
): Promise<void> {
  const redis = getRedis();
  await redis.setex(sessionKey(sessionId), SESSION_TTL, JSON.stringify(ctx));
}

export async function clearSessionContext(sessionId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(sessionKey(sessionId));
}

export async function cacheCharacterConfig(
  characterId: string,
  config: unknown
): Promise<void> {
  const redis = getRedis();
  await redis.setex(characterKey(characterId), CHARACTER_TTL, JSON.stringify(config));
}

export async function getCachedCharacterConfig(
  characterId: string
): Promise<unknown | null> {
  const redis = getRedis();
  const raw = await redis.get(characterKey(characterId));
  if (!raw) return null;
  return JSON.parse(raw) as unknown;
}

export async function invalidateCharacterConfig(characterId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(characterKey(characterId));
}
