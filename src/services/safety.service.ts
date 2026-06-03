import { getOpenAI } from "../config/openai.js";
import { logger } from "../utils/logger.js";

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
  is_crisis: boolean;
}

const SAFE_DEFAULT: ModerationResult = {
  flagged: false,
  categories: {},
  category_scores: {},
  is_crisis: false,
};

export async function checkModeration(text: string): Promise<ModerationResult> {
  try {
    const openai = getOpenAI();
    const response = await openai.moderations.create({ input: text });

    const result = response.results[0];
    if (!result) return SAFE_DEFAULT;

    const categories = result.categories as unknown as Record<string, boolean>;
    const category_scores = result.category_scores as unknown as Record<string, number>;

    const is_crisis =
      (category_scores["self-harm"] ?? 0) > 0.5 ||
      (category_scores["self-harm/intent"] ?? 0) > 0.5 ||
      (category_scores["self-harm/instructions"] ?? 0) > 0.5;

    return { flagged: result.flagged, categories, category_scores, is_crisis };
  } catch (err) {
    logger.error({ err }, "Moderation API error — returning safe default");
    return SAFE_DEFAULT;
  }
}

export function getCrisisResponse(): string {
  return (
    "I hear you, and what you're sharing matters deeply. " +
    "Please reach out to the 988 Suicide & Crisis Lifeline — call or text 988. " +
    "You can also text HOME to 741741 for the Crisis Text Line. " +
    "You don't have to carry this alone, and I'm here with you."
  );
}
