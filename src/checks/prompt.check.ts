/**
 * Offline self-check for prompt assembly. No DB, no network, no API keys.
 *
 *   npm run check:prompt
 *
 * Guards the Phase 3b fix: every archetype's behavioral_rules, boundaries and
 * safety_overrides must actually reach the model. They were defined in
 * archetypes.ts and stored on the character, but assemblePrompt only ever sent
 * system_prompt — so all of it was dead data. If that regresses, this fails.
 */
import assert from "node:assert/strict";
import { ARCHETYPES, getArchetypeConfig } from "../data/archetypes.js";
import { assemblePrompt, buildPersonaBlock, buildIdentityBlock } from "../services/prompt.service.js";
import type { Archetype } from "../types/character.types.js";
import type { IRedisSessionContext } from "../types/prompt.types.js";

const EMPTY_CTX: IRedisSessionContext = {
  compressed_summary: "",
  turns: [],
  total_token_count: 0,
};

function checkPersonaBlockCarriesEveryRule(): void {
  for (const name of Object.keys(ARCHETYPES) as Archetype[]) {
    const persona = getArchetypeConfig(name).persona_config;
    const block = buildPersonaBlock(persona);

    assert.ok(
      block.includes(persona.system_prompt),
      `${name}: system_prompt missing from persona block`,
    );

    // The actual Phase 3b bug: these three arrays never reached the model.
    assert.ok(persona.behavioral_rules.length > 0, `${name}: has no behavioral_rules to test`);
    assert.ok(persona.boundaries.length > 0, `${name}: has no boundaries to test`);
    assert.ok(persona.safety_overrides.length > 0, `${name}: has no safety_overrides to test`);

    for (const rule of persona.behavioral_rules) {
      assert.ok(block.includes(rule), `${name}: behavioral rule dropped → "${rule.slice(0, 50)}"`);
    }
    for (const boundary of persona.boundaries) {
      assert.ok(block.includes(boundary), `${name}: boundary dropped → "${boundary.slice(0, 50)}"`);
    }
    for (const override of persona.safety_overrides) {
      assert.ok(block.includes(override), `${name}: safety override dropped → "${override.slice(0, 50)}"`);
    }

    // Safety must come after the persona so it reads as overriding it.
    assert.ok(
      block.indexOf("[Safety overrides") > block.indexOf("[Boundaries"),
      `${name}: safety overrides must be last in the persona block`,
    );
  }
  console.log(`✓ all ${Object.keys(ARCHETYPES).length} archetypes carry every rule into the persona block`);
}

// Fixed so relationshipAge() renders deterministically rather than drifting
// with the wall clock.
const IDENTITY = {
  name: "Sage",
  mode: "companion",
  knownSince: new Date("2026-08-01T00:00:00Z"),
};

function checkAssemblePromptShipsThePersona(): void {
  const persona = getArchetypeConfig("mentor").persona_config;
  const { messages } = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "hey");

  assert.equal(messages[0]?.role, "system", "first message must be the system persona");
  assert.ok(
    messages[0]!.content.includes("Never diagnose"),
    "mentor boundary 'Never diagnose' must reach the model",
  );
  assert.ok(
    messages[0]!.content.includes("988"),
    "crisis-line wording from safety_overrides must reach the model",
  );
  assert.equal(messages.at(-1)?.role, "user", "last message must be the user turn");
  assert.equal(messages.at(-1)?.content, "hey");
  console.log("✓ assemblePrompt ships the full persona as the system message");
}

function checkMinorRestrictions(): void {
  const persona = getArchetypeConfig("bestfriend").persona_config;
  const base = {
    name: "Test",
    gender: "female" as const,
    communicationStyle: "warm" as const,
    personalitySliders: { warmth: 50, humor: 50, directness: 50, energy: 50, formality: 50 },
  };

  const adult = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "hi", null, null, { ...base, isMinor: false });
  const minor = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "hi", null, null, { ...base, isMinor: true });

  const adultText = adult.messages.map((m) => m.content).join("\n");
  const minorText = minor.messages.map((m) => m.content).join("\n");

  assert.ok(
    minorText.includes("under 18") && minorText.includes("No romantic"),
    "minor users must get the content restriction block",
  );
  assert.ok(
    !adultText.includes("[Content restrictions"),
    "adult users must NOT get the minor restriction block",
  );
  console.log("✓ minor content restrictions apply only to minors");
}

function checkVoiceModeLengthGuidance(): void {
  const persona = getArchetypeConfig("partner").persona_config;
  const base = {
    name: "Test",
    gender: "male" as const,
    communicationStyle: "calm" as const,
    personalitySliders: { warmth: 50, humor: 50, directness: 50, energy: 50, formality: 50 },
  };

  const voice = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "hi", null, null, { ...base, isVoiceMode: true });
  const text = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "hi", null, null, { ...base, isVoiceMode: false });

  assert.ok(
    voice.messages.some((m) => m.content.includes("live VOICE call")),
    "voice mode must instruct the model to keep replies speakable",
  );
  assert.ok(
    !text.messages.some((m) => m.content.includes("live VOICE call")),
    "text mode must not claim to be a voice call",
  );
  console.log("✓ isVoiceMode switches response-length guidance");
}

function checkCompanionKnowsItself(): void {
  const persona = getArchetypeConfig("mentor").persona_config;
  const { messages } = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "what is your name?");
  const all = messages.map((m) => m.content).join("\n");

  assert.ok(all.includes("Your name is Sage"), "the companion must be told its own name");
  assert.ok(all.includes("[Who you are]"), "the identity block must reach the model");
  assert.ok(
    /You have known them/.test(all),
    "the companion must be told how long it has known this person",
  );

  // Relationship age is rendered in human buckets, not exact days — "43 days
  // ago" is not how anyone describes knowing someone.
  const now = new Date("2026-08-21T00:00:00Z");
  const at = (iso: string): string => buildIdentityBlock({ ...IDENTITY, knownSince: new Date(iso) }, now);
  assert.ok(at("2026-08-21T00:00:00Z").includes("first day"), "same-day should read as a first meeting");
  assert.ok(at("2026-08-20T00:00:00Z").includes("since yesterday"), "one day should read as yesterday");
  assert.ok(at("2026-08-18T00:00:00Z").includes("3 days"), "a few days should be exact");
  assert.ok(at("2026-07-21T00:00:00Z").includes("weeks"), "a month back should read in weeks");
  assert.ok(at("2026-02-21T00:00:00Z").includes("months"), "half a year back should read in months");
  assert.ok(at("2024-02-21T00:00:00Z").includes("years"), "two years back should read in years");

  console.log("✓ the companion is told its own name and how long it has known the user");
}

checkPersonaBlockCarriesEveryRule();
checkCompanionKnowsItself();
checkAssemblePromptShipsThePersona();
checkMinorRestrictions();
checkVoiceModeLengthGuidance();
console.log("\nprompt check passed");
