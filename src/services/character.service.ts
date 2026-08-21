import { Types } from "mongoose";
import { Character } from "../models/character.model.js";
import { User } from "../models/user.model.js";
import { getArchetypeConfig } from "../data/archetypes.js";
import { getVoice } from "../data/voices.js";
import { getScenario, buildCustomStudioPersona } from "../data/scenarios.js";
import { isMinorNow } from "../utils/age.js";
import type {
  Archetype,
  CharacterGender,
  ICharacter,
  IPersonalitySliders,
  IStudioConfig,
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
  const user = await User.findById(input.user_id).select("date_of_birth").lean();
  if (!user) {
    throw new CompanionValidationError(
      "user_id",
      "user_id does not reference an existing user",
    );
  }

  // Partner archetype is age-restricted (relationship dynamics).
  // Derived from date of birth, not the stored is_minor snapshot — that flag is
  // written once at onboarding, so someone who has since turned 18 would still
  // be blocked and someone who was 17 at signup would stay blocked forever.
  if (isMinorNow(user.date_of_birth) && input.archetype === "partner") {
    throw new CompanionValidationError(
      "archetype",
      "Partner companion is not available for users under 18",
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


// ── Studio characters ────────────────────────────────────────────────────────

export interface CreateStudioCharacterInput {
  user_id: string;
  kind: "scenario" | "custom";
  voice_id: string;
  gender: CharacterGender;
  /** Scenario only — which scenario, and its setup answers. */
  scenario_id?: string;
  params?: Record<string, string>;
  /** Custom only. */
  name?: string;
  backstory?: string;
  personality_sliders?: Partial<IPersonalitySliders>;
}

/**
 * Create a studio character.
 *
 * A studio character is an ordinary Character row with mode "studio", which is
 * what makes sessions, turns, memory extraction and retrieval work for Studio
 * without a second pipeline. The differences are that it has no archetype, and
 * its persona is generated here rather than read from data/archetypes.ts.
 *
 * Nothing the client sends becomes prompt text. A scenario supplies an id and
 * parameter values which the scenario definition renders; a custom character
 * supplies a backstory which buildCustomStudioPersona fences. In both cases the
 * safety overrides are ours and are rendered last.
 */
export async function createStudioCharacter(
  input: CreateStudioCharacterInput,
): Promise<ICharacter & { _id: Types.ObjectId }> {
  if (!Types.ObjectId.isValid(input.user_id)) {
    throw new CompanionValidationError("user_id", "user_id is not a valid id");
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

  let name: string;
  let persona;
  let sliders: IPersonalitySliders;
  let studio_config: IStudioConfig;

  if (input.kind === "scenario") {
    const scenario = getScenario(input.scenario_id ?? "");
    if (!scenario) {
      throw new CompanionValidationError("scenario_id", "Unknown scenario");
    }

    // Validated against the scenario's own definition, because it is the only
    // thing that knows which keys it expects. An unrecognised key is dropped
    // rather than rejected — it cannot reach the prompt, since buildPersona
    // reads named keys, so refusing the whole request would be noise.
    const supplied = input.params ?? {};
    const params: Record<string, string> = {};
    for (const def of scenario.params) {
      const raw = supplied[def.key];
      const value = typeof raw === "string" ? raw.trim() : "";

      if (!value) {
        if (def.required) {
          throw new CompanionValidationError(def.key, `${def.label} is required`);
        }
        continue;
      }
      if (def.type === "choice" && !def.options?.includes(value)) {
        throw new CompanionValidationError(
          def.key,
          `${def.label} must be one of: ${def.options?.join(", ")}`,
        );
      }
      // Free-text answers land inside a generated sentence, so they are capped.
      // 120 characters is more than "Senior Backend Engineer" ever needs and
      // far too short to smuggle in a paragraph of instructions.
      params[def.key] = def.type === "text" ? value.slice(0, 120) : value;
    }

    name = scenario.name;
    persona = scenario.buildPersona(params);
    sliders = { ...scenario.default_sliders, ...input.personality_sliders };
    studio_config = { kind: "scenario", scenario_id: scenario.id, params };
  } else {
    const trimmedName = (input.name ?? "").trim();
    if (trimmedName.length === 0 || trimmedName.length > 30) {
      throw new CompanionValidationError(
        "name",
        "name must be 1-30 characters after trimming",
      );
    }
    const backstory = (input.backstory ?? "").trim().slice(0, 500);

    name = trimmedName;
    persona = buildCustomStudioPersona(trimmedName, backstory);
    sliders = { ...DEFAULT_SLIDERS, ...input.personality_sliders };
    studio_config = { kind: "custom", backstory };
  }

  const character = await Character.create({
    user_id: input.user_id,
    mode: "studio",
    name,
    gender: input.gender,
    voice_id: input.voice_id,
    persona_config: persona,
    personality_sliders: sliders,
    studio_config,
    memory_enabled: true,
    is_active: true,
  });

  return character.toObject() as ICharacter & { _id: Types.ObjectId };
}
