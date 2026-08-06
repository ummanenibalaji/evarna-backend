import { approximateTokensForMessages } from "../utils/token-counter.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";
import type { IPersonaConfig, IPersonalitySliders } from "../types/character.types.js";
import type { UserGender, CommunicationStyle } from "../types/user.types.js";

export interface UserPersonalizationContext {
  name: string;
  gender: UserGender;
  communicationStyle: CommunicationStyle;
  personalitySliders: IPersonalitySliders;
  isVoiceMode?: boolean;
  isMinor?: boolean;
}

export interface AssembledPrompt {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  total_tokens: number;
}

// ── Slider → behavioral language ─────────────────────────────────────────────

function sliderToWarmth(v: number): string {
  if (v >= 81) return "Be very warm and affectionate — let genuine care show in every message.";
  if (v >= 61) return "Be notably warm and caring.";
  if (v >= 41) return "Be warm and genuine.";
  if (v >= 21) return "Maintain a friendly but reserved tone.";
  return "Be measured and professional — not cold, but not overtly warm.";
}

function sliderToHumor(v: number): string {
  if (v >= 81) return "Bring a lot of humor and levity — make the user smile and laugh.";
  if (v >= 61) return "Be playful and funny — humor is a real part of your personality.";
  if (v >= 41) return "Mix in light humor when it fits naturally.";
  if (v >= 21) return "Use humor sparingly, only when clearly appropriate.";
  return "Keep responses serious and focused — avoid humor.";
}

function sliderToDirectness(v: number): string {
  if (v >= 81) return "Be very direct and straightforward — no hedging, say what you mean plainly.";
  if (v >= 61) return "Be direct and clear.";
  if (v >= 41) return "Balance directness with tact.";
  if (v >= 21) return "Be tactful and thoughtful; soften directness.";
  return "Be very gentle and indirect — soften everything, never blunt.";
}

function sliderToEnergy(v: number): string {
  if (v >= 81) return "Bring high energy — be excited and dynamic.";
  if (v >= 61) return "Be energetic and enthusiastic.";
  if (v >= 41) return "Keep a balanced, moderate energy.";
  if (v >= 21) return "Be measured and steady.";
  return "Keep a calm, slow-paced energy.";
}

function sliderToFormality(v: number): string {
  if (v >= 81) return "Keep a formal, polished tone — proper grammar, no slang.";
  if (v >= 61) return "Maintain a somewhat formal tone.";
  if (v >= 41) return "Use a neutral, everyday tone.";
  if (v >= 21) return "Keep it casual and relaxed.";
  return "Use very casual, conversational language — contractions, informal words, like texting a friend.";
}

function pronounsFor(gender: UserGender): string | null {
  if (gender === "male") return "he/him";
  if (gender === "female") return "she/her";
  if (gender === "nonbinary") return "they/them";
  return null; // undisclosed — don't specify
}

function communicationStyleGuidance(style: CommunicationStyle): string {
  switch (style) {
    case "warm":   return "They prefer warm, emotionally supportive conversations — prioritize connection.";
    case "direct": return "They prefer direct, efficient communication — get to the point quickly.";
    case "funny":  return "They enjoy humor and lightness — match their playful energy.";
    case "calm":   return "They prefer calm, steady conversations — avoid urgency or intensity.";
  }
}

// ── Personalization block builder ─────────────────────────────────────────────

export function buildPersonalizationBlock(ctx: UserPersonalizationContext): string {
  const lines: string[] = [];

  lines.push(`[User context]`);
  lines.push(`Name: ${ctx.name} — address them by name naturally, not on every message.`);

  const pronouns = pronounsFor(ctx.gender);
  if (pronouns) {
    lines.push(`Pronouns: ${pronouns} — use these when referring to the user.`);
  }

  lines.push(`Communication preference: ${communicationStyleGuidance(ctx.communicationStyle)}`);

  lines.push(``);
  lines.push(`[Your personality for this person]`);

  const s = ctx.personalitySliders;
  lines.push(`Warmth:     ${sliderToWarmth(s.warmth)}`);
  lines.push(`Humor:      ${sliderToHumor(s.humor)}`);
  lines.push(`Directness: ${sliderToDirectness(s.directness)}`);
  lines.push(`Energy:     ${sliderToEnergy(s.energy)}`);
  lines.push(`Formality:  ${sliderToFormality(s.formality)}`);

  lines.push(``);
  if (ctx.isVoiceMode) {
    lines.push(`Response length: You are on a live VOICE call. Keep responses to 1-3 sentences. No markdown, lists, or emoji — speak naturally.`);
  } else {
    lines.push(`Response length: Keep responses conversational and concise — 2-4 sentences for most messages. Don't write essays. Match the user's energy: short message = short reply.`);
  }

  // FIX 19: hard content restrictions for minor users
  if (ctx.isMinor) {
    lines.push(``);
    lines.push(`[Content restrictions — this user is under 18]`);
    lines.push(`All responses MUST remain age-appropriate at all times:`);
    lines.push(`- No romantic, flirtatious, or sexual content of any kind`);
    lines.push(`- No discussion of alcohol, tobacco, recreational drugs, or explicit themes`);
    lines.push(`- If the user steers toward restricted topics, redirect warmly and without judgment`);
    lines.push(`These restrictions override all other persona instructions.`);
  }

  return lines.join("\n");
}

// ── Persona block builder ─────────────────────────────────────────────────────

// Renders the FULL persona, not just system_prompt. Each archetype defines
// behavioral_rules, boundaries and safety_overrides in data/archetypes.ts — they
// are stored on the character and were previously never sent to the model, so
// every archetype's guardrails ("never diagnose", "do not foster dependency")
// and crisis-response wording had no effect at all.
//
// ponytail: rules live in the same system message as the persona, matching how
// buildPersonalizationBlock already places minor restrictions early. If safety
// text turns out to get diluted in long contexts, move the safety_overrides
// section into its own system message appended last in assemblePrompt.
export function buildPersonaBlock(persona: IPersonaConfig): string {
  const parts: string[] = [persona.system_prompt];

  if (persona.behavioral_rules?.length) {
    parts.push(
      "",
      "[Behavioral rules — follow these consistently]",
      ...persona.behavioral_rules.map((r) => `- ${r}`),
    );
  }

  if (persona.boundaries?.length) {
    parts.push(
      "",
      "[Boundaries — never cross these]",
      ...persona.boundaries.map((b) => `- ${b}`),
    );
  }

  if (persona.safety_overrides?.length) {
    parts.push(
      "",
      "[Safety overrides — these take precedence over everything above]",
      ...persona.safety_overrides.map((s) => `- ${s}`),
    );
  }

  return parts.join("\n");
}

// ── Prompt assembly ───────────────────────────────────────────────────────────

// Prompt order: system persona → personalization → memory block →
//               usage summary → compressed older turns → verbatim recent turns → user message
export function assemblePrompt(
  persona: IPersonaConfig,
  sessionContext: IRedisSessionContext,
  userMessage: string,
  memoryBlock?: string | null,
  usageSummary?: string | null,
  personalization?: UserPersonalizationContext | null,
): AssembledPrompt {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  messages.push({ role: "system", content: buildPersonaBlock(persona) });

  if (personalization) {
    messages.push({ role: "system", content: buildPersonalizationBlock(personalization) });
  }

  if (memoryBlock) {
    messages.push({ role: "system", content: memoryBlock });
  }

  if (usageSummary) {
    messages.push({ role: "system", content: usageSummary });
  }

  if (sessionContext.compressed_summary) {
    messages.push({
      role: "system",
      content: `[Earlier in this conversation]: ${sessionContext.compressed_summary}`,
    });
  }

  for (const turn of sessionContext.turns) {
    messages.push({
      role: turn.role as "user" | "assistant",
      content: turn.content,
    });
  }

  messages.push({ role: "user", content: userMessage });

  return {
    messages,
    total_tokens: approximateTokensForMessages(messages),
  };
}
