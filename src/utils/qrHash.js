const crypto = require("crypto");

/**
 * Hash mapping for QR codes.
 *
 * The QR code does NOT contain the serial number. It contains a long random-looking hash,
 * e.g.  https://knownyou.dyrect.co/r/Qm3vX9t2LkP0aZr7bNf4YcHd
 * The database stores that hash next to the serial number (field `qrHash`), so the backend can
 * map  hash -> serial number.  Nobody can guess or count through serial numbers, and nobody
 * can compute a hash without the secret (QR_HASH_SECRET) kept on the server.
 */
const HASH_LENGTH = 24; // 24 characters = 144 bits

function createQrHasher(secret) {
  if (!secret || String(secret).length < 16) {
    throw new Error("QR_HASH_SECRET is missing or too short. Set a long random text (16+ characters) in your .env file.");
  }

  /** Same serial + same secret always gives the same hash (so re-running the script is safe). */
  const hashFor = (serial) =>
    crypto.createHmac("sha256", String(secret)).update(String(serial)).digest("base64url").slice(0, HASH_LENGTH);

  return { hashFor };
}

/** True for text that looks like one of our hashes (checked before touching the database). */
const isValidHashFormat = (value) => new RegExp(`^[A-Za-z0-9_-]{${HASH_LENGTH}}$`).test(String(value || ""));

module.exports = { createQrHasher, isValidHashFormat, HASH_LENGTH };