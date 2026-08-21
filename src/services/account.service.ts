import { Types } from "mongoose";
import { User } from "../models/user.model.js";
import { Character } from "../models/character.model.js";
import { Session } from "../models/session.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { Memory } from "../models/memory.model.js";
import { MemorySummary } from "../models/memory-summary.model.js";
import { clearSessionContext, invalidateCharacterConfig } from "./session-context.service.js";
import { logger } from "../utils/logger.js";

/**
 * Permanently delete an account and everything attached to it.
 *
 * App Store Guideline 5.1.1(v) requires that an app supporting account creation
 * lets the user initiate AND complete deletion in-app. This is the "complete"
 * half — it must leave nothing behind, because "we'll get to it" is exactly
 * what the guideline exists to prevent.
 *
 * Deliberately a hard delete, not a soft one. A soft delete would still hold
 * conversation transcripts and extracted memories about someone who asked us to
 * forget them, which is the opposite of what they requested.
 *
 * ponytail: sequential deletes without a transaction. Mongo multi-document
 * transactions need a replica set and would add failure modes for a path that
 * is idempotent anyway — re-running finishes whatever a partial run left. If a
 * partial delete ever needs to be observable, add a `deletion_requested_at`
 * field and sweep it.
 */
export async function deleteAccount(userId: string): Promise<{
  characters: number;
  sessions: number;
  turns: number;
  memories: number;
}> {
  const characters = await Character.find({ user_id: userId }).select("_id").lean();
  const characterIds = characters.map((c) => c._id);

  const sessions = await Session.find({ user_id: userId }).select("_id").lean();
  const sessionIds = sessions.map((s) => s._id);

  // Redis first: it holds live conversation context keyed by session, and it is
  // the only store the Mongo deletes below would not touch. Cache invalidation
  // before the source of truth disappears, not after.
  await Promise.all([
    ...sessionIds.map((id) =>
      clearSessionContext(id.toString()).catch((err) =>
        logger.error({ err, sessionId: id.toString() }, "deleteAccount: failed clearing session context"),
      ),
    ),
    ...characterIds.map((id) =>
      invalidateCharacterConfig(id.toString()).catch((err) =>
        logger.error({ err, characterId: id.toString() }, "deleteAccount: failed invalidating character cache"),
      ),
    ),
  ]);

  const [turnResult, memoryResult] = await Promise.all([
    ConversationTurn.deleteMany({ user_id: userId }),
    Memory.deleteMany({ user_id: userId }),
    MemorySummary.deleteMany({ user_id: userId }),
  ]);

  const [sessionResult, characterResult] = await Promise.all([
    Session.deleteMany({ user_id: userId }),
    Character.deleteMany({ user_id: userId }),
  ]);

  await User.deleteOne({ _id: userId });

  const counts = {
    characters: characterResult.deletedCount ?? 0,
    sessions: sessionResult.deletedCount ?? 0,
    turns: turnResult.deletedCount ?? 0,
    memories: memoryResult.deletedCount ?? 0,
  };

  logger.warn({ userId, ...counts }, "Account deleted");
  return counts;
}

/**
 * Everything we hold about a user, as plain JSON.
 *
 * Embeddings are excluded: 1536 floats per memory are our internal index, not
 * information about the person, and including them would make the export
 * enormous and unreadable for no benefit to whoever asked for it.
 */
export async function exportAccount(userId: string): Promise<Record<string, unknown>> {
  const [user, characters, sessions, turns, memories, summaries] = await Promise.all([
    User.findById(userId).select("-token_version -provider_sub").lean(),
    Character.find({ user_id: userId }).lean(),
    Session.find({ user_id: userId }).sort({ started_at: 1 }).lean(),
    ConversationTurn.find({ user_id: userId }).sort({ created_at: 1 }).lean(),
    Memory.find({ user_id: userId }).select("-embedding").sort({ created_at: 1 }).lean(),
    MemorySummary.find({ user_id: userId }).sort({ created_at: 1 }).lean(),
  ]);

  return {
    exported_at: new Date().toISOString(),
    format_version: 1,
    user,
    characters,
    sessions,
    conversation_turns: turns,
    memories,
    memory_summaries: summaries,
  };
}

/** Assert a character belongs to this user. Returns null when it does not. */
export async function findOwnedCharacter(
  userId: string,
  characterId: string,
): Promise<{ _id: Types.ObjectId } | null> {
  if (!Types.ObjectId.isValid(characterId)) return null;
  return Character.findOne({ _id: characterId, user_id: userId }).select("_id").lean();
}

/** Assert a session belongs to this user. Returns null when it does not. */
export async function findOwnedSession(
  userId: string,
  sessionId: string,
): Promise<{ _id: Types.ObjectId; character_id: Types.ObjectId } | null> {
  if (!Types.ObjectId.isValid(sessionId)) return null;
  return Session.findOne({ _id: sessionId, user_id: userId })
    .select("_id character_id")
    .lean();
}
