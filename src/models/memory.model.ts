import { Schema, model } from "mongoose";
import type { IMemory } from "../types/memory.types.js";

const memorySchema = new Schema<IMemory>(
  {
    user_id: { type: String, required: true },
    character_id: { type: Schema.Types.ObjectId, ref: "Character", required: true },
    content: { type: String, required: true },
    type: {
      type: String,
      enum: ["fact", "emotion", "event", "preference"],
      required: true,
    },
    sentiment: { type: String, default: "neutral" },
    // 1536-dimension vector — Atlas Vector Search index configured separately in Atlas UI
    embedding: { type: [Number], required: true },
    source_session_id: { type: Schema.Types.ObjectId, ref: "Session", required: true },
    related_entities: [{ type: String }],
    access_count: { type: Number, default: 0 },
    last_accessed_at: { type: Date, default: () => new Date() },
    is_deleted: { type: Boolean, default: false },
    created_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// Compound index from PRD
memorySchema.index({ character_id: 1, is_deleted: 1, type: 1 });

export const Memory = model<IMemory>("Memory", memorySchema);
