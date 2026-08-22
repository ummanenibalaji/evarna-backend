import { Schema, model } from "mongoose";
import type { IMemory } from "../types/memory.types.js";

const sliderHintSchema = new Schema(
  {
    trait: {
      type: String,
      enum: ["warmth", "humor", "directness", "energy", "formality"],
      required: true,
    },
    direction: { type: String, enum: ["up", "down"], required: true },
  },
  { _id: false }
);

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
    // Present on preference memories the extractor could map to a slider.
    // `default: undefined` rather than `{}` so the sparse index below actually
    // stays sparse and `{ slider_hint: { $ne: null } }` means what it says.
    slider_hint: { type: sliderHintSchema, default: undefined },
    access_count: { type: Number, default: 0 },
    last_accessed_at: { type: Date, default: () => new Date() },
    is_deleted: { type: Boolean, default: false },
    created_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// Compound index from PRD
memorySchema.index({ character_id: 1, is_deleted: 1, type: 1 });

// Adaptation reads only the handful of memories carrying a hint. Sparse because
// the overwhelming majority never will.
memorySchema.index({ character_id: 1, slider_hint: 1 }, { sparse: true });

export const Memory = model<IMemory>("Memory", memorySchema);
