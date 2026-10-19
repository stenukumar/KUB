const crypto = require("crypto");
const { normalizePhone, normalizeEmail, cleanText } = require("../utils/validate");

const OTP_COLLECTION = "otps";
const CUSTOMER_COLLECTION = "customers";

const OTP_TTL_MS = 5 * 60 * 1000; // a code works for 5 minutes
const RESEND_WAIT_MS = 30 * 1000; // wait 30 seconds before asking for another code
const MAX_SENDS_PER_HOUR = 5; // per phone number
const MAX_WRONG_TRIES = 5; // then the code is cancelled

/** An error that is safe to show to the customer. */
class OtpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "OtpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Sign in / sign up with a mobile number and a 6 digit SMS code.
 *  - codes are stored only as a hash (document `otps/<phone>`), never in plain text
 *  - sign up creates `customers/<phone>`; sign in works for any phone that has a customer
 *    document OR has already registered a product through the QR flow
 */
function createOtpService({
  db,
  sms,
  products,
  secret = process.env.OTP_SECRET || "known-you-seed-otp",
  isProduction = process.env.NODE_ENV === "production",
  now = () => Date.now(),
  randomCode = () => crypto.randomInt(0, 1000000),
}) {
  const otpRef = (phone) => db.collection(OTP_COLLECTION).doc(phone);
  const customerRef = (phone) => db.collection(CUSTOMER_COLLECTION).doc(phone);

  const hashCode = (phone, code) =>
    crypto.createHash("sha256").update(`${secret}:${phone}:${code}`).digest("hex");

  /** { name, email, phone } of an existing customer, or null. */
  async function findCustomer(phone) {
    const snap = await customerRef(phone).get();
    if (snap.exists) {
      const data = snap.data();
      return { name: data.name || "", email: data.email || "", phone };
    }
    return products.findCustomerByPhone(phone);
  }

  async function requestOtp({ phone, purpose, name, email }) {
    const number = normalizePhone(phone);
    if (!number) throw new OtpError(400, "INVALID_PHONE", "Please enter a valid 10-digit mobile number.");
    if (purpose !== "signin" && purpose !== "signup") {
      throw new OtpError(400, "INVALID_PURPOSE", "Something went wrong. Please try again.");
    }

    let profile = null;
    if (purpose === "signup") {
      const customerName = cleanText(name, 100);
      const customerEmail = normalizeEmail(email);
      if (!customerName) throw new OtpError(400, "NAME_REQUIRED", "Please enter your name.");
      if (customerEmail === null) throw new OtpError(400, "INVALID_EMAIL", "Please enter a valid email address.");
      if (await findCustomer(number)) {
        throw new OtpError(409, "ALREADY_EXISTS", "This mobile number is already registered. Please sign in.");
      }
      profile = { name: customerName, email: customerEmail };
    } else if (!(await findCustomer(number))) {
      throw new OtpError(404, "NO_ACCOUNT", "No account found for this mobile number. Please sign up.");
    }

    const ref = otpRef(number);
    const snap = await ref.get();
    const previous = snap.exists ? snap.data() : null;
    const time = now();

    if (previous && time - previous.sentAt < RESEND_WAIT_MS) {
      const seconds = Math.ceil((RESEND_WAIT_MS - (time - previous.sentAt)) / 1000);
      throw new OtpError(429, "TOO_SOON", `Please wait ${seconds} seconds before requesting a new code.`);
    }

    const sameHour = previous && previous.windowStart && time - previous.windowStart < 60 * 60 * 1000;
    const windowStart = sameHour ? previous.windowStart : time;
    const sendCount = sameHour ? previous.sendCount || 0 : 0;
    if (sendCount >= MAX_SENDS_PER_HOUR) {
      throw new OtpError(429, "TOO_MANY_CODES", "Too many codes requested. Please try again after some time.");
    }

    const code = String(randomCode()).padStart(6, "0");
    await ref.set({
      hash: hashCode(number, code),
      purpose,
      profile,
      expiresAt: time + OTP_TTL_MS,
      attempts: 0,
      sentAt: time,
      windowStart,
      sendCount: sendCount + 1,
    });

    if (!sms.isConfigured && !isProduction) {
      // Development without an SMS key: the code is printed in this terminal instead
      console.log(`[OTP] ${purpose} code for ${number}: ${code}  (SMS is not configured)`);
    } else {
      try {
        await sms.sendOtpSms(number, code);
      } catch (err) {
        await ref.delete().catch(() => {});
        console.error(`OTP SMS failed for ${number}:`, err.message);
        throw new OtpError(502, "SMS_FAILED", "We could not send the SMS right now. Please try again.");
      }
    }

    return { phone: number, resendAfterSeconds: RESEND_WAIT_MS / 1000 };
  }

  async function verifyOtp({ phone, otp, purpose }) {
    const number = normalizePhone(phone);
    const code = String(otp || "").replace(/\D/g, "");
    if (!number || code.length !== 6) {
      throw new OtpError(400, "INVALID_OTP", "Please enter the 6 digit verification code.");
    }

    const ref = otpRef(number);
    const snap = await ref.get();
    const expired = new OtpError(400, "OTP_EXPIRED", "The code has expired. Please tap Resend to get a new one.");
    if (!snap.exists) throw expired;

    const data = snap.data();
    if (data.purpose !== purpose) throw expired;
    if (now() > data.expiresAt) {
      await ref.delete().catch(() => {});
      throw expired;
    }
    if ((data.attempts || 0) >= MAX_WRONG_TRIES) {
      await ref.delete().catch(() => {});
      throw new OtpError(429, "TOO_MANY_ATTEMPTS", "Too many wrong attempts. Please tap Resend to get a new code.");
    }

    const expected = Buffer.from(data.hash, "hex");
    const actual = Buffer.from(hashCode(number, code), "hex");
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!match) {
      await ref.update({ attempts: (data.attempts || 0) + 1 });
      throw new OtpError(400, "WRONG_OTP", "Invalid verification code. Please try again.");
    }

    await ref.delete().catch(() => {});

    if (purpose === "signup") {
      const existing = await customerRef(number).get();
      if (!existing.exists) {
        await customerRef(number).set({
          name: data.profile.name,
          email: data.profile.email,
          phone: number,
          createdAt: new Date(),
        });
      }
      const customer = existing.exists
        ? { name: existing.data().name || "", email: existing.data().email || "", phone: number }
        : { name: data.profile.name, email: data.profile.email, phone: number };
      return { customer, isNew: !existing.exists };
    }

    const customer = await findCustomer(number);
    if (!customer) throw new OtpError(404, "NO_ACCOUNT", "No account found for this mobile number. Please sign up.");
    return { customer, isNew: false };
  }

  return { requestOtp, verifyOtp };
}

module.exports = { createOtpService, OtpError, OTP_TTL_MS, RESEND_WAIT_MS };