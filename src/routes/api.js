const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");
const { OtpError } = require("../services/otp");
const { isValidHashFormat } = require("../utils/qrHash");
const {
  normalizeSerial,
  normalizePhone,
  normalizeEmail,
  cleanText,
  cleanMessage,
} = require("../utils/validate");

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

/**
 * Hash mapping switch.
 *  - QR_HASH_SECRET is set in .env  -> hash mapping is ON: only hash links (/r/<hash>) can verify or register a product.
 *  - QR_HASH_SECRET is not set      -> plain serial links keep working (nothing is enforced).
 * ALLOW_PLAIN_SERIAL=true / false overrides this (for example "true" while old QR codes are still in use).
 */
const allowPlainSerial = () => {
  const setting = String(process.env.ALLOW_PLAIN_SERIAL ?? "").trim().toLowerCase();
  if (setting === "true") return true;
  if (setting === "false") return false;
  return !String(process.env.QR_HASH_SECRET || "").trim();
};

/**
 * If Firestore does not answer (network, firewall, VPN, wrong credentials, wrong PC clock ...) the request would
 * hang until the browser gives up. This turns that into a clear error and a line in the backend terminal.
 */
const DB_TIMEOUT_MS = 50 * 1000;
function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} did not finish within ${DB_TIMEOUT_MS / 1000} seconds`);
      err.code = "DB_TIMEOUT";
      reject(err);
    }, DB_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SCAN_QR_MESSAGE = "Please scan the QR code on your product to register it.";

/** Runs a send and always returns a promise, even if the sender throws straight away. */
const attempt = (fn) => Promise.resolve().then(fn);

const settled = (result) =>
  result.status === "fulfilled"
    ? { sent: true, error: null }
    : { sent: false, error: String(result.reason?.message || result.reason || "failed").slice(0, 300) };

function createApiRouter({ db, products, sms, mailer, incidents, otp }) {
  const router = express.Router();

  console.log(
    allowPlainSerial()
      ? "QR hash mapping: OFF - plain serial links still work (set QR_HASH_SECRET in .env to turn it on)"
      : "QR hash mapping: ON - only hash links (/r/<hash>) can verify or register products"
  );

  const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
  const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120 });
  // Stricter: this lookup is keyed by phone number, so slow down anyone trying many numbers
  const lookupLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

  // ------------------------------------------------------------------
  // GET /api/products/:serial
  // Called as soon as the QR is scanned. Tells the frontend whether the
  // serial number is genuine and whether it can still be registered.
  // ------------------------------------------------------------------
  /** Same reply for the plain-serial and the hash lookup. */
  function replyWithProduct(res, serial, data) {
    const product = products.toPublic(serial, data);
    return res.json({
      success: true,
      valid: true,
      canRegister: !product.isRegistered,
      message: product.isRegistered
        ? "This product is already registered."
        : "Genuine product. You can register it now.",
      product,
    });
  }

  // GET /api/qr/:hash   (the QR code link is  /r/<hash>)
  router.get("/qr/:hash", readLimit, async (req, res, next) => {
    try {
      const hash = String(req.params.hash || "").trim();
      const notFound = () =>
        fail(res, 404, "SERIAL_NOT_FOUND", "Invalid QR code. This product could not be verified.", { valid: false });
      if (!isValidHashFormat(hash)) return notFound();

      const found = await products.findByHash(hash);
      if (!found) return notFound();
      return replyWithProduct(res, found.serial, found.data);
    } catch (err) {
      return next(err);
    }
  });

  router.get("/products/:serial", readLimit, async (req, res, next) => {
    try {
      if (!allowPlainSerial()) {
        return fail(res, 403, "QR_HASH_REQUIRED", SCAN_QR_MESSAGE, { valid: false });
      }
      const serial = normalizeSerial(req.params.serial);
      if (!serial) {
        return fail(res, 400, "INVALID_SERIAL", "Invalid QR code. Please scan a valid product QR code.", {
          valid: false,
        });
      }

      const data = await products.find(serial);
      if (!data) {
        return fail(res, 404, "SERIAL_NOT_FOUND", "Invalid QR code. This product could not be verified.", {
          valid: false,
        });
      }

      return replyWithProduct(res, serial, data);
    } catch (err) {
      return next(err);
    }
  });

  // ------------------------------------------------------------------
  // POST /api/customers/products      body: { phone }
  // Every product registered with this phone number (used by My Favorites).
  // The phone number is sent in the body, not the URL, so it stays out of logs.
  // ------------------------------------------------------------------
  router.post("/customers/products", lookupLimit, async (req, res, next) => {
    try {
      const phone = normalizePhone((req.body || {}).phone);
      if (!phone) return fail(res, 400, "INVALID_PHONE", "Please enter a valid 10-digit mobile number.");

      const list = await products.listByPhone(phone);
      return res.json({ success: true, count: list.length, products: list });
    } catch (err) {
      return next(err);
    }
  });

  // ------------------------------------------------------------------
  // Sign in / sign up with a mobile number and an SMS code
  //   POST /api/auth/send-otp    body: { phone, purpose: "signin" | "signup", name?, email? }
  //   POST /api/auth/verify-otp  body: { phone, otp, purpose }
  // ------------------------------------------------------------------
  const authLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

  const authHandler = (action) => async (req, res, next) => {
    try {
      return res.json({ success: true, ...(await action(req.body || {})) });
    } catch (err) {
      if (err instanceof OtpError) return fail(res, err.status, err.code, err.message);
      return next(err);
    }
  };

  router.post("/auth/send-otp", authLimit, authHandler((body) => otp.requestOtp(body)));
  router.post("/auth/verify-otp", authLimit, authHandler((body) => otp.verifyOtp(body)));

  // ------------------------------------------------------------------
  // POST /api/register
  // body: { hash (from the QR link) or serialNumber, name, email, phone, agreedToPolicy }
  // ------------------------------------------------------------------
  router.post("/register", writeLimit, async (req, res, next) => {
    try {
      const body = req.body || {};
      let serial = "";
      if (body.hash) {
        const hash = String(body.hash).trim();
        const found = isValidHashFormat(hash) ? await products.findByHash(hash) : null;
        if (!found) return fail(res, 404, "SERIAL_NOT_FOUND", "Invalid QR code. This product could not be verified.");
        serial = found.serial;
      } else if (allowPlainSerial()) {
        serial = normalizeSerial(body.serialNumber);
      } else {
        return fail(res, 403, "QR_HASH_REQUIRED", SCAN_QR_MESSAGE);
      }
      const customerName = cleanText(body.name ?? body.customerName, 100);
      const phone = normalizePhone(body.phone);
      const email = normalizeEmail(body.email);

      if (!serial) return fail(res, 400, "INVALID_SERIAL", "Invalid QR code.");
      if (!customerName) return fail(res, 400, "NAME_REQUIRED", "Please enter your name.");
      if (!phone) return fail(res, 400, "INVALID_PHONE", "Please enter a valid 10-digit mobile number.");
      if (email === null) return fail(res, 400, "INVALID_EMAIL", "Please enter a valid email address.");
      if (body.agreedToPolicy === false) {
        return fail(res, 400, "POLICY_REQUIRED", "You must agree to the Privacy Policy.");
      }

      const started = Date.now();
      const result = await withTimeout(products.register(serial, { customerName, email, phone }), "Firestore registration");
      const took = Date.now() - started;

      if (result.status === "not_found") {
        console.log(`Registration refused for ${serial}: serial number not found (${took} ms)`);
        return fail(res, 404, "SERIAL_NOT_FOUND", "Invalid QR code. This product could not be verified.");
      }
      if (result.status === "already_registered") {
        console.log(`Registration refused for ${serial}: this product was already registered (${took} ms)`);
        return fail(res, 409, "ALREADY_REGISTERED", "This product is already registered.", {
          product: result.product,
        });
      }

      console.log(`Registration saved for ${serial} in ${took} ms`);

      // Registration is saved. Reply to the customer right away; SMS and email are sent in the
      // background so a slow or blocked provider can never make the registration look failed.
      const { product } = result;

      Promise.allSettled([
        attempt(() => sms.sendRegistrationSms(phone)),
        email
          ? attempt(() => mailer.sendWelcomeEmail({ to: email, customerName }))
          : Promise.reject(new Error("No email address provided")),
      ])
        .then(async ([smsResult, emailResult]) => {
          const notifications = {
            sms: settled(smsResult),
            email: email ? settled(emailResult) : { sent: false, skipped: true, error: null },
          };
          if (!notifications.sms.sent) console.error(`SMS failed for ${serial}:`, notifications.sms.error);
          else console.log(`SMS sent for ${serial}`);
          if (email) {
            if (!notifications.email.sent) console.error(`Email failed for ${serial}:`, notifications.email.error);
            else console.log(`Email sent for ${serial}`);
          }
          await products.saveNotificationStatus(serial, notifications);
        })
        .catch((err) => console.error(`Notification step failed for ${serial}:`, err));

      return res.status(201).json({
        success: true,
        message: "Product registered successfully.",
        product,
        customer: { name: customerName, email, phone },
        notifications: {
          sms: { queued: true },
          email: email ? { queued: true } : { queued: false, skipped: true },
        },
      });
    } catch (err) {
      if (err && err.code === "DB_TIMEOUT") {
        console.error("Registration failed:", err.message, "- Firestore is not answering. Check internet/VPN/firewall, the Firebase credentials in .env and the PC date and time.");
        return fail(res, 503, "DATABASE_TIMEOUT", "The server could not reach the database. Please try again in a moment.");
      }
      return next(err);
    }
  });

  // Shared handler for feedback + incident (same fields, different mailbox/collection)
  function customerMessageHandler({ collection, sendMail, okMessage, label, ackKind }) {
    return async (req, res, next) => {
      try {
        const body = req.body || {};
        const serial = normalizeSerial(body.serialNumber);
        const customerName = cleanText(body.name, 100);
        const phone = normalizePhone(body.phone);
        const email = normalizeEmail(body.email);
        const message = cleanMessage(body.message, 2000);

        if (!serial) return fail(res, 400, "INVALID_SERIAL", "Invalid product serial number.");
        if (!customerName) return fail(res, 400, "NAME_REQUIRED", "Please enter your name.");
        if (!phone) return fail(res, 400, "INVALID_PHONE", "Please enter a valid 10-digit mobile number.");
        if (email === null) return fail(res, 400, "INVALID_EMAIL", "Please enter a valid email address.");
        if (!message) return fail(res, 400, "MESSAGE_REQUIRED", "Please enter your message.");

        // Only registered products can send feedback / incidents.
        const data = await products.find(serial);
        if (!data) return fail(res, 404, "SERIAL_NOT_FOUND", "Invalid product serial number.");
        if (data.isRegistered !== true) {
          return fail(res, 403, "NOT_REGISTERED", "Please register the product first.");
        }

        // One shared incident number (INC0000796 ...) for feedback and support requests
        const incidentNumber = await incidents.next();

        const record = {
          incidentNumber,
          serialNumber: serial,
          productName: data.productName || "",
          customerName,
          email,
          phone,
          message,
          createdAt: new Date(),
          emailSent: false,
          customerEmailSent: false,
        };

        // Save first so nothing is lost even if the email server is down.
        const docRef = await db.collection(collection).add(record);

        // Send the emails in the background so a slow mail server never delays the customer:
        //   - the company mailbox gets the full message
        //   - the customer gets the "we received your request" email (only if an email was entered)
        Promise.allSettled([
          attempt(() => sendMail(record)),
          email
            ? attempt(() =>
                mailer.sendAcknowledgementEmail({
                  to: email,
                  kind: ackKind,
                  customerName,
                  productName: record.productName,
                  incidentNumber,
                })
              )
            : Promise.reject(new Error("No email address provided")),
        ])
          .then(async ([companyResult, customerResult]) => {
            const update = {
              emailSent: companyResult.status === "fulfilled",
              customerEmailSent: customerResult.status === "fulfilled",
            };
            if (companyResult.status === "rejected") {
              update.emailError = String(companyResult.reason?.message || companyResult.reason).slice(0, 300);
              console.error(`${label} email to company failed for ${incidentNumber}:`, update.emailError);
            } else {
              console.log(`${label} email sent to company for ${incidentNumber}`);
            }
            if (email) {
              if (customerResult.status === "rejected") {
                update.customerEmailError = String(customerResult.reason?.message || customerResult.reason).slice(0, 300);
                console.error(`${label} confirmation to customer failed for ${incidentNumber}:`, update.customerEmailError);
              } else {
                console.log(`${label} confirmation sent to customer for ${incidentNumber}`);
              }
            }
            await docRef.update(update);
          })
          .catch((err) => console.error(`${label} email step failed for ${incidentNumber}:`, err));

        return res.status(201).json({ success: true, id: docRef.id, incidentNumber, message: okMessage });
      } catch (err) {
        return next(err);
      }
    };
  }

  // POST /api/feedback  body: { serialNumber, name, email, phone, message }
  router.post(
    "/feedback",
    writeLimit,
    customerMessageHandler({
      collection: "feedback",
      sendMail: (r) => mailer.sendFeedbackEmail(r),
      okMessage: "Thank you for your valuable inputs. We shall get back to you shortly.",
      label: "Feedback",
      ackKind: "feedback",
    })
  );

  // POST /api/incidents  body: { serialNumber, name, email, phone, message }
  router.post(
    "/incidents",
    writeLimit,
    customerMessageHandler({
      collection: "incidents",
      sendMail: (r) => mailer.sendIncidentEmail(r),
      okMessage: "Thank you for your valuable inputs. We shall get back to you shortly.",
      label: "Incident",
      ackKind: "incident",
    })
  );

  return router;
}

module.exports = { createApiRouter };