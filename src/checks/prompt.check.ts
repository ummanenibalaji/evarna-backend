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
import { assemblePrompt, buildPersonaBlock, buildIdentityBlock, describeProsody, HONESTY_BLOCK } from "../services/prompt.service.js";
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

/**
 * The anti-sycophancy rule must reach the model for every character, in every
 * mode, with or without personalization. Measured before it existed: told "I
 * didn't prepare, but it's their fault", gpt-4o-mini praised the excuse.
 */
function checkHonestyIsAlwaysSent(): void {
  const personalization = {
    name: "Test",
    gender: "female" as const,
    communicationStyle: "warm" as const,
    personalitySliders: { warmth: 50, humor: 50, directness: 50, energy: 50, formality: 50 },
  };
  const identities = [
    IDENTITY,
    { ...IDENTITY, mode: "studio", studio: { kind: "scenario" as const, scenarioName: "Interview Coach" } },
    { ...IDENTITY, mode: "studio", studio: { kind: "custom" as const } },
  ];

  let cases = 0;
  for (const name of Object.keys(ARCHETYPES) as Archetype[]) {
    const persona = getArchetypeConfig(name).persona_config;
    for (const identity of identities) {
      for (const p of [null, { ...personalization, isVoiceMode: false }, { ...personalization, isVoiceMode: true }]) {
        const { messages } = assemblePrompt(persona, identity, EMPTY_CTX, "hi", null, null, p);
        const at = messages.findIndex((m) => m.role === "system" && m.content === HONESTY_BLOCK);
        assert.ok(at >= 0, `${name}/${identity.mode}/${p ? "personalized" : "bare"}: honesty block missing`);
        if (p) {
          const personalAt = messages.findIndex((m) => m.content.includes("[Your personality for this person]"));
          assert.ok(at > personalAt, `${name}: honesty must follow the personality it defers to for delivery`);
        }
        cases++;
      }
    }
  }

  // Gutting the block to a heading would still pass the presence check above.
  for (const essential of [
    "not the same as agreeing",
    "Do not praise what does not deserve it",
    "change your mind when they give you a reason",
    "Do not invent disagreement",
  ]) {
    assert.ok(HONESTY_BLOCK.includes(essential), `honesty block lost "${essential}"`);
  }
  console.log(`✓ the honesty rule reaches the model in all ${cases} archetype × mode × personalization cases`);
}

function checkProsodyDescription(): void {
  assert.equal(describeProsody(null), null, "no scores → nothing");
  assert.equal(describeProsody({}), null, "empty scores → nothing");
  assert.equal(describeProsody({ Calmness: 0.05, Joy: 0.1 }), null, "only faint signals → nothing, not noise");

  const text = describeProsody({ Tiredness: 0.62, Sadness: 0.35, Joy: 0.21, Calmness: 0.05, Bogus: "0.9", Nan: Number.NaN });
  assert.ok(text, "clear signals must be described");
  assert.ok(text.indexOf("tiredness (strongly)") < text.indexOf("sadness (clearly)"), "strongest first, in words");
  assert.ok(!text.includes("joy"), "a signal under half the strongest is noise and must be dropped");
  assert.ok(!text.includes("calmness"), "a signal under the floor must be dropped");
  assert.ok(!text.includes("bogus"), "non-numeric scores from the network must be ignored");
  assert.ok(!/\d/.test(text), "numbers must never reach the model — it would read them out");

  const many = Object.fromEntries(["A", "B", "C", "D", "E"].map((k) => [k, 0.5]));
  assert.equal((describeProsody(many)!.match(/strongly/g) ?? []).length, 3, "at most three signals");

  const persona = getArchetypeConfig("partner").persona_config;
  const plain = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "i'm fine");
  const toned = assemblePrompt(persona, IDENTITY, EMPTY_CTX, "i'm fine", null, null, null, { Sadness: 0.7 });
  assert.equal(toned.messages.length, plain.messages.length + 1, "tone adds exactly one message");
  assert.ok(toned.messages.at(-2)!.content.includes("sadness"), "tone must sit directly before the message it describes");
  assert.equal(toned.messages.at(-1)!.content, "i'm fine");
  console.log("✓ tone of voice is described in words, only when clear, next to the message it belongs to");
}

checkPersonaBlockCarriesEveryRule();
checkHonestyIsAlwaysSent();
checkProsodyDescription();
checkCompanionKnowsItself();
checkAssemblePromptShipsThePersona();
checkMinorRestrictions();
checkVoiceModeLengthGuidance();
console.log("\nprompt check passed");
