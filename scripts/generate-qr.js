/**
 * Generates one QR code PNG per serial number into ./qr-output
 * Each QR code contains:  <FRONTEND_PUBLIC_URL>/register?sn=<SERIAL>
 *
 * Usage:
 *   node scripts/generate-qr.js --all                       (every serial in Firebase)
 *   node scripts/generate-qr.js --prefix PRI0 --from 1321830 --to 1322109
 */
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const config = require("../src/config/env");
const { getDb } = require("../src/config/firebase");

const argv = process.argv.slice(2);
const a = {};
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith("--")) continue;
  const key = argv[i].slice(2);
  a[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
}

async function main() {
  if (!config.frontendPublicUrl) {
    console.error("Set FRONTEND_PUBLIC_URL in .env (the public address of your frontend).");
    process.exit(1);
  }

  let serials = [];
  if (a.all) {
    const snap = await getDb(config.firebase).collection("qr_codes").select().get();
    serials = snap.docs.map((d) => d.id);
  } else if (a.prefix && a.from && a.to) {
    for (let n = Number(a.from); n <= Number(a.to); n += 1) serials.push(`${a.prefix}${n}`);
  } else {
    console.error("Use --all  OR  --prefix <text> --from <n> --to <n>");
    process.exit(1);
  }

  const dir = path.join(__dirname, "..", "qr-output");
  fs.mkdirSync(dir, { recursive: true });

  for (const serial of serials) {
    const url = `${config.frontendPublicUrl}/register?sn=${encodeURIComponent(serial)}`;
    await QRCode.toFile(path.join(dir, `${serial}.png`), url, {
      errorCorrectionLevel: "M",
      width: 600,
      margin: 2,
    });
  }
  console.log(`Created ${serials.length} QR codes in ${dir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
