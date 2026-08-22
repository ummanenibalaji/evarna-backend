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

/**
 * Phase C state: what has been offered, what has been answered, and what was
 * changed recently enough that the companion should be aware of it.
 *
 * It lives on the character rather than the user because the tuning is
 * per-relationship — being blunter with one companion says nothing about how
 * someone wants to be spoken to by another.
 */
export interface IAdaptation {
  /** The outstanding offer, if any. Cleared when answered. */
  suggestion?: {
    memory_id: string;
    trait: keyof IPersonalitySliders;
    direction: "up" | "down";
    offered_at: Date;
  } | null;
  /** Starts the one-a-week cooldown. Separate from `suggestion` so an ignored
   *  offer does not silently suppress every future one. */
  last_offered_at?: Date | null;
  /** Applied or dismissed — either way, never offered again. */
  handled_memory_ids?: string[];
  /** Fed into the identity block so the change is acknowledged, not silent. */
  recent_change?: {
    trait: keyof IPersonalitySliders;
    direction: "up" | "down";
    at: Date;
  } | null;
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
  adaptation?: IAdaptation;
  memory_enabled: boolean;
  is_active: boolean;
  created_at: Date;
  last_interaction_at: Date;
  total_sessions: number;
  total_voice_minutes: number;
}
