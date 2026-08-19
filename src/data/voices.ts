/**
 * The user-facing voice catalog. Voices are not bound to archetypes — any user
 * can pick any voice during onboarding (S07) or in settings later.
 *
 * `id` is the Hume custom-voice UUID. Pass it to the TTS pipeline as
 * `voice: { id, provider: "CUSTOM_VOICE" }`.
 */

export interface WhisperVoice {
  id: string;
  name: string;
  gender: "male" | "female";
  personality: string;
  previewText: string;
}

export const WHISPER_VOICES: WhisperVoice[] = [
  {
    id: "944adf80-0d6e-4909-b6fa-078784d6f8c5",
    name: "Kai",
    gender: "male",
    personality: "Warm and gentle — a close friend speaking softly at night.",
    previewText: "Hey, I'm Kai. I'm really glad you're here.",
  },
  {
    id: "3866d4e7-0188-4010-92be-836d927e84e0",
    name: "Theo",
    gender: "male",
    personality: "Thoughtful and present — someone who genuinely listens.",
    previewText: "Hey, I'm Theo. I'm really glad you're here.",
  },
  {
    id: "c050bc97-0e14-44ba-8c23-ae353fee972d",
    name: "Maya",
    gender: "female",
    personality: "Warm and expressive — the friend who makes you feel safe being honest.",
    previewText: "Hey, I'm Maya. I'm really glad you're here.",
  },
  {
    id: "3cd1f2e8-12f0-48b5-ade4-9e06241b8252",
    name: "Iris",
    gender: "female",
    personality: "Soft and intimate — gentle, attentive, deeply human.",
    previewText: "Hey, I'm Iris. I'm really glad you're here.",
  },
];

/**
 * The catalog/DB voice ids above are custom-voice UUIDs from the original Hume
 * account, which the current account cannot access. They stay as stable
 * internal keys (characters in Mongo reference them); this map translates them
 * to voices the active Hume account can actually synthesize with.
 */
export const HUME_VOICE_MAP: Record<string, { id: string; provider: "HUME_AI" | "CUSTOM_VOICE" }> = {
  // Kai → Colton Rivers
  "944adf80-0d6e-4909-b6fa-078784d6f8c5": { id: "d8ab67c6-953d-4bd8-9370-8fa53a0f1453", provider: "HUME_AI" },
  // Theo → Sebastian Lockwood
  "3866d4e7-0188-4010-92be-836d927e84e0": { id: "522fc367-961f-4817-8929-81f433b4afe9", provider: "HUME_AI" },
  // Maya → Ava Song
  "c050bc97-0e14-44ba-8c23-ae353fee972d": { id: "5bb7de05-c8fe-426a-8fcc-ba4fc4ce9f9c", provider: "HUME_AI" },
  // Iris → Relaxing ASMR Woman
  "3cd1f2e8-12f0-48b5-ade4-9e06241b8252": { id: "aeaaf1f8-fe31-49ae-893d-c744e5207bc2", provider: "HUME_AI" },
};

export function resolveHumeVoice(voiceId: string): { id: string; provider: "HUME_AI" | "CUSTOM_VOICE" } {
  return HUME_VOICE_MAP[voiceId] ?? { id: voiceId, provider: "CUSTOM_VOICE" };
}

export function getVoice(voiceId: string): WhisperVoice | undefined {
  return WHISPER_VOICES.find((v) => v.id === voiceId);
}

/** Default voice when onboarding doesn't specify one. */
export const DEFAULT_VOICE_ID = "c050bc97-0e14-44ba-8c23-ae353fee972d"; // Maya
