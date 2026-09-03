import { retrieveMemories } from "./memory-retrieval.service.js";
import { logger } from "../utils/logger.js";

// ── Memory prefetch ──────────────────────────────────────────────────────────
//
// Memory retrieval is an embedding call plus an Atlas $vectorSearch, measured
// at ~330-580ms. It sits on the critical path: the prompt cannot be assembled
// without it, so on a voice call it is dead air between the caller finishing
// their sentence and the model being asked to start.
//
// It does not have to be. The caller is still speaking well before the final
// transcript lands, and an INTERIM transcript is a good enough query — memory
// retrieval is fuzzy semantic search, not an exact lookup. So we start the
// retrieval while they are still talking and have the result waiting.
//
// The trade is that the query text may be a few words short of what the caller
// finally said. Against saving most of half a second on every single turn, on
// a search that is approximate by construction, that is worth it.
//
// Scoped per session, and each entry is consumed exactly once by the turn it
// belongs to.

interface PrefetchEntry {
  promise: Promise<string>;
  startedAt: number;
  query: string;
}

const prefetches = new Map<string, PrefetchEntry>();

/**
 * How long a prefetched result stays usable. Long enough to cover a slow
 * retrieval plus the endpointing delay, short enough that a stale entry from an
 * abandoned turn is never served to a later one.
 */
const PREFETCH_TTL_MS = 15_000;

/** Below this, an interim transcript is too thin to retrieve anything useful. */
const MIN_QUERY_WORDS = 3;

/**
 * Start retrieving memories for what the caller appears to be saying.
 *
 * Safe to call on every interim transcript: it no-ops while a prefetch for this
 * session is already in flight, so a stream of interims triggers exactly one
 * retrieval per turn rather than one per transcript update.
 */
export function primeMemoryPrefetch(
  sessionId: string,
  characterId: string,
  userId: string,
  interimText: string,
): void {
  const query = interimText.trim();
  if (query.split(/\s+/).length < MIN_QUERY_WORDS) return;

  const existing = prefetches.get(sessionId);
  if (existing && Date.now() - existing.startedAt < PREFETCH_TTL_MS) return;

  // .catch() is attached here, at creation, so this can never surface as an
  // unhandled rejection while it sits waiting to be claimed.
  const promise = retrieveMemories(characterId, userId, query).catch((err) => {
    logger.error({ err, characterId }, "voice: prefetched memory retrieval failed");
    return "";
  });

  prefetches.set(sessionId, { promise, startedAt: Date.now(), query });
  logger.debug({ sessionId, query_words: query.split(/\s+/).length }, "voice: memory prefetch started");
}

/**
 * Claim this session's prefetched retrieval, or null if there isn't a usable
 * one. Consumed on read — a prefetch belongs to exactly one turn.
 */
export function takeMemoryPrefetch(sessionId: string): Promise<string> | null {
  const entry = prefetches.get(sessionId);
  if (!entry) return null;
  prefetches.delete(sessionId);
  if (Date.now() - entry.startedAt > PREFETCH_TTL_MS) return null;
  return entry.promise;
}

/** Drop a session's prefetch. Called when its call ends. */
export function clearMemoryPrefetch(sessionId: string): void {
  prefetches.delete(sessionId);
}
