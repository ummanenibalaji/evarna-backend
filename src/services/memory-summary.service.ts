import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { Session } from "../models/session.model.js";
import { MemorySummary } from "../models/memory-summary.model.js";
import { logger } from "../utils/logger.js";
import type { IMemorySummary } from "../types/memory.types.js";

interface SummaryLLMResult {
  mood_summary: string;
  recurring_topics: string[];
  emotional_patterns: Record<string, string>;
  relationship_trajectory: string;
  follow_up_hints: Array<{
    hint: string;
    trigger_date: string;
    type: string;
    status: string;
  }>;
  distress_level: string;
  should_follow_up: boolean;
  follow_up_delay_hours: number;
}

const SUMMARY_SYSTEM_PROMPT = `You are analyzing conversation history between a user and their AI companion. Generate a structured summary of patterns, mood, and relationship dynamics.

Return valid JSON with this exact structure:
{
  "mood_summary": "2-3 sentence summary of the user's emotional patterns and current state",
  "recurring_topics": ["topic1", "topic2"],
  "emotional_patterns": {
    "emotion_name": "description of the pattern"
  },
  "relationship_trajectory": "1-2 sentences on how the relationship is evolving",
  "follow_up_hints": [
    {
      "hint": "what to proactively bring up in future conversations",
      "trigger_date": "ISO date string for when to raise this",
      "type": "event_follow_up|check_in|milestone",
      "status": "pending"
    }
  ],
  "distress_level": "none|low|medium|high",
  "should_follow_up": false,
  "follow_up_delay_hours": 0
}

Focus on patterns across the entire conversation history provided, not just individual messages.`;

export async function generateUsageSummary(
  characterId: string,
  userId: string
): Promise<void> {
  const characterObjId = new Types.ObjectId(characterId);

  // 1. Find the latest summary to determine the starting point
  const lastSummary = await MemorySummary.findOne({ character_id: characterObjId })
    .sort({ created_at: -1 })
    .lean();

  const sinceDate = lastSummary?.created_at ?? new Date(0);

  // 2. Fetch all turns since last summary
  const turns = await ConversationTurn.find({
    character_id: characterObjId,
    created_at: { $gt: sinceDate },
  })
    .sort({ created_at: 1 })
    .lean();

  if (turns.length === 0) {
    logger.info({ characterId }, "No turns since last summary — skipping");
    return;
  }

  const sinceTurnId = turns[0]!._id as Types.ObjectId;
  const untilTurnId = turns[turns.length - 1]!._id as Types.ObjectId;

  // 3. Count sessions covered
  const sessionsCovered = await Session.countDocuments({
    character_id: characterObjId,
    ended_at: { $gt: sinceDate },
    status: "completed",
  });

  // 4. Format conversation for LLM (cap at 200 most recent turns to stay within context)
  const conversationText = turns
    .slice(-200)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content_text}`)
    .join("\n");

  // 5. Generate summary via GPT-4o Mini
  const openai = getOpenAI();
  let result: SummaryLLMResult;

  try {
    const response = await openai.chat.completions.create({
      model: MODELS.SUMMARIZATION,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Generate a summary for this conversation history:\n\n${conversationText}`,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1000,
      temperature: 0.3,
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    result = JSON.parse(raw) as SummaryLLMResult;
  } catch (err) {
    logger.error({ err, characterId }, "Usage summary LLM call failed");
    return;
  }

  // 6. Write MemorySummary document
  const followUpHints = Array.isArray(result.follow_up_hints)
    ? result.follow_up_hints.map((h) => ({
        hint: h.hint ?? "",
        trigger_date: h.trigger_date ? new Date(h.trigger_date) : new Date(),
        type: h.type ?? "check_in",
        status: h.status ?? "pending",
      }))
    : [];

  try {
    await MemorySummary.create({
      user_id: userId,
      character_id: characterObjId,
      trigger_type: "turn_count",
      turns_covered: turns.length,
      sessions_covered: sessionsCovered,
      since_turn_id: sinceTurnId,
      until_turn_id: untilTurnId,
      mood_summary: result.mood_summary ?? "",
      recurring_topics: Array.isArray(result.recurring_topics) ? result.recurring_topics : [],
      emotional_patterns: result.emotional_patterns ?? {},
      relationship_trajectory: result.relationship_trajectory ?? "",
      new_facts_count: 0,
      follow_up_hints: followUpHints,
      mood_assessment: {
        distress_level: result.distress_level ?? "none",
        should_follow_up: result.should_follow_up ?? false,
        follow_up_delay_hours: result.follow_up_delay_hours ?? 0,
      },
    });

    logger.info(
      { characterId, turnsCovered: turns.length, sessionsCovered },
      "Usage summary written"
    );
  } catch (err) {
    logger.error({ err, characterId }, "Failed to write usage summary");
  }
}

export async function getLatestUsageSummary(
  characterId: string
): Promise<IMemorySummary | null> {
  return MemorySummary.findOne({ character_id: new Types.ObjectId(characterId) })
    .sort({ created_at: -1 })
    .lean();
}

export function formatUsageSummary(summary: IMemorySummary): string {
  const parts: string[] = ["[Recent patterns]"];

  if (summary.mood_summary) {
    parts.push(`Mood: ${summary.mood_summary}`);
  }

  if (summary.recurring_topics.length > 0) {
    parts.push(`Topics: ${summary.recurring_topics.join(", ")}`);
  }

  const patternEntries = Object.entries(summary.emotional_patterns ?? {});
  if (patternEntries.length > 0) {
    const patternStr = patternEntries.map(([k, v]) => `${k}: ${v}`).join("; ");
    parts.push(`Emotional patterns: ${patternStr}`);
  }

  if (summary.relationship_trajectory) {
    parts.push(`Relationship: ${summary.relationship_trajectory}`);
  }

  return parts.join("\n");
}
