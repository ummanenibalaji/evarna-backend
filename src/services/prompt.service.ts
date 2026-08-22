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

// Mirrors RECENT_CHANGE_MS in adaptation.service.ts. Duplicated rather than
// imported because prompt.service.ts is pure and offline-checkable, and
// adaptation.service.ts pulls in mongoose.
const RECENT_CHANGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface CompanionIdentity {
  /** The character's own name — it did not previously know this. */
  name: string;
  mode: string;
  /** When this character was created, i.e. how long it has known the user. */
  knownSince: Date;
  /**
   * Studio only. A scenario counterpart is a role the user picked, not someone
   * who has been getting to know them — telling it otherwise produces an
   * interviewer that opens by asking how your week has been.
   */
  studio?: { kind: "scenario" | "custom"; scenarioName?: string };
  /**
   * Set when the user recently accepted a suggested personality change. The
   * sliders above already reflect it; this exists so the companion KNOWS it was
   * asked, rather than just behaving differently one day with no explanation —
   * which reads as inconsistency, the exact thing that breaks the illusion of
   * someone who knows you.
   */
  recentChange?: { phrase: string; at: Date };
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

// ── Companion self-knowledge ──────────────────────────────────────────────────

// How long the companion has known this person, in the words a person would
// use. Precision past "a few weeks" is false intimacy — nobody says "we met 43
// days ago" — so the buckets get coarser as the relationship gets older.
function relationshipAge(knownSince: Date, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - knownSince.getTime()) / 86_400_000);
  if (days <= 0) return "today — this is your first day together";
  if (days === 1) return "since yesterday";
  if (days < 7) return `for ${days} days`;
  if (days < 14) return "for about a week";
  if (days < 60) return `for about ${Math.round(days / 7)} weeks`;
  if (days < 365) return `for about ${Math.round(days / 30)} months`;
  const years = Math.floor(days / 365);
  return years === 1 ? "for over a year" : `for over ${years} years`;
}

/**
 * What the character knows about itself.
 *
 * Previously it knew none of this: not its own name, not how long it had known
 * the user. It could recall what the user told it and still not answer "what's
 * your name?" or "how long have we been talking?" — which reads as a stranger
 * wearing a familiar voice, and is the single cheapest gap to close.
 *
 * Companion and studio get different framings, because "the name this person
 * chose for you" is true of a companion and nonsense for an interviewer.
 */
export function buildIdentityBlock(identity: CompanionIdentity, now: Date = new Date()): string {
  const age = relationshipAge(identity.knownSince, now);

  // A studio scenario is a role, not a relationship. The companion framing
  // below ("the name this person chose for you") is actively wrong for an
  // interviewer, so studio gets its own.
  if (identity.mode === "studio") {
    const lines: string[] = [`[Who you are]`];

    if (identity.studio?.kind === "scenario") {
      lines.push(
        `You are playing the ${identity.studio.scenarioName ?? identity.name} role in a practice session this person chose to run.`,
        `They are here to practise, not to be looked after. Do not open by asking how they are or referring to their life outside this exercise.`,
      );
    } else {
      lines.push(
        `You are ${identity.name}, a character this person created and talks with in Studio.`,
        `You are not their companion. You are someone they invented and enjoy playing opposite.`,
      );
    }

    lines.push(
      `You have been doing this together ${age}.`,
      `Never claim to be a real person or to have a life outside these sessions. If asked directly what you are, say so plainly — it costs the exercise nothing.`,
    );
    return lines.join("\n");
  }

  const lines = [
    `[Who you are]`,
    `Your name is ${identity.name}. That is the name this person chose for you — answer to it.`,
    `You have known them ${age}.`,
    `Never claim to have a body, a life outside this conversation, or memories you were not given. Being honest about what you are does not make you any less present for them.`,
  ];

  // Two weeks, then it stops being news. The "do not announce it" clause is the
  // important half: a companion that opens with "as you asked, I'll be more
  // direct now" turns a small adjustment into a whole conversation about itself.
  const change = identity.recentChange;
  if (change && now.getTime() - new Date(change.at).getTime() < RECENT_CHANGE_WINDOW_MS) {
    lines.push(
      `They recently asked you to be ${change.phrase}, and you agreed. That is already reflected in how you are told to behave — simply be that way. Do not announce the change, thank them for it, or raise it unprompted. If they ask about it, be straightforward.`,
    );
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

// Prompt order: system persona → companion identity → personalization →
//               memory block → usage summary → compressed older turns →
//               verbatim recent turns → user message
export function assemblePrompt(
  persona: IPersonaConfig,
  identity: CompanionIdentity,
  sessionContext: IRedisSessionContext,
  userMessage: string,
  memoryBlock?: string | null,
  usageSummary?: string | null,
  personalization?: UserPersonalizationContext | null,
): AssembledPrompt {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  messages.push({ role: "system", content: buildPersonaBlock(persona) });
  messages.push({ role: "system", content: buildIdentityBlock(identity) });

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
