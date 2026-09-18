/**
 * Signing in by email, Google or Apple with the same verified address must
 * land in ONE account.
 *
 *   npm run check:account-linking
 *
 * ⚠️  Talks to the real MONGODB_URI from .env. Creates users with addresses
 * ending in @evarna.test and deletes them on the way out.
 *
 * Before linking existed, each provider created its own account for the same
 * person — separate companions, separate history, separate voice minutes.
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { User } from "../models/user.model.js";
import { findOrCreateUser } from "../services/auth.service.js";

const stamp = Date.now();
const email = `link-check-${stamp}@evarna.test`;
const otherEmail = `link-check-other-${stamp}@evarna.test`;

let failures = 0;
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}\n      ${(err as Error).message}`);
    failures++;
  }
}

async function main(): Promise<void> {
  await connectDatabase();

  try {
    // The unique index on linked identities is part of what is being checked.
    await User.createIndexes();

    const viaEmail = await findOrCreateUser("email", { sub: email, email, email_verified: true });
    const id = viaEmail._id.toString();

    await check("Google with the same verified email joins the email account", async () => {
      const viaGoogle = await findOrCreateUser("google", { sub: `g-${stamp}`, email, email_verified: true });
      assert.equal(viaGoogle._id.toString(), id);
    });

    await check("the linked Google identity finds the account again directly", async () => {
      const again = await findOrCreateUser("google", { sub: `g-${stamp}`, email: null, email_verified: false });
      assert.equal(again._id.toString(), id, "a later Google sign-in without an email created a new account");
    });

    await check("Apple with the same verified email joins too", async () => {
      const viaApple = await findOrCreateUser("apple", { sub: `a-${stamp}`, email, email_verified: true });
      assert.equal(viaApple._id.toString(), id);
    });

    await check("the account holds each method once", async () => {
      const doc = await User.findById(id).lean();
      const linked = (doc?.linked_identities ?? []).map((l) => `${l.provider}:${l.sub}`).sort();
      assert.deepEqual(linked, [`apple:a-${stamp}`, `google:g-${stamp}`]);
    });

    await check("an UNVERIFIED email never links — it gets its own account", async () => {
      const stranger = await findOrCreateUser("google", { sub: `g2-${stamp}`, email, email_verified: false });
      assert.notEqual(stranger._id.toString(), id, "an unverified address was trusted to reach an existing account");
    });

    await check("a different verified email gets its own account", async () => {
      const other = await findOrCreateUser("email", { sub: otherEmail, email: otherEmail, email_verified: true });
      assert.notEqual(other._id.toString(), id);
    });

    await check("email sign-in after a Google-created account also joins it", async () => {
      const gEmail = `link-check-g-first-${stamp}@evarna.test`;
      const first = await findOrCreateUser("google", { sub: `g3-${stamp}`, email: gEmail, email_verified: true });
      const second = await findOrCreateUser("email", { sub: gEmail, email: gEmail, email_verified: true });
      assert.equal(second._id.toString(), first._id.toString());
    });
  } finally {
    await User.deleteMany({ email: { $regex: `^link-check-.*-?${stamp}@evarna\\.test$` } });
    await User.deleteMany({ email: { $in: [email, otherEmail] } });
    await mongoose.disconnect();
  }

  console.log("");
  if (failures > 0) {
    console.error(`❌ account linking check failed — ${failures} assertion(s)`);
    process.exitCode = 1;
    return;
  }
  console.log("✅ account linking check passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
