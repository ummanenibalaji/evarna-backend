/**
 * Phase C — the companion adapts to what the user has already told it.
 *
 * Memory extraction has always produced `type: "preference"` memories — "user
 * prefers direct feedback over softening" — and nothing ever read them. The
 * personality sliders, meanwhile, are set once during onboarding and never
 * revisited. This connects the two: a preference the user stated in
 * conversation becomes a one-tap offer to retune the companion.
 *
 * The offer is deliberately an offer. Silently drifting a companion's
 * personality because the model classified a sentence as a preference is how
 * you get an app that feels like it is editing itself behind your back.
 */
import { Types } from "mongoose";
import { Character } from "../models/character.model.js";
import { Memory } from "../models/memory.model.js";
import { invalidateCharacterConfig } from "./session-context.service.js";
import type { IPersonalitySliders } from "../types/character.types.js";

export type TraitKey = keyof IPersonalitySliders;
export type Direction = "up" | "down";

export const TRAIT_KEYS: readonly TraitKey[] = [
  "warmth",
  "humor",
  "directness",
  "energy",
  "formality",
];

/**
 * How the change reads in a sentence, in both directions. Used for the button
 * the user taps AND for the line the companion is told about afterwards, so the
 * two can never describe different things.
 */
const PHRASING: Record<TraitKey, Record<Direction, string>> = {
  warmth:     { up: "warmer",          down: "more reserved" },
  humor:      { up: "funnier",         down: "more serious" },
  directness: { up: "more direct",     down: "gentler" },
  energy:     { up: "more energetic",  down: "calmer" },
  formality:  { up: "more formal",     down: "more casual" },
};

export function phraseFor(trait: TraitKey, direction: Direction): string {
  return PHRASING[trait][direction];
}

// One nudge is 20 points — a quarter of the usable range, which is roughly one
// step in buildPersonalizationBlock's bands. Smaller and the user taps a button
// and hears no difference, which is worse than not offering.
export const STEP = 20;

// Nothing to offer past this. If directness is already 85 there is no useful
// "more direct" left, and offering it produces a button that does nothing.
const CEILING = 80;
const FLOOR = 20;

// C3: at most one suggestion a week. A companion that keeps asking to be
// reconfigured is exhausting, and it reframes the relationship as maintenance.
export const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// How long a change stays worth mentioning to the companion (C2).
export const RECENT_CHANGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface HintedMemory {
  _id: string;
  content: string;
  created_at: Date;
  slider_hint?: { trait: TraitKey; direction: Direction } | null;
}

export interface AdaptationState {
  suggestion?: {
    memory_id: string;
    trait: TraitKey;
    direction: Direction;
    offered_at: Date;
  } | null;
  last_offered_at?: Date | null;
  handled_memory_ids?: string[];
}

export interface Suggestion {
  memory_id: string;
  trait: TraitKey;
  direction: Direction;
  /** The user's own words, as extracted. Shown so the offer is auditable. */
  quote: string;
  from: number;
  to: number;
  /** "more direct" — the client renders "Be more direct". */
  phrase: string;
}

function targetFor(current: number, direction: Direction): number | null {
  if (direction === "up") {
    if (current >= CEILING) return null;
    return Math.min(100, current + STEP);
  }
  if (current <= FLOOR) return null;
  return Math.max(0, current - STEP);
}

function build(
  m: HintedMemory,
  trait: TraitKey,
  direction: Direction,
  sliders: IPersonalitySliders,
): Suggestion | null {
  const from = sliders[trait];
  const to = targetFor(from, direction);
  if (to === null) return null;
  return {
    memory_id: m._id,
    trait,
    direction,
    quote: m.content,
    from,
    to,
    phrase: phraseFor(trait, direction),
  };
}

/**
 * Pure. Decides what — if anything — to offer, given what the companion knows,
 * how it is currently tuned, and what has already been offered.
 *
 * Returns `{ suggestion, isNew }`. `isNew` tells the caller whether the
 * cooldown clock needs starting; a re-render of an outstanding offer must not
 * restart it, or an unanswered suggestion would suppress every future one.
 */
export function pickSuggestion(
  memories: HintedMemory[],
  sliders: IPersonalitySliders,
  state: AdaptationState,
  now: Date = new Date(),
): { suggestion: Suggestion | null; isNew: boolean } {
  const handled = new Set(state.handled_memory_ids ?? []);

  // An outstanding offer stands until the user answers it. It is re-derived
  // from the CURRENT sliders rather than replayed, so if they moved the slider
  // by hand in the meantime the offer either updates or disappears.
  const open = state.suggestion;
  if (open && !handled.has(open.memory_id)) {
    const m = memories.find((x) => x._id === open.memory_id);
    if (m) {
      const s = build(m, open.trait, open.direction, sliders);
      if (s) return { suggestion: s, isNew: false };
    }
    // The memory was deleted, or the user already tuned past it. Either way
    // there is nothing to show and nothing to re-offer.
    return { suggestion: null, isNew: false };
  }

  if (
    state.last_offered_at &&
    now.getTime() - new Date(state.last_offered_at).getTime() < COOLDOWN_MS
  ) {
    return { suggestion: null, isNew: false };
  }

  // Newest first: the most recent thing they said about how they want to be
  // talked to beats something from two months ago.
  const candidates = [...memories].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  for (const m of candidates) {
    const hint = m.slider_hint;
    if (!hint) continue;
    if (handled.has(m._id)) continue;
    if (!TRAIT_KEYS.includes(hint.trait)) continue;
    if (hint.direction !== "up" && hint.direction !== "down") continue;
    const s = build(m, hint.trait, hint.direction, sliders);
    if (s) return { suggestion: s, isNew: true };
  }

  return { suggestion: null, isNew: false };
}

// ── Database-facing wrappers ─────────────────────────────────────────────────

type OwnedCharacter = {
  _id: Types.ObjectId;
  mode: string;
  personality_sliders: IPersonalitySliders;
  adaptation?: AdaptationState;
};

async function loadCompanion(
  userId: string,
  characterId: string,
): Promise<OwnedCharacter | null> {
  if (!Types.ObjectId.isValid(characterId)) return null;
  const c = await Character.findOne({ _id: characterId, user_id: userId })
    .select("mode personality_sliders adaptation")
    .lean();
  // Studio characters are roles the user cast, not a relationship being tuned.
  // Offering to make an interviewer warmer misreads the whole feature.
  if (!c || c.mode === "studio") return null;
  return c as OwnedCharacter;
}

/**
 * The offer for this companion, or null. Persists the cooldown stamp when a new
 * offer is made — reading is what commits it, because an offer the user never
 * saw should not burn the week.
 */
export async function getSuggestion(
  userId: string,
  characterId: string,
  now: Date = new Date(),
): Promise<Suggestion | null> {
  const character = await loadCompanion(userId, characterId);
  if (!character) return null;

  const memories = await Memory.find({
    user_id: userId,
    character_id: character._id,
    is_deleted: false,
    slider_hint: { $ne: null },
  })
    .select("content created_at slider_hint")
    .sort({ created_at: -1 })
    .limit(50)
    .lean();

  const { suggestion, isNew } = pickSuggestion(
    memories.map((m) => ({
      _id: m._id.toString(),
      content: m.content,
      created_at: m.created_at,
      slider_hint: m.slider_hint ?? null,
    })),
    character.personality_sliders,
    character.adaptation ?? {},
    now,
  );

  if (suggestion && isNew) {
    await Character.updateOne(
      { _id: character._id },
      {
        $set: {
          "adaptation.suggestion": {
            memory_id: suggestion.memory_id,
            trait: suggestion.trait,
            direction: suggestion.direction,
            offered_at: now,
          },
          "adaptation.last_offered_at": now,
        },
      },
    );
  }

  return suggestion;
}

export type Resolution = "apply" | "dismiss";

/**
 * Answers the outstanding offer. Applying moves the slider and records the
 * change so the companion can acknowledge it (C2); dismissing just retires the
 * memory so it is never offered again.
 *
 * Returns null when there was nothing outstanding to answer — a double-tap, or
 * a stale screen — which the route reports as a 409 rather than pretending to
 * have done something.
 */
export async function resolveSuggestion(
  userId: string,
  characterId: string,
  memoryId: string,
  resolution: Resolution,
  now: Date = new Date(),
): Promise<{ sliders: IPersonalitySliders } | null> {
  const character = await loadCompanion(userId, characterId);
  if (!character) return null;

  const open = character.adaptation?.suggestion;
  // Matched on memory id so a tap on a screen showing yesterday's suggestion
  // cannot apply today's.
  if (!open || open.memory_id !== memoryId) return null;

  const update: Record<string, unknown> = {
    "adaptation.suggestion": null,
  };
  const sliders = { ...character.personality_sliders };

  if (resolution === "apply") {
    const to = targetFor(sliders[open.trait], open.direction);
    if (to === null) return null;
    sliders[open.trait] = to;
    update[`personality_sliders.${open.trait}`] = to;
    update["adaptation.recent_change"] = {
      trait: open.trait,
      direction: open.direction,
      at: now,
    };
  }

  await Character.updateOne(
    { _id: character._id, user_id: userId },
    {
      $set: update,
      $addToSet: { "adaptation.handled_memory_ids": memoryId },
    },
  );

  // Sliders and the recent-change line both live in the cached character
  // config, so without this the tap has no effect until the TTL expires.
  await invalidateCharacterConfig(characterId);

  return { sliders };
}
