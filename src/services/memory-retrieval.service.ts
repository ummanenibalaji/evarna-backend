import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { Memory } from "../models/memory.model.js";
import { logger } from "../utils/logger.js";

const ATLAS_VECTOR_INDEX = "memory_vector_index";
const VECTOR_SEARCH_CANDIDATES = 100;
const VECTOR_SEARCH_LIMIT = 10;
const RECENCY_DECAY_DAYS = 30;
const DEDUP_COSINE_THRESHOLD = 0.85;
const COSINE_WEIGHT = 0.6;
const RECENCY_WEIGHT = 0.4;
const MAX_MEMORY_BLOCK_TOKENS = 400;

interface RawVectorResult {
  _id: Types.ObjectId;
  content: string;
  type: string;
  sentiment: string;
  created_at: Date;
  embedding: number[];
  vector_score: number;
}

interface ScoredMemory {
  _id: Types.ObjectId;
  content: string;
  type: string;
  created_at: Date;
  final_score: number;
  embedding: number[];
}

function recencyDecay(createdAt: Date): number {
  const daysSince = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-daysSince / RECENCY_DECAY_DAYS);
}

// Cosine similarity for already-normalized unit vectors = dot product
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function deduplicateByEmbedding(memories: ScoredMemory[]): ScoredMemory[] {
  const kept: ScoredMemory[] = [];
  for (const candidate of memories) {
    const tooSimilar = kept.some(
      (k) => dotProduct(candidate.embedding, k.embedding) > DEDUP_COSINE_THRESHOLD
    );
    if (!tooSimilar) {
      kept.push(candidate);
    }
  }
  return kept;
}

function formatMemoryBlock(memories: ScoredMemory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const daysAgo = Math.floor(
      (Date.now() - m.created_at.getTime()) / (1000 * 60 * 60 * 24)
    );
    const timeStr =
      daysAgo === 0 ? "today"
      : daysAgo === 1 ? "yesterday"
      : `${daysAgo}d ago`;
    return `• ${m.content} [${m.type}, ${timeStr}]`;
  });

  // Rough token budget: each line ~25 tokens, header ~10 tokens
  const header = "[Known about this person]";
  const fullBlock = `${header}\n${lines.join("\n")}`;

  // Trim to budget: remove lowest-scored lines from the end if over limit
  const approxTokens = Math.ceil(fullBlock.length / 4);
  if (approxTokens <= MAX_MEMORY_BLOCK_TOKENS) return fullBlock;

  const maxLines = Math.floor((MAX_MEMORY_BLOCK_TOKENS * 4 - header.length) / 100);
  return `${header}\n${lines.slice(0, Math.max(1, maxLines)).join("\n")}`;
}

export async function retrieveMemories(
  characterId: string,
  userMessage: string
): Promise<string> {
  const characterObjId = new Types.ObjectId(characterId);
  const openai = getOpenAI();

  // 1. Embed user message (truncate to 8000 chars to stay within model limits)
  const truncatedMessage = userMessage.slice(0, 8000);
  let queryVector: number[];

  try {
    const embeddingResponse = await openai.embeddings.create({
      model: MODELS.EMBEDDING,
      input: truncatedMessage,
    });
    queryVector = embeddingResponse.data[0]?.embedding ?? [];
  } catch (err) {
    logger.error({ err, characterId }, "Message embedding failed");
    return "";
  }

  if (queryVector.length === 0) return "";

  // 2. Atlas Vector Search — top-10 candidates filtered by character + not deleted
  let rawResults: RawVectorResult[];
  try {
    rawResults = await Memory.aggregate<RawVectorResult>([
      {
        $vectorSearch: {
          index: ATLAS_VECTOR_INDEX,
          path: "embedding",
          queryVector,
          numCandidates: VECTOR_SEARCH_CANDIDATES,
          limit: VECTOR_SEARCH_LIMIT,
          filter: {
            character_id: { $eq: characterObjId },
            is_deleted: { $eq: false },
          },
        },
      },
      {
        $addFields: { vector_score: { $meta: "vectorSearchScore" } },
      },
      {
        $project: {
          content: 1,
          type: 1,
          sentiment: 1,
          created_at: 1,
          embedding: 1,
          vector_score: 1,
        },
      },
    ]);
  } catch (err) {
    // Atlas Vector Search index may not exist yet — degrade gracefully
    logger.warn({ err, characterId }, "Vector search failed — proceeding without memories");
    return "";
  }

  if (rawResults.length === 0) return "";

  // 3. Re-rank: 0.6 × cosine_similarity + 0.4 × recency_decay
  const scored: ScoredMemory[] = rawResults
    .map((m) => ({
      _id: m._id,
      content: m.content,
      type: m.type,
      created_at: m.created_at,
      final_score: COSINE_WEIGHT * m.vector_score + RECENCY_WEIGHT * recencyDecay(m.created_at),
      embedding: m.embedding,
    }))
    .sort((a, b) => b.final_score - a.final_score);

  // 4. Deduplicate: drop results that are too similar to a higher-scored result
  const deduplicated = deduplicateByEmbedding(scored);

  // 5. Update access metadata asynchronously — do not block conversation
  const retrievedIds = deduplicated.map((m) => m._id);
  void Memory.updateMany(
    { _id: { $in: retrievedIds } },
    { $inc: { access_count: 1 }, $set: { last_accessed_at: new Date() } }
  ).catch((err) => logger.error({ err }, "Failed to update memory access counts"));

  // 6. Format into memory block string
  return formatMemoryBlock(deduplicated);
}
