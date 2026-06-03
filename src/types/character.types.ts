import type { Types } from "mongoose";

export type Archetype = "mentor" | "bestfriend" | "challenger" | "partner";
export type CharacterGender = "male" | "female" | "nonbinary";
export type CharacterMode = "companion";

export interface IPersonalitySliders {
  warmth: number;      // 0-100
  humor: number;
  directness: number;
  energy: number;
  formality: number;
}

export interface IVoiceConfig {
  speed: number;
  background_sound: string;
}

export interface IPersonaConfig {
  system_prompt: string;
  behavioral_rules: string[];
  boundaries: string[];
  safety_overrides: string[];
}

export interface ICharacter {
  user_id: string;
  mode: CharacterMode;
  archetype: Archetype;
  name: string;
  gender: CharacterGender;
  voice_id: string;
  voice_config: IVoiceConfig;
  avatar_source: "preset";
  persona_config: IPersonaConfig;
  personality_sliders: IPersonalitySliders;
  memory_enabled: boolean;
  is_active: boolean;
  created_at: Date;
  last_interaction_at: Date;
  total_sessions: number;
  total_voice_minutes: number;
}
