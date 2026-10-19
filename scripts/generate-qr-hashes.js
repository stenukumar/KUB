/**
 * Gives every product (document in `qr_codes`) its secret QR hash and writes the QR links to a CSV.
 *
 *   node scripts/generate-qr-hashes.js
 *   node scripts/generate-qr-hashes.js https://knownyou.dyrect.co      (link address; default FRONTEND_PUBLIC_URL)
 *
 * Safe to run again at any time: products that already have a hash keep it, new products get one.
 * Needs QR_HASH_SECRET (and the Firebase settings) in .env. Keep QR_HASH_SECRET private and never change it
 * after the QR codes are printed.
 */
const fs = require("fs");
const path = require("path");
const { createQrHasher } = require("../src/utils/qrHash");

const COLLECTION = "qr_codes";
const BATCH_SIZE = 400;

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

/** Adds a missing `qrHash` to every product. Returns the rows for the CSV. */
async function backfillHashes({ db, hasher, baseUrl }) {
  const snapshot = await db.collection(COLLECTION).get();
  const rows = [];
  const seen = new Map();
  let batch = db.batch();
  let pending = 0;
  let created = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const serial = data.serialNumber || doc.id;
    const hash = data.qrHash || hasher.hashFor(serial);

    if (seen.has(hash)) throw new Error(`Two products got the same hash (${seen.get(hash)} and ${serial}).`);
    seen.set(hash, serial);

    if (!data.qrHash) {
      batch.update(doc.ref, { qrHash: hash });
      pending += 1;
      created += 1;
      if (pending === BATCH_SIZE) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    rows.push({ serial, productName: data.productName || "", hash, url: `${baseUrl}/r/${hash}` });
  }
  if (pending > 0) await batch.commit();

  return { rows, created, total: snapshot.size };
}

async function main() {
  const config = require("../src/config/env");
  const { getDb } = require("../src/config/firebase");

  const baseUrl = String(process.argv[2] || config.frontendPublicUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("Give the site address:  node scripts/generate-qr-hashes.js https://your-site.com   (or set FRONTEND_PUBLIC_URL)");
  }

  const hasher = createQrHasher(process.env.QR_HASH_SECRET);
  const db = getDb(config.firebase);
  const { rows, created, total } = await backfillHashes({ db, hasher, baseUrl });

  const out = path.join(process.cwd(), "qr-links.csv");
  const csv = ["serialNumber,productName,hash,qrLink", ...rows.map((r) => [r.serial, r.productName, r.hash, r.url].map(csvCell).join(","))];
  fs.writeFileSync(out, csv.join("\n") + "\n", "utf8");

  console.log(`${total} products checked, ${created} new hashes saved.`);
  console.log(`QR links written to ${out}  - print the QR codes from the "qrLink" column.`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

module.exports = { backfillHashes };