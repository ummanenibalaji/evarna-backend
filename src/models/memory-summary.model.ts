import { Schema, model } from "mongoose";
import type { IMemorySummary } from "../types/memory.types.js";

const followUpHintSchema = new Schema(
  {
    hint: { type: String, required: true },
    trigger_date: { type: Date, required: true },
    type: { type: String, required: true },
    status: { type: String, default: "pending" },
  },
  { _id: false }
);

const moodAssessmentSchema = new Schema(
  {
    distress_level: { type: String, default: "none" },
    should_follow_up: { type: Boolean, default: false },
    follow_up_delay_hours: { type: Number, default: 0 },
  },
  { _id: false }
);

const memorySummarySchema = new Schema<IMemorySummary>(
  {
    user_id: { type: String, required: true },
    character_id: { type: Schema.Types.ObjectId, ref: "Character", required: true },
    trigger_type: {
      type: String,
      enum: ["turn_count", "session_count"],
      required: true,
    },
    turns_covered: { type: Number, required: true },
    sessions_covered: { type: Number, required: true },
    since_turn_id: { type: Schema.Types.ObjectId, ref: "ConversationTurn", required: true },
    until_turn_id: { type: Schema.Types.ObjectId, ref: "ConversationTurn", required: true },
    mood_summary: { type: String, default: "" },
    recurring_topics: [{ type: String }],
    emotional_patterns: { type: Schema.Types.Mixed, default: {} },
    relationship_trajectory: { type: String, default: "" },
    new_facts_count: { type: Number, default: 0 },
    follow_up_hints: { type: [followUpHintSchema], default: [] },
    mood_assessment: { type: moodAssessmentSchema, default: () => ({}) },
    created_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// Index from PRD
memorySummarySchema.index({ character_id: 1, created_at: -1 });

export const MemorySummary = model<IMemorySummary>(
  "MemorySummary",
  memorySummarySchema
);
