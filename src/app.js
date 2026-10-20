const path = require("path");
const express = require("express");
const cors = require("cors");
const { createApiRouter } = require("./routes/api");
const { createProductStore } = require("./services/products");
const { createIncidentCounter } = require("./services/incidents");
const { createOtpService } = require("./services/otp");
const { createQrService, AdminError } = require("./services/qrCodes");
const { createAdminRouter } = require("./routes/admin");
const { createQrHasher } = require("./utils/qrHash");

/**
 * Builds the Express app. Dependencies are injected so the same code runs
 * in production (real Firestore / Fast2SMS / Gmail) and in tests (fakes).
 */
// localhost and private-network addresses (another PC / phone on the same Wi-Fi or office network)
const PRIVATE_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.local)(:\d{1,5})?$/i;

// This computer itself, on any port. The API sends no cookies, so this is safe in production too and it means
// "npm run dev" on your own machine keeps working even when the .env file is the production one.
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** "https://Site.com/some/path/" -> "https://site.com"  (an Origin is only scheme + host + port). */
function toOrigin(value) {
  const text = String(value || "").trim();
  try {
    return new URL(text).origin.toLowerCase();
  } catch {
    return text.replace(/\/+$/, "").toLowerCase();
  }
}

/** Normalises the configured addresses and also accepts the www / non-www twin of each website. */
function buildOriginSet(list) {
  const set = new Set();
  for (const entry of list) {
    if (entry === "*") {
      set.add("*");
      continue;
    }
    const origin = toOrigin(entry);
    if (!origin) continue;
    set.add(origin);
    try {
      const url = new URL(origin);
      const host = url.hostname;
      const isIpOrLocal = host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":");
      if (!isIpOrLocal) {
        const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
        set.add(`${url.protocol}//${twin}${url.port ? `:${url.port}` : ""}`);
      }
    } catch {
      /* not a URL - keep the plain text only */
    }
  }
  return set;
}

/**
 * Decides whether a website address (Origin) may call this API from a browser.
 *  - FRONTEND_URLS = "*"            -> everyone
 *  - FRONTEND_URLS = a list         -> exactly those websites (www / non-www both, paths and a trailing / are ignored)
 *  - localhost / 127.0.0.1          -> always (your own computer)
 *  - allowLanOrigins (development)  -> also private network addresses (192.168.x.x ...)
 *  - empty list                     -> everyone (development convenience)
 */
function isOriginAllowed(origin, { allowedOrigins = [], allowLanOrigins = false } = {}) {
  if (!origin) return true; // curl, server-to-server, same-origin requests
  const allowed = allowedOrigins instanceof Set ? allowedOrigins : buildOriginSet(allowedOrigins);
  if (allowed.has("*")) return true;
  if (allowed.size === 0) return true;
  if (LOCALHOST_ORIGIN.test(origin)) return true;
  if (allowed.has(toOrigin(origin))) return true;
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

  // The website address used in the emails is a website that must be allowed to call the API as well
  const allowedSet = buildOriginSet([...allowedOrigins, process.env.FRONTEND_PUBLIC_URL].filter(Boolean));
  console.log(
    `CORS: allowed websites = ${allowedSet.size ? [...allowedSet].join(", ") : "everyone"}; localhost is always allowed`
  );

  app.use(
    cors({
      origin(origin, callback) {
        const allowed = isOriginAllowed(origin, { allowedOrigins: allowedSet, allowLanOrigins });
        if (!allowed) console.warn(`CORS blocked origin: ${origin}  (add it to FRONTEND_URLS in .env)`);
        return callback(null, allowed);
      },
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    })
  );

  // Admin tool (/admin): create products and print their QR codes. It is mounted before the small JSON limit
  // below because it brings its own, larger limit and its own key check (ADMIN_API_KEY).
  const products = createProductStore(db);
  const qrService = createQrService({
    db,
    getHasher: () => {
      try {
        return createQrHasher(process.env.QR_HASH_SECRET);
      } catch (err) {
        throw new AdminError(503, "QR_HASH_SECRET_MISSING", err.message);
      }
    },
    getBaseUrl: () => {
      const url = String(process.env.FRONTEND_PUBLIC_URL || "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(url)) {
        throw new AdminError(500, "NO_FRONTEND_URL", "Set FRONTEND_PUBLIC_URL (the address of your website) in the backend environment.");
      }
      return url;
    },
    loadQrLib: () => require("qrcode"),
  });
  app.use(createAdminRouter({ qr: qrService, getAdminKey: () => process.env.ADMIN_API_KEY }));

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

module.exports = { createApp, isOriginAllowed, buildOriginSet };