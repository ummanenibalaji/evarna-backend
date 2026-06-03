import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { Memory } from "../models/memory.model.js";
import { Session } from "../models/session.model.js";
import { MemorySummary } from "../models/memory-summary.model.js";
import { enqueueUsageSummary } from "../queues/memory.queue.js";
import { logger } from "../utils/logger.js";
import type { MemoryExtractionPayload } from "../queues/memory.queue.js";

interface ExtractedMemory {
  content: string;
  type: "fact" | "emotion" | "event" | "preference";
  sentiment: string;
  related_entities: string[];
}

interface ExtractionResult {
  memories: ExtractedMemory[];
  mood_summary: string;
  topics: string[];
  follow_up_hints: Array<{ hint: string; trigger_date: string; type: string; status: string }>;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Analyze the conversation and extract important facts about the USER that are worth remembering for future sessions.

Return valid JSON with this exact structure:
{
  "memories": [
    {
      "content": "concise fact about the user written in third person",
      "type": "fact|emotion|event|preference",
      "sentiment": "positive|negative|neutral",
      "related_entities": ["entity1", "entity2"]
    }
  ],
  "mood_summary": "1-2 sentence summary of the user emotional state during this session",
  "topics": ["topic1", "topic2"],
  "follow_up_hints": [
    {
      "hint": "what to proactively ask about next time",
      "trigger_date": "ISO date string for when to bring this up",
      "type": "event_follow_up|check_in|milestone",
      "status": "pending"
    }
  ]
}

Type definitions:
- "fact": biographical or situational ("user has a sister named Priya")
- "emotion": emotional pattern ("user tends to feel anxious about career decisions")
- "event": specific past or upcoming event ("user interviewed at Amazon on Monday")
- "preference": interaction preference ("user prefers direct feedback over softening")

Rules:
- Only extract information explicitly stated. No inferences.
- Maximum 10 memories per session. Prioritize novel facts not previously known.
- Write facts in third person using "user" ("user likes...", "user's sister...").
- Return empty arrays if nothing meaningful to extract.`;

const USAGE_SUMMARY_THRESHOLD_TURNS = 50;
const USAGE_SUMMARY_THRESHOLD_SESSIONS = 5;

export async function runMemoryExtraction(payload: MemoryExtractionPayload): Promise<void> {
  const { sessionId, characterId, userId } = payload;
  const sessionObjId = new Types.ObjectId(sessionId);
  const characterObjId = new Types.ObjectId(characterId);

  // 1. Fetch all conversation turns for this session
  const turns = await ConversationTurn.find({ session_id: sessionObjId })
    .sort({ created_at: 1 })
    .lean();

  if (turns.length === 0) {
    logger.info({ sessionId }, "No turns found for memory extraction");
    return;
  }

  // 2. Format conversation text for LLM (cap at 100 most recent turns)
  const conversationText = turns
    .slice(-100)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content_text}`)
    .join("\n");

  // 3. Extract memories via GPT-4o Mini
  const openai = getOpenAI();
  let extraction: ExtractionResult;

  try {
    const response = await openai.chat.completions.create({
      model: MODELS.SUMMARIZATION,
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: `Conversation:\n${conversationText}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1200,
      temperature: 0.2,
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    extraction = JSON.parse(raw) as ExtractionResult;
  } catch (err) {
    logger.error({ err, sessionId }, "Memory extraction LLM call failed");
    return;
  }

  const memories: ExtractedMemory[] = Array.isArray(extraction.memories)
    ? extraction.memories.filter((m) => m.content && m.type)
    : [];
  const topics: string[] = Array.isArray(extraction.topics) ? extraction.topics : [];
  const moodSummary = extraction.mood_summary ?? "";

  // Update session summary regardless of whether memories were extracted
  await Session.findByIdAndUpdate(sessionObjId, {
    $set: {
      summary: {
        topics: topics ?? [],
        mood_arc: { start: "", end: moodSummary ?? "" },
        memory_count: memories.length,
      },
    },
  }).catch((err) => logger.error({ err, sessionId }, "Failed to update session summary"));

  if (memories.length === 0) {
    logger.info({ sessionId }, "No memories extracted from session");
    await checkUsageSummaryThreshold(characterId, userId, characterObjId);
    return;
  }

  // 4. Batch-embed all memory contents in a single API call
  let embeddings: number[][];
  try {
    const embeddingResponse = await openai.embeddings.create({
      model: MODELS.EMBEDDING,
      input: memories.map((m) => m.content),
    });
    // API returns embeddings in original order; sort by index to be safe
    embeddings = embeddingResponse.data
      .sort((a, b) => a.index - b.index)
      .map((e) => e.embedding);
  } catch (err) {
    logger.error({ err, sessionId }, "Memory embedding API call failed");
    return;
  }

  // 5. Insert memories into MongoDB
  const now = new Date();
  const memoryDocs = memories.map((m, i) => ({
    user_id: userId,
    character_id: characterObjId,
    content: m.content,
    type: m.type,
    sentiment: m.sentiment ?? "neutral",
    embedding: embeddings[i] ?? [],
    source_session_id: sessionObjId,
    related_entities: Array.isArray(m.related_entities) ? m.related_entities : [],
    access_count: 0,
    last_accessed_at: now,
    is_deleted: false,
    created_at: now,
  }));

  try {
    await Memory.insertMany(memoryDocs, { ordered: false });
    logger.info({ sessionId, count: memoryDocs.length }, "Memories inserted");
  } catch (err) {
    logger.error({ err, sessionId }, "Memory insert failed");
    return;
  }

  // 6. Check usage-summary threshold and enqueue Job 2 if met
  await checkUsageSummaryThreshold(characterId, userId, characterObjId);
}

async function checkUsageSummaryThreshold(
  characterId: string,
  userId: string,
  characterObjId: Types.ObjectId
): Promise<void> {
  try {
    const lastSummary = await MemorySummary.findOne({ character_id: characterObjId })
      .sort({ created_at: -1 })
      .select({ created_at: 1 })
      .lean();

    const sinceDate = lastSummary?.created_at ?? new Date(0);

    const [turnsSince, sessionsSince] = await Promise.all([
      ConversationTurn.countDocuments({
        character_id: characterObjId,
        created_at: { $gt: sinceDate },
      }),
      Session.countDocuments({
        character_id: characterObjId,
        ended_at: { $gt: sinceDate },
        status: "completed",
      }),
    ]);

    logger.info(
      { characterId, turnsSince, sessionsSince },
      "Usage summary threshold check"
    );

    if (
      turnsSince >= USAGE_SUMMARY_THRESHOLD_TURNS ||
      sessionsSince >= USAGE_SUMMARY_THRESHOLD_SESSIONS
    ) {
      await enqueueUsageSummary({ characterId, userId });
    }
  } catch (err) {
    logger.error({ err, characterId }, "Usage summary threshold check failed");
  }
}
