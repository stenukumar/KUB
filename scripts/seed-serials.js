/**
 * Adds valid product serial numbers to Firebase (collection `qr_codes`).
 * Existing serials are never overwritten, so it is safe to run twice.
 *
 * Usage:
 *   node scripts/seed-serials.js --prefix PRI0 --from 1321830 --to 1322109 --product "Papaya Red Lady"
 *   node scripts/seed-serials.js --file serials.txt --product "Papaya Red Lady"   (one serial per line)
 */
const fs = require("fs");
const config = require("../src/config/env");
const { getDb } = require("../src/config/firebase");
const { normalizeSerial } = require("../src/utils/validate");

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

function buildSerials(a) {
  if (a.file) {
    return fs.readFileSync(a.file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  const from = Number(a.from);
  const to = Number(a.to);
  if (!a.prefix || !Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    console.error('Provide --file <path>  OR  --prefix <text> --from <n> --to <n>');
    process.exit(1);
  }
  const list = [];
  for (let n = from; n <= to; n += 1) list.push(`${a.prefix}${n}`);
  return list;
}

async function main() {
  const a = args();
  const productName = a.product || "Papaya Red Lady";
  const serials = [...new Set(buildSerials(a).map(normalizeSerial))];
  if (serials.includes(null)) {
    console.error("Some serial numbers are invalid (use letters, digits, - or _ only).");
    process.exit(1);
  }

  const db = getDb(config.firebase);
  const col = db.collection("qr_codes");
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < serials.length; i += 400) {
    const chunk = serials.slice(i, i + 400);
    const snaps = await db.getAll(...chunk.map((s) => col.doc(s)));
    const batch = db.batch();
    snaps.forEach((snap, idx) => {
      if (snap.exists) { skipped += 1; return; }
      batch.set(col.doc(chunk[idx]), {
        serialNumber: chunk[idx],
        productName,
        isRegistered: false,
        status: "unused",
        customerName: "",
        email: "",
        phone: "",
        createdAt: new Date(),
      });
      added += 1;
    });
    await batch.commit();
  }

  console.log(`Done. Added: ${added}, already existed: ${skipped}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
