#!/usr/bin/env node
/**
 * Insert serial numbers into Firebase (collection `qr_codes`, document id = serial).
 * Existing serials are NEVER overwritten (safe to re-run).
 *
 * Put this file inside your backend folder (next to package.json and .env) and run:
 *   node seed_serials.js --prefix KYS --start 1 --count 100 --digits 5 --product "Papaya" --dry-run
 *   node seed_serials.js --prefix KYS --start 1 --count 100 --digits 5 --product "Papaya"
 *   node seed_serials.js --file serials.txt --product "Muskmelon"
 *   node seed_serials.js TEST1040 TEST1041 --product "Papaya"
 * It also writes serials.txt, which make_qr.py can read:  python3 make_qr.py --file serials.txt
 */
const fs = require("fs");
try { require("dotenv").config(); } catch (_) {}
const { getDb } = require("./src/config/firebase");
const env = require("./src/config/env");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flagsWithValue = ["prefix", "start", "count", "digits", "product", "file"];
const positional = args.filter((a, i) => !a.startsWith("--") && !flagsWithValue.includes((args[i - 1] || "").replace(/^--/, "")));

const SERIAL_RE = /^[A-Z0-9][A-Z0-9_-]{3,39}$/;
let serials = positional.map((s) => s.toUpperCase());
if (opt("file")) serials.push(...fs.readFileSync(opt("file"), "utf8").split(/\r?\n/).map((s) => s.trim().toUpperCase()).filter(Boolean));
if (opt("prefix") && opt("count")) {
  const start = Number(opt("start", 1)), count = Number(opt("count")), digits = Number(opt("digits", 5));
  for (let n = start; n < start + count; n++) serials.push(`${opt("prefix").toUpperCase()}${String(n).padStart(digits, "0")}`);
}
serials = [...new Set(serials)];
const bad = serials.filter((s) => !SERIAL_RE.test(s));
if (!serials.length) { console.error("No serial numbers given."); process.exit(1); }
if (bad.length) { console.error("Invalid serials (A-Z 0-9 _ - , 4-40 chars):", bad.slice(0, 10).join(", ")); process.exit(1); }

const productName = opt("product", "");
const dryRun = args.includes("--dry-run");

(async () => {
  fs.writeFileSync("serials.txt", serials.join("\n") + "\n");
  if (dryRun) { console.log(`DRY RUN: would insert ${serials.length} serials (${serials[0]} ... ${serials[serials.length - 1]}). serials.txt written.`); return; }
  const db = getDb(env.firebase);
  const writer = db.bulkWriter();
  let added = 0, existing = 0, failed = 0;
  writer.onWriteError((err) => { if (err.code === 6) return false; return err.failedAttempts < 5; }); // 6 = ALREADY_EXISTS, don't retry
  await Promise.all(serials.map((serial) =>
    writer.create(db.collection("qr_codes").doc(serial), {
      serialNumber: serial,
      productName,
      isRegistered: false,
      status: "unregistered",
      createdAt: new Date(),
    }).then(() => { added++; }, (e) => { e.code === 6 ? existing++ : failed++; if (e.code !== 6) console.error(serial, e.message); })
  ));
  await writer.close();
  console.log(`Done. Added ${added}, already existed ${existing}, failed ${failed}. serials.txt written.`);
})().catch((e) => { console.error(e.message); process.exit(1); });