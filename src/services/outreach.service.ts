import { Types } from "mongoose";
import { getOpenAI, MODELS } from "../config/openai.js";
import { FollowUp } from "../models/follow-up.model.js";
import { User } from "../models/user.model.js";
import { Character } from "../models/character.model.js";
import { Session } from "../models/session.model.js";
import { ConversationTurn } from "../models/conversation-turn.model.js";
import { sendPush, clearPushToken } from "./push.service.js";
import { initSessionContext, appendTurn } from "./session-context.service.js";
import { logger } from "../utils/logger.js";

/**
 * Proactive outreach — the companion messaging first.
 *
 * The hints already existed: both background jobs write "ask how the interview
 * went" with a trigger date into the FollowUp queue. This is the half that
 * decides whether acting on them is the best thing in the product or the reason
 * someone deletes it.
 *
 * Everything below is send policy. The generous reading of a companion app is
 * that being remembered feels good; the ungenerous one is that an app is
 * manufacturing intimacy to drive engagement. The difference is entirely in the
 * restraint — so the limits here are deliberately tight, and every one of them
 * fails closed.
 */

// ── Policy constants ─────────────────────────────────────────────────────────

/** One message a day, maximum, per user. Not per companion — per person. */
const MAX_OUTREACH_PER_DAY = 1;

/** Local-time window during which nothing is ever sent. */
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 8;

/** Someone who opened the app today does not need chasing. */
const RECENT_ACTIVITY_HOURS = 24;

/** "How did Tuesday go?" asked a fortnight later is worse than silence. */
const HINT_EXPIRY_DAYS = 7;

/** After a crisis: no scheduled hints, one gentle check-in, then nothing. */
const CRISIS_SILENCE_DAYS = 7;
const CRISIS_CHECKIN_DELAY_HOURS = 24;

/** Cap per sweep so a backlog cannot fan out into a notification storm. */
const MAX_SENDS_PER_SWEEP = 50;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── Quiet hours ──────────────────────────────────────────────────────────────

/**
 * The user's local hour, from their IANA timezone.
 *
 * Falls back to treating a missing or invalid timezone as quiet — i.e. never
 * send. Getting this wrong means waking someone at 3am, so the failure mode is
 * silence rather than a guess.
 */
export function localHour(timezone: string | null | undefined, now = new Date()): number | null {
  if (!timezone) return null;
  try {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(now);
    const parsed = Number.parseInt(hour, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function isQuietHours(timezone: string | null | undefined, now = new Date()): boolean {
  const hour = localHour(timezone, now);
  if (hour === null) return true; // unknown timezone → never send
  // The window wraps midnight, so this is an OR rather than a range check.
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

// ── Message generation ───────────────────────────────────────────────────────

const OUTREACH_SYSTEM = `You are writing a single short message that an AI companion is sending to someone unprompted, as a push notification.

Rules:
- One or two sentences. It is a notification, not a conversation.
- Sound like the companion described below, not like an app.
- Reference the specific thing naturally, the way a friend who remembered would.
- No greetings like "Hi there!", no emoji, no exclamation marks, no marketing tone.
- Never imply you have been waiting, watching, or missing them. You are checking in, not pining.
- Plain text only.

Return only the message text.`;

async function writeOutreachMessage(
  companionName: string,
  personaPrompt: string,
  hint: string,
): Promise<string | null> {
  try {
    const openai = getOpenAI();
    const res = await openai.chat.completions.create({
      model: MODELS.SUMMARIZATION,
      messages: [
        { role: "system", content: OUTREACH_SYSTEM },
        {
          role: "user",
          content:
            `You are ${companionName}. Your character:\n${personaPrompt.slice(0, 600)}\n\n` +
            `Write the message. The thing to raise: ${hint}`,
        },
      ],
      max_tokens: 100,
      temperature: 0.8,
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return null;
    // A model asked for one sentence occasionally writes five. Truncating is
    // better than a notification that gets cut off mid-word by the OS.
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  } catch (err) {
    logger.error({ err }, "outreach: message generation failed");
    return null;
  }
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Persist the message as a real assistant turn in a new session, then push.
 *
 * Persisting first, and only pushing if that succeeded, is deliberate: a
 * notification the user taps into an empty conversation is worse than no
 * notification. This way the message exists whether or not the push lands, and
 * they find it next time they open the app.
 */
async function deliver(
  userId: string,
  characterId: Types.ObjectId,
  characterName: string,
  pushToken: string,
  message: string,
  mode: string,
): Promise<boolean> {
  let sessionId: Types.ObjectId;
  try {
    const session = await Session.create({
      user_id: userId,
      character_id: characterId,
      session_type: "text",
      mode,
      status: "active",
      started_at: new Date(),
    });
    sessionId = session._id;

    await initSessionContext(sessionId.toString());
    await ConversationTurn.create({
      session_id: sessionId,
      character_id: characterId,
      user_id: userId,
      role: "assistant",
      content_text: message,
      content_audio_url: null,
      safety_flags: { categories: {}, flagged: false, is_crisis: false },
      tokens_used: { input: 0, output: 0 },
      model_used: MODELS.SUMMARIZATION,
      latency_ms: 0,
      created_at: new Date(),
    });
    await appendTurn(sessionId.toString(), "assistant", message);
  } catch (err) {
    logger.error({ err, userId }, "outreach: failed to persist the message — not sending");
    return false;
  }

  const result = await sendPush({
    to: pushToken,
    title: characterName,
    body: message,
    data: { character_id: characterId.toString(), session_id: sessionId.toString() },
  });

  if (result === "invalid_token") {
    // The device unregistered. Retrying forever would be pointless, so drop it;
    // the app re-registers on next launch.
    await clearPushToken(userId).catch((err) =>
      logger.error({ err, userId }, "outreach: failed to clear a dead push token"),
    );
    return false;
  }
  return result === "ok";
}

// ── Crisis handling ──────────────────────────────────────────────────────────

/**
 * The most important branch in this file.
 *
 * If someone's last conversation involved self-harm or suicide ideation, every
 * queued hint is now wrong. "How did the interview go?" two days later is not
 * merely tone-deaf; it tells them the thing they confided in was not noticed.
 *
 * So: suppress the queue, and send exactly one message that carries no agenda —
 * roughly a day later, once, then nothing for a week. It deliberately does not
 * reference what was said, does not ask them to explain, and does not repeat
 * crisis resources they were already given. It says someone is here.
 */
const CRISIS_CHECKIN_MARKER = "__crisis_checkin__";

/**
 * Everyone with a crisis inside the silence window.
 *
 * This exists because the check-in cannot be driven off the follow-up queue.
 * The first sweep after a crisis suppresses every pending hint, so by the time
 * the check-in is due that user has nothing pending and a queue-driven loop
 * never reaches them — the one message that matters most would never fire.
 * Found by the smoke check, which is the only reason it is not still true.
 */
async function usersInCrisisWindow(now: Date): Promise<string[]> {
  return ConversationTurn.distinct("user_id", {
    "safety_flags.is_crisis": true,
    created_at: { $gte: new Date(now.getTime() - CRISIS_SILENCE_DAYS * DAY_MS) },
  });
}

async function lastCrisisTurn(userId: string, now: Date) {
  return ConversationTurn.findOne({
    user_id: userId,
    "safety_flags.is_crisis": true,
    created_at: { $gte: new Date(now.getTime() - CRISIS_SILENCE_DAYS * DAY_MS) },
  })
    .sort({ created_at: -1 })
    .select("created_at character_id session_id")
    .lean();
}

async function handleCrisisUser(
  userId: string,
  crisis: { created_at: Date; character_id: Types.ObjectId; session_id: Types.ObjectId },
  now: Date,
): Promise<void> {
  // Everything queued predates the crisis and is no longer appropriate.
  const suppressed = await FollowUp.updateMany(
    { user_id: userId, status: "pending" },
    { $set: { status: "suppressed" } },
  );
  if (suppressed.modifiedCount > 0) {
    logger.info(
      { userId, count: suppressed.modifiedCount },
      "outreach: suppressed queued hints after a crisis session",
    );
  }

  const since = now.getTime() - crisis.created_at.getTime();
  if (since < CRISIS_CHECKIN_DELAY_HOURS * HOUR_MS) return; // too soon

  // Exactly one, ever, per crisis. The marker doubles as the record.
  const already = await FollowUp.findOne({
    user_id: userId,
    hint: CRISIS_CHECKIN_MARKER,
    created_at: { $gte: crisis.created_at },
  })
    .select("_id")
    .lean();
  if (already) return;

  const user = await User.findById(userId).select("push_token timezone").lean();
  if (!user?.push_token || isQuietHours(user.timezone, now)) return;

  const character = await Character.findById(crisis.character_id)
    .select("name mode")
    .lean();
  if (!character) return;

  // Fixed text, not generated. This is the one message in the product where a
  // model having an off day is unacceptable, and there is nothing here a model
  // would write better.
  const message =
    `Hey — I've been thinking about you. No agenda, nothing you need to say back. ` +
    `I'm here whenever you want to talk.`;

  // Record the attempt before sending, so a crash mid-send cannot cause a
  // second one. Erring toward not sending is correct here.
  await FollowUp.create({
    user_id: userId,
    character_id: crisis.character_id,
    session_id: crisis.session_id,
    hint: CRISIS_CHECKIN_MARKER,
    trigger_date: now,
    type: "check_in",
    status: "sent",
    sent_at: now,
  });

  const sent = await deliver(
    userId,
    crisis.character_id,
    character.name,
    user.push_token,
    message,
    character.mode ?? "companion",
  );
  logger.warn({ userId, sent }, "outreach: post-crisis check-in");
}

// ── The sweep ────────────────────────────────────────────────────────────────

export interface SweepResult {
  due: number;
  sent: number;
  skipped: number;
  expired: number;
}

export async function runOutreachSweep(now = new Date()): Promise<SweepResult> {
  const result: SweepResult = { due: 0, sent: 0, skipped: 0, expired: 0 };

  // Crisis users first, and independently of the queue — see usersInCrisisWindow.
  const crisisUsers = new Set<string>();
  for (const userId of await usersInCrisisWindow(now)) {
    crisisUsers.add(userId);
    try {
      const crisis = await lastCrisisTurn(userId, now);
      if (crisis) await handleCrisisUser(userId, crisis, now);
    } catch (err) {
      logger.error({ err, userId }, "outreach: crisis handling failed");
    }
  }

  const due = await FollowUp.find({ status: "pending", trigger_date: { $lte: now } })
    .sort({ trigger_date: 1 })
    .limit(MAX_SENDS_PER_SWEEP * 4)
    .lean();

  result.due = due.length;
  if (due.length === 0) return result;

  // One message per user per sweep, regardless of how many hints came due.
  const byUser = new Map<string, typeof due>();
  for (const f of due) {
    const list = byUser.get(f.user_id) ?? [];
    list.push(f);
    byUser.set(f.user_id, list);
  }

  for (const [userId, hints] of byUser) {
    if (result.sent >= MAX_SENDS_PER_SWEEP) break;

    try {
      // 1. Crisis users were handled above, including suppressing their queue.
      //    Anything of theirs still showing as due is a race; skip it.
      if (crisisUsers.has(userId)) {
        result.skipped += hints.length;
        continue;
      }

      // 2. Expire anything too stale to be worth saying.
      const cutoff = new Date(now.getTime() - HINT_EXPIRY_DAYS * DAY_MS);
      const fresh = [];
      for (const h of hints) {
        if (h.trigger_date < cutoff) {
          await FollowUp.updateOne({ _id: h._id }, { $set: { status: "expired" } });
          result.expired++;
        } else {
          fresh.push(h);
        }
      }
      if (fresh.length === 0) continue;

      // 3. Drop anything whose companion has been deleted or deactivated.
      //
      //    This is a VALIDITY check, so it runs before the deliverability
      //    checks below. Ordered the other way, a user with no device never
      //    reached it and dead hints sat in the queue until they expired —
      //    harmless, since nothing is sent either way, but the queue should
      //    clean itself regardless of whether anyone has a phone attached.
      const charIds = [...new Set(fresh.map((h) => h.character_id.toString()))];
      const activeIds = new Set(
        (
          await Character.find({ _id: { $in: charIds }, is_active: true })
            .select("_id")
            .lean()
        ).map((c) => c._id.toString()),
      );

      const live = [];
      for (const h of fresh) {
        if (activeIds.has(h.character_id.toString())) {
          live.push(h);
        } else {
          await FollowUp.updateOne({ _id: h._id }, { $set: { status: "suppressed" } });
          result.skipped++;
        }
      }
      if (live.length === 0) continue;

      const user = await User.findById(userId)
        .select("push_token timezone last_active_at")
        .lean();

      // 4. No device, no message. Leave the hint pending — they may grant
      //    permission later and it is still fresh until it expires.
      if (!user?.push_token) { result.skipped += live.length; continue; }

      // 5. Quiet hours. Also leaves it pending: a later sweep sends it.
      if (isQuietHours(user.timezone, now)) { result.skipped += live.length; continue; }

      // 6. Someone who has been in the app today does not need chasing.
      const lastActive = user.last_active_at?.getTime() ?? 0;
      if (now.getTime() - lastActive < RECENT_ACTIVITY_HOURS * HOUR_MS) {
        result.skipped += live.length;
        continue;
      }

      // 7. Daily cap, derived from what was actually sent rather than a
      //    counter that could drift out of sync with reality.
      const sentToday = await FollowUp.countDocuments({
        user_id: userId,
        status: "sent",
        sent_at: { $gte: new Date(now.getTime() - DAY_MS) },
      });
      if (sentToday >= MAX_OUTREACH_PER_DAY) { result.skipped += live.length; continue; }

      // Oldest trigger first — it has been waiting longest. Its companion was
      // confirmed active in step 3.
      const chosen = live[0]!;
      const character = await Character.findById(chosen.character_id)
        .select("name persona_config mode")
        .lean();
      if (!character) { result.skipped++; continue; }

      const message = await writeOutreachMessage(
        character.name,
        character.persona_config?.system_prompt ?? "",
        chosen.hint,
      );
      if (!message) { result.skipped++; continue; }

      const ok = await deliver(
        userId,
        chosen.character_id,
        character.name,
        user.push_token,
        message,
        character.mode ?? "companion",
      );

      await FollowUp.updateOne(
        { _id: chosen._id },
        { $set: ok ? { status: "sent", sent_at: now } : { status: "pending" } },
      );
      if (ok) {
        result.sent++;
        logger.info({ userId, companion: character.name }, "outreach: sent");
      } else {
        result.skipped++;
      }
    } catch (err) {
      // One user's failure must never stop the sweep for everyone else.
      logger.error({ err, userId }, "outreach: sweep failed for user");
      result.skipped++;
    }
  }

  logger.info(result, "outreach: sweep complete");
  return result;
}
