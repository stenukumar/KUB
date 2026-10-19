// Serial numbers are used as Firestore document IDs, so they must never contain "/" etc.
const SERIAL_PATTERN = /^[A-Z0-9][A-Z0-9_-]{3,39}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeSerial(value) {
  if (typeof value !== "string") return null;
  const serial = value.trim().toUpperCase();
  return SERIAL_PATTERN.test(serial) ? serial : null;
}

/** Accepts 10 digits, or 91 / +91 / 0 prefixed numbers. Returns 10 digits or null. */
function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Returns "" when empty (email is optional), null when invalid, otherwise the lower-cased email. */
function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return "";
  return EMAIL_PATTERN.test(email) && email.length <= 254 ? email : null;
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Keeps line breaks (feedback / incident messages) but trims and limits length. */
function cleanMessage(value, maxLength = 2000) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, maxLength);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Firestore Timestamp | Date | string -> ISO string (or null). */
function toIso(value) {
  if (!value) return null;
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  normalizeSerial,
  normalizePhone,
  normalizeEmail,
  cleanText,
  cleanMessage,
  escapeHtml,
  toIso,
};
