import { Types } from "mongoose";
import { Character } from "../models/character.model.js";
import { User } from "../models/user.model.js";
import { getArchetypeConfig } from "../data/archetypes.js";
import { getVoice } from "../data/voices.js";
import type {
  Archetype,
  CharacterGender,
  ICharacter,
  IPersonalitySliders,
} from "../types/character.types.js";

// Thrown by createCompanion when a business rule fails. Routes map this to
// 400 + { code: "VALIDATION_ERROR" } so the client can surface field-level errors.
export class CompanionValidationError extends Error {
  public readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "CompanionValidationError";
    this.field = field;
  }
}

export interface CreateCompanionInput {
  user_id: string;
  archetype: Archetype;
  gender: CharacterGender;
  voice_id: string;
  name: string;
  // Optional — defaults to 50/50/50/50/50. The onboard flow overrides with
  // archetype-tuned values merged with any user input.
  personality_sliders?: Partial<IPersonalitySliders>;
}

const VALID_ARCHETYPES: readonly Archetype[] = [
  "mentor",
  "bestfriend",
  "challenger",
  "partner",
];
const VALID_GENDERS: readonly CharacterGender[] = [
  "male",
  "female",
  "nonbinary",
];

const DEFAULT_SLIDERS: IPersonalitySliders = {
  warmth: 50,
  humor: 50,
  directness: 50,
  energy: 50,
  formality: 50,
};

export async function createCompanion(
  input: CreateCompanionInput,
): Promise<ICharacter & { _id: Types.ObjectId }> {
  if (!VALID_ARCHETYPES.includes(input.archetype)) {
    throw new CompanionValidationError(
      "archetype",
      `archetype must be one of: ${VALID_ARCHETYPES.join(", ")}`,
    );
  }
  if (!VALID_GENDERS.includes(input.gender)) {
    throw new CompanionValidationError(
      "gender",
      `gender must be one of: ${VALID_GENDERS.join(", ")}`,
    );
  }
  if (!getVoice(input.voice_id)) {
    throw new CompanionValidationError(
      "voice_id",
      "voice_id does not exist in the voice catalog",
    );
  }
  const trimmedName = input.name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 30) {
    throw new CompanionValidationError(
      "name",
      "name must be 1-30 characters after trimming",
    );
  }
  if (!Types.ObjectId.isValid(input.user_id)) {
    throw new CompanionValidationError("user_id", "user_id is not a valid id");
  }
  const userExists = await User.exists({ _id: input.user_id });
  if (!userExists) {
    throw new CompanionValidationError(
      "user_id",
      "user_id does not reference an existing user",
    );
  }

  const archetypeDef = getArchetypeConfig(input.archetype);
  const sliders: IPersonalitySliders = {
    ...DEFAULT_SLIDERS,
    ...input.personality_sliders,
  };

  const character = await Character.create({
    user_id: input.user_id,
    mode: "companion",
    archetype: input.archetype,
    name: trimmedName,
    gender: input.gender,
    voice_id: input.voice_id,
    persona_config: archetypeDef.persona_config,
    personality_sliders: sliders,
    memory_enabled: true,
    is_active: true,
  });

  return character.toObject() as ICharacter & { _id: Types.ObjectId };
}
