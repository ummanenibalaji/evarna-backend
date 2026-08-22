import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { Memory } from "../models/memory.model.js";
import { saveFollowUps } from "../models/follow-up.model.js";
import { Session } from "../models/session.model.js";
import { MemorySummary } from "../models/memory-summary.model.js";
import { enqueueUsageSummary } from "../queues/memory.queue.js";
import { Character } from "../models/character.model.js";
import { getScenario, CUSTOM_MEMORY_GUIDANCE } from "../data/scenarios.js";
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

// The JSON contract is identical for every mode — same collection, same four
// types, same vector search. What changes per mode is the instruction about
// WHAT is worth remembering, which is the whole point of splitting these.
const JSON_CONTRACT = `Return valid JSON with this exact structure:
{
  "memories": [
    {
      "content": "concise memory written in third person",
      "type": "fact|emotion|event|preference",
      "sentiment": "positive|negative|neutral",
      "related_entities": ["entity1", "entity2"]
    }
  ],
  "mood_summary": "1-2 sentence summary of the user emotional state during this session",
  "topics": ["topic1", "topic2"],
  "follow_up_hints": [
    {
      "hint": "what to proactively raise next time",
      "trigger_date": "ISO date string for when to bring this up",
      "type": "event_follow_up|check_in|milestone",
      "status": "pending"
    }
  ]
}`;

const SHARED_RULES = `Rules:
- Only extract information explicitly stated. No inferences.
- Maximum 10 memories per session. Prioritize novel details not previously known.
- Write in third person using "user" ("user likes...", "user's sister...").
- Return empty arrays if nothing meaningful to extract.`;

const COMPANION_PROMPT = `You are a memory extraction assistant. Analyze the conversation and extract important facts about the USER that are worth remembering for future sessions.

${JSON_CONTRACT}

Type definitions:
- "fact": biographical or situational ("user has a sister named Priya")
- "emotion": emotional pattern ("user tends to feel anxious about career decisions")
- "event": specific past or upcoming event ("user interviewed at Amazon on Monday")
- "preference": interaction preference ("user prefers direct feedback over softening")

${SHARED_RULES}`;

/**
 * Studio sessions are practice, not conversation, and the difference matters.
 *
 * The companion prompt asks for facts about the user's life. Applied to a
 * rehearsal that produces two failures: it records the useless half (the role
 * they applied for) and misses the useful half (that they ramble on behavioural
 * questions), and — worse — it can write down things the ASSISTANT said while
 * playing a part as though they were facts about the user's real life. A
 * character playing the user's dismissive manager is not evidence about their
 * manager. That rule is stated first because it is the one that produces
 * confidently false memories.
 */
function studioPrompt(guidance: string): string {
  return `You are a memory extraction assistant. This was a Studio PRACTICE SESSION, not a personal conversation, and the assistant was playing a role the user chose.

CRITICAL: Nothing the assistant said is a fact about the user, their life, or the real people in it. The assistant was performing a part. Never record its lines, its claims, or the situation it portrayed as reality. Only the user's own statements about themselves can become facts about them.

Extract what would make the NEXT session with this same character better.

${guidance}

${JSON_CONTRACT}

Type definitions in this context:
- "fact": something durable about how the user approaches this practice, or setup they have established ("user is targeting backend roles at startups")
- "emotion": how they respond under this kind of pressure ("user gets defensive when interrupted mid-answer")
- "event": something that happened in a session worth referencing ("user completed a full mock interview without notes")
- "preference": how they want this character to behave ("user asked to be pushed harder")

${SHARED_RULES}`;
}

interface ExtractionContext {
  mode: string;
  studio?: { kind: string; scenario_id?: string } | null;
}

export function buildExtractionPrompt(ctx: ExtractionContext): string {
  if (ctx.mode !== "studio") return COMPANION_PROMPT;

  const scenario = ctx.studio?.scenario_id ? getScenario(ctx.studio.scenario_id) : undefined;
  return studioPrompt(scenario?.memory_guidance ?? CUSTOM_MEMORY_GUIDANCE);
}

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

  // 2. Which prompt to extract with depends on what kind of character this is.
  // Companion and studio want genuinely different things remembered.
  const character = await Character.findById(characterObjId)
    .select("mode studio_config")
    .lean();
  const characterMode = character?.mode ?? "companion";
  const systemPrompt = buildExtractionPrompt({
    mode: characterMode,
    studio: character?.studio_config ?? null,
  });

  // 3. Format conversation text for LLM (cap at 100 most recent turns)
  const conversationText = turns
    .slice(-100)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content_text}`)
    .join("\n");

  // 4. Extract memories via GPT-4o Mini
  const openai = getOpenAI();
  let extraction: ExtractionResult;

  try {
    const response = await openai.chat.completions.create({
      model: MODELS.SUMMARIZATION,
      messages: [
        { role: "system", content: systemPrompt },
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
    // A session can produce nothing worth storing as a memory and still be
    // worth following up on ("interview is Thursday") — queue the hints anyway.
    await saveFollowUps(extraction.follow_up_hints, {
      user_id: userId,
      character_id: characterObjId,
      session_id: sessionObjId,
    });
    await checkUsageSummaryThreshold(characterId, userId, characterObjId, characterMode);
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

  // 6. Queue any follow-up hints as their own work items. Extraction runs after
  // every session, so this is the bulk of the supply — until now it was parsed
  // and thrown away.
  await saveFollowUps(extraction.follow_up_hints, {
    user_id: userId,
    character_id: characterObjId,
    session_id: sessionObjId,
  });

  // 7. Check usage-summary threshold and enqueue Job 2 if met
  await checkUsageSummaryThreshold(characterId, userId, characterObjId, characterMode);
}

/**
 * The usage summary is a companion artefact — it produces mood patterns and a
 * "relationship_trajectory", which is a real thing to track with a companion
 * and meaningless for an interview coach.
 *
 * ponytail: studio characters are skipped rather than given their own summary
 * prompt. Cross-session progress ("five sessions in, stronger on structure") is
 * genuinely worth having, but the per-scenario memories now carry most of it,
 * and a wrong summary injected into every turn is worse than no summary. The
 * upgrade is a studio-flavoured summariser in memory-summary.service.ts.
 */
async function checkUsageSummaryThreshold(
  characterId: string,
  userId: string,
  characterObjId: Types.ObjectId,
  mode = "companion"
): Promise<void> {
  if (mode === "studio") {
    logger.debug({ characterId }, "Studio character — skipping usage summary");
    return;
  }
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
