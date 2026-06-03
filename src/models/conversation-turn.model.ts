import { Schema, model } from "mongoose";
import type { IConversationTurn } from "../types/conversation.types.js";

const conversationTurnSchema = new Schema<IConversationTurn>(
  {
    session_id: { type: Schema.Types.ObjectId, ref: "Session", required: true },
    character_id: { type: Schema.Types.ObjectId, ref: "Character", required: true },
    user_id: { type: String, required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content_text: { type: String, required: true },
    content_audio_url: { type: String, default: null },
    sentiment_score: { type: Number, min: -1, max: 1, default: 0 },
    safety_flags: {
      categories: { type: Schema.Types.Mixed, default: {} },
      flagged: { type: Boolean, default: false },
    },
    tokens_used: {
      input: { type: Number, default: 0 },
      output: { type: Number, default: 0 },
    },
    model_used: { type: String, default: "" },
    latency_ms: { type: Number, default: 0 },
    created_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// Indexes from PRD
conversationTurnSchema.index({ session_id: 1, created_at: 1 });
conversationTurnSchema.index({ user_id: 1, created_at: 1 });

export const ConversationTurn = model<IConversationTurn>(
  "ConversationTurn",
  conversationTurnSchema
);
