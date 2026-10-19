const path = require("path");
const express = require("express");
const cors = require("cors");
const { createApiRouter } = require("./routes/api");
const { createProductStore } = require("./services/products");
const { createIncidentCounter } = require("./services/incidents");
const { createOtpService } = require("./services/otp");

/**
 * Builds the Express app. Dependencies are injected so the same code runs
 * in production (real Firestore / Fast2SMS / Gmail) and in tests (fakes).
 */
// localhost and private-network addresses (another PC / phone on the same Wi-Fi or office network)
const PRIVATE_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.local)(:\d{1,5})?$/i;

/**
 * Decides whether a website address (Origin) may call this API from a browser.
 *  - FRONTEND_URLS = "*"            -> everyone
 *  - FRONTEND_URLS = a list         -> exactly those addresses
 *  - allowLanOrigins (development)  -> also localhost and private network addresses
 *  - empty list                     -> everyone (development convenience)
 */
function isOriginAllowed(origin, { allowedOrigins = [], allowLanOrigins = false } = {}) {
  if (!origin) return true; // curl, server-to-server, same-origin requests
  if (allowedOrigins.includes("*")) return true;
  if (allowedOrigins.length === 0) return true;
  if (allowedOrigins.includes(origin.replace(/\/+$/, ""))) return true;
  if (allowLanOrigins && PRIVATE_ORIGIN.test(origin)) return true;
  return false;
}

function createApp({ db, sms, mailer, allowedOrigins = [], allowLanOrigins = false, logRequests = false }) {
  const app = express();
  app.set("trust proxy", 1); // correct client IP behind Render / Railway / Nginx
  app.disable("x-powered-by");

  // Newer Chrome asks permission before a page on one network calls a server on a private network
  app.use((req, res, next) => {
    if (req.headers["access-control-request-private-network"] === "true") {
      res.set("Access-Control-Allow-Private-Network", "true");
    }
    next();
  });

  app.use(
    cors({
      origin(origin, callback) {
        const allowed = isOriginAllowed(origin, { allowedOrigins, allowLanOrigins });
        if (!allowed) console.warn(`CORS blocked origin: ${origin}  (add it to FRONTEND_URLS in .env)`);
        return callback(null, allowed);
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    })
  );
  app.use(express.json({ limit: "20kb" }));

  if (logRequests) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on("finish", () => {
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started} ms)`);
      });
      next();
    });
  }

  // Public logos used inside the emails (<img src="https://.../email-assets/known-you-seed-logo.png">)
  app.use(
    "/email-assets",
    express.static(path.join(__dirname, "..", "assets", "email"), { maxAge: "7d", index: false, fallthrough: true })
  );

  app.get("/", (req, res) => res.send("Known-You Seed QR backend is running"));
  app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  const products = createProductStore(db);
  const incidents = createIncidentCounter(db);
  const otp = createOtpService({ db, sms, products });
  app.use("/api", createApiRouter({ db, products, sms, mailer, incidents, otp }));

  app.use((req, res) =>
    res.status(404).json({ success: false, code: "NOT_FOUND", message: "Route not found." })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ success: false, code: "BAD_JSON", message: "Invalid JSON body." });
    }
    console.error("Unhandled error:", err);
    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Something went wrong. Please try again.",
    });
  });

  return app;
}

module.exports = { createApp, isOriginAllowed };