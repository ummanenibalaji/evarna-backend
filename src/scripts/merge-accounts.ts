/**
 * Merge two accounts that belong to the same person into one.
 *
 *   npm run merge:accounts -- --keep <userId> --absorb <userId>                 # dry run
 *   npm run merge:accounts -- --keep <userId> --absorb <userId> --apply --backup <file.json>
 *
 * Needed for people who signed in by email and by Google (or Apple) before
 * sign-in methods were linked, and so ended up with two accounts. New sign-ins
 * link automatically now (see findOrCreateUser); this repairs the old ones.
 *
 * What it does, in order:
 *   1. writes a backup: both user documents and the id of every document moved
 *   2. re-points every document owned by --absorb (companions, sessions, turns,
 *      memories, follow-ups...) to --keep, preserving the id's stored type
 *   3. deletes the --absorb user
 *   4. links --absorb's sign-in method(s) to --keep, so signing in that way
 *      now lands in the kept account
 *
 * Guards:
 *   - refuses NODE_ENV=production
 *   - refuses if --absorb has a store purchase (a real subscription must not be
 *     moved or dropped by a dev script)
 *   - dry run unless --apply, and --apply requires --backup
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") fail("refusing to run with NODE_ENV=production");

  const keepId = arg("keep");
  const absorbId = arg("absorb");
  const apply = process.argv.includes("--apply");
  const backupPath = arg("backup");
  if (!keepId || !absorbId) fail("usage: --keep <userId> --absorb <userId> [--apply --backup <file.json>]");
  if (!mongoose.Types.ObjectId.isValid(keepId) || !mongoose.Types.ObjectId.isValid(absorbId)) fail("both ids must be user ids");
  if (keepId === absorbId) fail("--keep and --absorb are the same account");
  if (apply && !backupPath) fail("--apply needs --backup <file.json>");

  await connectDatabase();
  const db = mongoose.connection.db!;
  const users = db.collection("users");
  const keepOid = new mongoose.Types.ObjectId(keepId);
  const absorbOid = new mongoose.Types.ObjectId(absorbId);

  const [keep, absorb] = await Promise.all([users.findOne({ _id: keepOid }), users.findOne({ _id: absorbOid })]);
  if (!keep) fail(`no user ${keepId}`);
  if (!absorb) fail(`no user ${absorbId}`);

  const absorbSub = await db.collection("subscriptions").findOne({
    $or: [{ user_id: absorbId }, { user_id: absorbOid }],
  });
  if (absorbSub && absorbSub["platform"] !== "none" && absorbSub["platform"] !== "dev_grant") {
    fail(`${absorbId} has a store subscription (${absorbSub["platform"]}) — merge it by hand`);
  }

  console.log(`\nkeep   ${keepId}  ${keep["auth_provider"]}  ${keep["email"]}`);
  console.log(`absorb ${absorbId}  ${absorb["auth_provider"]}  ${absorb["email"]}\n`);

  // Every collection that holds this user's documents, and which ids move.
  const moves: Record<string, { stringIds: string[]; objectIds: string[] }> = {};
  for (const { name } of await db.listCollections().toArray()) {
    if (name === "users") continue;
    const c = db.collection(name);
    const [asString, asObject] = await Promise.all([
      c.find({ user_id: absorbId }, { projection: { _id: 1 } }).toArray(),
      c.find({ user_id: absorbOid }, { projection: { _id: 1 } }).toArray(),
    ]);
    if (asString.length || asObject.length) {
      moves[name] = {
        stringIds: asString.map((d) => String(d._id)),
        objectIds: asObject.map((d) => String(d._id)),
      };
      console.log(`  ${name.padEnd(22)} ${asString.length + asObject.length} to move`);
    }
  }

  if (!apply) {
    console.log("\n(dry run — nothing changed. Re-run with --apply --backup <file.json>)\n");
    await mongoose.disconnect();
    return;
  }

  writeFileSync(backupPath!, JSON.stringify({ at: new Date(), keep, absorb, absorbSub, moves }, null, 2));
  console.log(`\nbackup written: ${backupPath}`);

  // A kept account's own subscription wins; an absorbed dev/free one is dropped.
  if (moves["subscriptions"]) {
    const keepSub = await db.collection("subscriptions").findOne({ $or: [{ user_id: keepId }, { user_id: keepOid }] });
    if (keepSub) {
      await db.collection("subscriptions").deleteMany({ $or: [{ user_id: absorbId }, { user_id: absorbOid }] });
      delete moves["subscriptions"];
      console.log("  subscriptions          kept account's own retained; absorbed one removed");
    }
  }

  for (const name of Object.keys(moves)) {
    const c = db.collection(name);
    const [s, o] = await Promise.all([
      c.updateMany({ user_id: absorbId }, { $set: { user_id: keepId } }),
      c.updateMany({ user_id: absorbOid }, { $set: { user_id: keepOid } }),
    ]);
    console.log(`  ${name.padEnd(22)} moved ${s.modifiedCount + o.modifiedCount}`);
  }

  // Delete first: the absorbed account's own linked identities would otherwise
  // collide with the unique index when they are added to the kept account.
  await users.deleteOne({ _id: absorbOid });

  const carried = [
    { provider: absorb["auth_provider"], sub: absorb["provider_sub"], linked_at: new Date() },
    ...((absorb["linked_identities"] as { provider: string; sub: string }[] | undefined) ?? []).map((l) => ({
      provider: l.provider,
      sub: l.sub,
      linked_at: new Date(),
    })),
  ];

  // The more recently used device is the one to keep notifying.
  const absorbNewer =
    ((absorb["last_active_at"] as Date | undefined)?.getTime() ?? 0) >
    ((keep["last_active_at"] as Date | undefined)?.getTime() ?? 0);
  const deviceFields: Record<string, unknown> = {};
  if (absorbNewer && absorb["push_token"]) deviceFields["push_token"] = absorb["push_token"];
  if (absorbNewer && absorb["timezone"]) deviceFields["timezone"] = absorb["timezone"];

  const update: Record<string, unknown> = { $push: { linked_identities: { $each: carried } } };
  if (Object.keys(deviceFields).length) update["$set"] = deviceFields;
  await users.updateOne({ _id: keepOid }, update);
  console.log(`  linked to kept account: ${carried.map((c) => c.provider).join(", ")}`);
  console.log("\n✅ merged\n");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
