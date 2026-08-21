import { Schema, model, Types } from "mongoose";
import type { ISession } from "../types/session.types.js";

const sessionSummarySchema = new Schema(
  {
    topics: [{ type: String }],
    mood_arc: {
      start: { type: String, default: "" },
      end: { type: String, default: "" },
    },
    memory_count: { type: Number, default: 0 },
  },
  { _id: false }
);

const sessionSchema = new Schema<ISession>(
  {
    user_id: { type: String, required: true, index: true },
    character_id: { type: Schema.Types.ObjectId, ref: "Character", required: true, index: true },
    mode: { type: String, enum: ["companion", "studio"], default: "companion" },
    session_type: {
      type: String,
      enum: ["text", "voice_call", "voice_note"],
      required: true,
    },
    started_at: { type: Date, default: () => new Date() },
    ended_at: { type: Date, default: null },
    duration_seconds: { type: Number, default: 0 },
    voice_minutes_consumed: { type: Number, default: 0 },
    // Studio's "Remember this session" toggle. When false, ending the session
    // does not enqueue memory extraction, so nothing from it is ever written to
    // long-term memory. Defaults true — companions always remember.
    memory_enabled: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["active", "completed", "interrupted"],
      default: "active",
    },
    summary: { type: sessionSummarySchema, default: null },
  },
  { timestamps: false, versionKey: false }
);

// Compound index: stale-session cleanup queries { status: "active", started_at: < cutoff }
sessionSchema.index({ status: 1, started_at: 1 });

export const Session = model<ISession>("Session", sessionSchema);
