import { Schema, model } from "mongoose";
import type { IReport } from "../types/report.types.js";

const reportSchema = new Schema<IReport>(
  {
    user_id: { type: String, required: true, index: true },
    turn_id: { type: Schema.Types.ObjectId, ref: "ConversationTurn", required: true },
    session_id: { type: Schema.Types.ObjectId, ref: "Session", required: true },
    character_id: { type: Schema.Types.ObjectId, ref: "Character", required: true },
    reason: {
      type: String,
      enum: ["harmful", "sexual", "inappropriate_minor", "inaccurate", "other"],
      required: true,
    },
    // Length capped in the route (zod), not here — a schema-level maxlength
    // failure surfaces as a 500 from Mongoose instead of a 400.
    note: { type: String, default: "" },
    // Copy of the reported message text, taken at report time. The turn itself
    // can disappear later — account deletion wipes a user's turns — and a
    // report with no content is useless to whoever reviews it.
    content_snapshot: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "reviewed", "actioned"],
      default: "open",
    },
    created_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

// The only query anyone runs: open reports, newest first.
reportSchema.index({ status: 1, created_at: -1 });

export const Report = model<IReport>("Report", reportSchema);
