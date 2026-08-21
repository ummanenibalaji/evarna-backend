import type { Archetype, CharacterGender, IPersonalitySliders } from "./character.types.js";

export type UserGender = "male" | "female" | "nonbinary" | "undisclosed";
export type CommunicationStyle = "warm" | "direct" | "funny" | "calm";
export type AuthProvider = "google" | "apple" | "email";

export interface IUser {
  auth_provider: AuthProvider;
  provider_sub: string;
  email: string | null;
  token_version: number;
  // Optional until onboarding completes — sign-in creates the user first.
  display_name?: string;
  gender?: UserGender;
  date_of_birth?: Date;
  is_minor: boolean;
  communication_style?: CommunicationStyle;
  onboarding_completed: boolean;
  created_at: Date;
  last_active_at: Date;
}

export interface CompanionConfig {
  name: string;
  archetype: Archetype;
  gender: CharacterGender;
  voice_id: string;
  personality_sliders?: Partial<IPersonalitySliders>;
}

export interface OnboardRequest {
  display_name: string;
  gender: UserGender;
  date_of_birth: string; // ISO date string, e.g. "2000-01-15"
  communication_style: CommunicationStyle;
  intent: string;        // collected in S05; drives archetype selection, not stored separately
  companion: CompanionConfig;
}

export interface OnboardResponse {
  user_id: string;
  character_id: string;
  is_minor: boolean;
}

export interface AuthSessionResponse {
  token: string;
  user_id: string;
  onboarding_completed: boolean;
}
