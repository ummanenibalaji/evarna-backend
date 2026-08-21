import type { Types } from "mongoose";

export type Archetype = "mentor" | "bestfriend" | "challenger" | "partner";
export type CharacterGender = "male" | "female" | "nonbinary";
export type CharacterMode = "companion" | "studio";
export type StudioKind = "scenario" | "custom";

/**
 * Studio-only configuration. Present when mode === "studio", absent otherwise.
 *
 * `params` holds the scenario's setup answers (role, personality, topic…) and
 * is what buildPersona() renders into a persona. `backstory` is the free text a
 * user wrote for a custom character — the only user-authored string in the
 * product that reaches a system prompt, which is why it is fenced when rendered
 * (see buildCustomStudioPersona).
 */
export interface IStudioConfig {
  kind: StudioKind;
  scenario_id?: string;
  params?: Record<string, string>;
  backstory?: string;
}

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
  // Companion-only. A studio character is a scenario counterpart or a
  // user-written character; neither has an archetype.
  archetype?: Archetype;
  studio_config?: IStudioConfig;
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
