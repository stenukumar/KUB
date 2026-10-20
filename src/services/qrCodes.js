const { normalizeSerial, cleanText } = require("../utils/validate");
const { COLLECTION } = require("./products");

const MAX_CREATE = 1000; // products created in one request
const SCAN_LIMIT = 1000; // products looked at in one list request
const DEFAULT_SIZE = 800;

/** An error that is safe to show to the person using the admin page. */
class AdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Creates products and their QR codes on the server.
 * The QR code contains  <FRONTEND_PUBLIC_URL>/r/<hash>  - never the serial number (hash mapping).
 */
function createQrService({ db, getHasher, getBaseUrl, loadQrLib }) {
  const col = () => db.collection(COLLECTION);

  const qrLib = () => {
    try {
      return loadQrLib();
    } catch (err) {
      throw new AdminError(500, "QR_LIB_MISSING", 'The "qrcode" package is not installed. Run "npm install qrcode" in the backend and redeploy.');
    }
  };

  const linkFor = (hash) => `${getBaseUrl()}/r/${hash}`;

  /** items: [{ serialNumber, productName }] -> { created, skipped, invalid, truncated } */
  async function createProducts(items) {
    const hasher = getHasher();
    const created = [];
    const skipped = []; // already in the database (or repeated in the list)
    const invalid = [];
    const seen = new Set();
    const valid = [];

    for (const item of items.slice(0, MAX_CREATE)) {
      const serial = normalizeSerial(item && item.serialNumber);
      const name = cleanText(item && item.productName, 100);
      if (!serial || !name) {
        invalid.push(String((item && item.serialNumber) || "").slice(0, 40) || "(empty)");
        continue;
      }
      if (seen.has(serial)) {
        skipped.push(serial);
        continue;
      }
      seen.add(serial);
      valid.push({ serial, name });
    }

    for (let i = 0; i < valid.length; i += 20) {
      await Promise.all(
        valid.slice(i, i + 20).map(async ({ serial, name }) => {
          try {
            // create() fails when the document exists, so an existing product is never overwritten
            await col().doc(serial).create({
              serialNumber: serial,
              productName: name,
              isRegistered: false,
              qrHash: hasher.hashFor(serial),
              createdAt: new Date(),
            });
            created.push(serial);
          } catch (err) {
            if (err && (err.code === 6 || /already exists/i.test(err.message || ""))) skipped.push(serial);
            else throw err;
          }
        })
      );
    }
    return { created, skipped, invalid, truncated: items.length > MAX_CREATE };
  }

  /** Products (optionally only those starting with `prefix`) with their QR link and a small SVG picture. */
  async function listLinks({ prefix = "", unregisteredOnly = false, limit = 60 }) {
    const hasher = getHasher();
    const cleanPrefix = String(prefix || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const max = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 500);

    let query = col();
    if (cleanPrefix) {
      query = query.where("__name__", ">=", cleanPrefix).where("__name__", "<", `${cleanPrefix}\uf8ff`);
    }
    const snap = await query.limit(SCAN_LIMIT).get();

    const docs = snap.docs.filter((d) => !unregisteredOnly || d.data().isRegistered !== true).slice(0, max);
    const lib = qrLib();

    const items = await Promise.all(
      docs.map(async (doc) => {
        const data = doc.data();
        let hash = data.qrHash;
        if (!hash) {
          hash = hasher.hashFor(doc.id); // older products get their hash the first time they are listed
          await doc.ref.update({ qrHash: hash });
        }
        const url = linkFor(hash);
        const svg = await lib.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
        return {
          serialNumber: data.serialNumber || doc.id,
          productName: data.productName || "",
          isRegistered: data.isRegistered === true,
          url,
          svg: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        };
      })
    );
    return { items, scanned: snap.size, scanLimitReached: snap.size >= SCAN_LIMIT };
  }

  /** The QR code of one product as { contentType, body }. */
  async function image(serialInput, format, sizeInput) {
    const serial = normalizeSerial(serialInput);
    if (!serial) throw new AdminError(400, "INVALID_SERIAL", "Invalid serial number.");

    const hasher = getHasher();
    const doc = await col().doc(serial).get();
    if (!doc.exists) throw new AdminError(404, "SERIAL_NOT_FOUND", "Product not found.");

    let hash = doc.data().qrHash;
    if (!hash) {
      hash = hasher.hashFor(serial);
      await col().doc(serial).update({ qrHash: hash });
    }
    const url = linkFor(hash);
    const lib = qrLib();

    if (format === "svg") {
      const svg = await lib.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
      return { contentType: "image/svg+xml", body: svg };
    }
    const size = Math.min(Math.max(parseInt(sizeInput, 10) || DEFAULT_SIZE, 200), 2000);
    const body = await lib.toBuffer(url, { type: "png", width: size, margin: 2, errorCorrectionLevel: "M" });
    return { contentType: "image/png", body };
  }

  return { createProducts, listLinks, image, linkFor };
}

module.exports = { createQrService, AdminError, MAX_CREATE };