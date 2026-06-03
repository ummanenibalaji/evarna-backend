import { Schema, model } from "mongoose";
import type { IUser } from "../types/user.types.js";

const userSchema = new Schema<IUser>(
  {
    display_name: { type: String, required: true, trim: true },
    gender: {
      type: String,
      enum: ["male", "female", "nonbinary", "undisclosed"],
      required: true,
    },
    date_of_birth: { type: Date, required: true },
    is_minor: { type: Boolean, required: true },
    communication_style: {
      type: String,
      enum: ["warm", "direct", "funny", "calm"],
      required: true,
    },
    onboarding_completed: { type: Boolean, default: false },
    created_at: { type: Date, default: () => new Date() },
    last_active_at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, versionKey: false }
);

export const User = model<IUser>("User", userSchema);
