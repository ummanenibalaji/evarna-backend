import { Schema, model } from "mongoose";
import type { ICharacter } from "../types/character.types.js";

const personaConfigSchema = new Schema(
  {
    system_prompt: { type: String, required: true },
    behavioral_rules: [{ type: String }],
    boundaries: [{ type: String }],
    safety_overrides: [{ type: String }],
  },
  { _id: false }
);

const personalitySlidersSchema = new Schema(
  {
    warmth: { type: Number, min: 0, max: 100, default: 70 },
    humor: { type: Number, min: 0, max: 100, default: 50 },
    directness: { type: Number, min: 0, max: 100, default: 60 },
    energy: { type: Number, min: 0, max: 100, default: 65 },
    formality: { type: Number, min: 0, max: 100, default: 50 },
  },
  { _id: false }
);

const voiceConfigSchema = new Schema(
  {
    speed: { type: Number, default: 1.0 },
    background_sound: { type: String, default: "none" },
  },
  { _id: false }
);

// Mixed for `params` because each scenario defines its own keys (role,
// personality, topic, genre…). Validating them per-scenario happens in
// character.service.ts against the scenario definition, which is the only place
// that knows what a given scenario expects.
const studioConfigSchema = new Schema(
  {
    kind: { type: String, enum: ["scenario", "custom"], required: true },
    scenario_id: { type: String },
    params: { type: Schema.Types.Mixed, default: {} },
    backstory: { type: String, maxlength: 500 },
  },
  { _id: false }
);

const characterSchema = new Schema<ICharacter>(
  {
    user_id: { type: String, required: true, index: true },
    mode: { type: String, enum: ["companion", "studio"], default: "companion" },
    // Required for companions, meaningless for studio characters. Expressed as
    // a function so a studio character cannot be created without one by
    // accident, and a companion cannot be created without one at all.
    archetype: {
      type: String,
      enum: ["mentor", "bestfriend", "challenger", "partner"],
      required: function (this: { mode?: string }): boolean {
        return this.mode !== "studio";
      },
    },
    studio_config: { type: studioConfigSchema, default: undefined },
    name: { type: String, required: true, trim: true },
    gender: {
      type: String,
      enum: ["male", "female", "nonbinary"],
      required: true,
    },
    voice_id: { type: String, required: true },
    voice_config: { type: voiceConfigSchema, default: () => ({}) },
    avatar_source: { type: String, enum: ["preset"], default: "preset" },
    persona_config: { type: personaConfigSchema, required: true },
    personality_sliders: { type: personalitySlidersSchema, default: () => ({}) },
    memory_enabled: { type: Boolean, default: true },
    is_active: { type: Boolean, default: true },
    created_at: { type: Date, default: () => new Date() },
    last_interaction_at: { type: Date, default: () => new Date() },
    total_sessions: { type: Number, default: 0 },
    total_voice_minutes: { type: Number, default: 0 },
  },
  { timestamps: false, versionKey: false }
);

export const Character = model<ICharacter>("Character", characterSchema);
