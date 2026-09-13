/**
 * Give an account a paid tier without a store.
 *
 *   npm run grant:entitlement -- --user 68a1… --tier plus
 *   npm run grant:entitlement -- --user 68a1… --tier premium --months 3
 *   npm run grant:entitlement -- --user 68a1… --reset
 *
 * There is deliberately no --topup-minutes: the wallet is not spendable until
 * the usage counters land (see ISubscription.topup_seconds), so granting one
 * would look like it did something and change nothing.
 *
 * StoreKit and Play Billing are later steps, so until they land this is the
 * only way to see the product as a paying user sees it — and the only way to
 * test that the gate lets a subscriber through rather than merely that it
 * refuses everyone.
 *
 * Two guards, because a tool that mints entitlements is a tool that gives away
 * the product:
 *   - it refuses to run in production at all;
 *   - it refuses to touch a document that came from a real store, so it can
 *     never overwrite a purchase somebody actually paid for.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { Subscription } from "../models/subscription.model.js";
import { User } from "../models/user.model.js";
import { addMonthsClamped } from "../services/entitlement.service.js";
import { TIERS } from "../data/tiers.js";
import type { Tier } from "../types/billing.types.js";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) {
    return process.argv[i + 1];
  }
  // Also accept --name=value.
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function usage(message: string): never {
  console.error(`\n✗ ${message}\n`);
  console.error("  npm run grant:entitlement -- --user <userId> --tier plus [--months 1]");
  console.error("  npm run grant:entitlement -- --user <userId> --reset\n");
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    console.error(
      "\n✗ refusing to run with NODE_ENV=production.\n" +
        "  Entitlements in production come from a verified store purchase, nowhere else.\n",
    );
    process.exit(1);
  }

  const userId = arg("user");
  if (!userId) usage("--user <userId> is required");
  if (!mongoose.Types.ObjectId.isValid(userId)) usage(`"${userId}" is not a user id`);

  const reset = process.argv.includes("--reset");
  const tierArg = arg("tier");
  const months = Number(arg("months") ?? "1");

  if (!reset && !tierArg) usage("nothing to do — pass --tier or --reset");
  if (tierArg && !(tierArg in TIERS)) usage(`unknown tier "${tierArg}" — one of ${Object.keys(TIERS).join(", ")}`);
  if (!Number.isFinite(months) || months < 1) usage("--months must be a positive whole number");

  await connectDatabase();

  const user = await User.findById(userId).select("email display_name").lean();
  if (!user) {
    console.error(`\n✗ no user ${userId}\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const existing = await Subscription.findOne({ user_id: userId }).lean();
  if (existing && existing.platform !== "none" && existing.platform !== "dev_grant") {
    console.error(
      `\n✗ ${userId} has a real ${existing.platform} subscription (${existing.product_id}).\n` +
        "  Refusing to overwrite a purchase. Cancel it at the store instead.\n",
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const now = new Date();

  if (reset) {
    // Back to free, wallet included — the state a brand-new account is in.
    await Subscription.updateOne(
      { user_id: userId },
      {
        $set: {
          tier: "free",
          status: "none",
          platform: "none",
          product_id: null,
          original_transaction_id: null,
          purchase_token: null,
          period_start: null,
          period_end: null,
          expires_at: null,
          auto_renew: false,
          topup_seconds: 0,
          last_verified_at: null,
          updated_at: now,
        },
      },
      { upsert: true },
    );
    console.log(`\n✓ ${userId} is back to free, with an empty wallet.\n`);
  } else if (tierArg) {
    const tier = tierArg as Tier;
    const until = addMonthsClamped(now, months);
    await Subscription.updateOne(
      { user_id: userId },
      {
        $set: {
          tier,
          status: tier === "free" ? "none" : "active",
          platform: tier === "free" ? "none" : "dev_grant",
          // Deliberately not a plausible store id: anything reading this later
          // should be able to tell at a glance that nobody paid for it.
          product_id: tier === "free" ? null : `dev_grant.${tier}`,
          period_start: now,
          period_end: until,
          expires_at: until,
          auto_renew: false,
          updated_at: now,
        },
        $setOnInsert: { created_at: now, topup_seconds: 0 },
      },
      { upsert: true },
    );
    console.log(
      `\n✓ ${userId} is ${tier} until ${until.toISOString()}` +
        ` (${TIERS[tier].voice_seconds / 60} voice minutes a month, ` +
        `${TIERS[tier].daily_messages} messages a day).\n`,
    );
  }

  console.log("  Check it with: GET /api/v1/billing/entitlement\n");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n✗ grant failed:", err instanceof Error ? err.message : err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
