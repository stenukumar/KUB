const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { AdminError } = require("../services/qrCodes");

const PAGE = path.join(__dirname, "..", "views", "admin.html");

const FAIL_LIMIT = 10; // wrong keys per address ...
const FAIL_WINDOW_MS = 15 * 60 * 1000; // ... in this time

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest();

/** Checks the x-admin-key header against ADMIN_API_KEY and slows down guessing. */
function createAdminAuth(getAdminKey, now = () => Date.now()) {
  const failures = new Map();

  return (req, res, next) => {
    const key = String(getAdminKey() || "");
    if (key.length < 16) {
      return res.status(503).json({
        success: false,
        code: "ADMIN_DISABLED",
        message: "The admin tools are switched off. Set ADMIN_API_KEY (16 or more characters) in the backend .env.",
      });
    }

    const time = now();
    let entry = failures.get(req.ip);
    if (!entry || entry.resetAt <= time) entry = { count: 0, resetAt: time + FAIL_WINDOW_MS };
    if (entry.count >= FAIL_LIMIT) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - time) / 1000)));
      return res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Too many wrong keys. Try again later." });
    }

    if (!crypto.timingSafeEqual(sha(req.get("x-admin-key") || ""), sha(key))) {
      entry.count += 1;
      failures.set(req.ip, entry);
      return res.status(401).json({ success: false, code: "UNAUTHORIZED", message: "Wrong admin key." });
    }
    failures.delete(req.ip);
    return next();
  };
}

/** Admin page (/admin) and its API (/api/admin/...). Mount it BEFORE the app's small JSON body limit. */
function createAdminRouter({ qr, getAdminKey }) {
  const router = express.Router();

  const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });
  const handle = (action) => async (req, res, next) => {
    try {
      return await action(req, res);
    } catch (err) {
      if (err instanceof AdminError) return fail(res, err.status, err.code, err.message);
      return next(err);
    }
  };

  // The page itself has no data in it: it asks for the key and then calls the API below.
  router.get("/admin", (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    res.type("html").send(fs.readFileSync(PAGE, "utf8"));
  });

  router.use("/api/admin", express.json({ limit: "300kb" }), createAdminAuth(getAdminKey));

  // POST /api/admin/products
  //   { products: [{ serialNumber, productName }] }
  //   or a range: { prefix: "TEST", start: 1036, count: 50, digits: 0, productName: "Papaya Red Lady" }
  router.post(
    "/api/admin/products",
    handle(async (req, res) => {
      const body = req.body || {};
      let items = [];

      if (Array.isArray(body.products)) {
        items = body.products;
      } else if (body.prefix !== undefined) {
        const start = parseInt(body.start, 10);
        const count = parseInt(body.count, 10);
        const digits = Math.min(Math.max(parseInt(body.digits, 10) || 0, 0), 12);
        if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1 || count > 1000) {
          throw new AdminError(400, "INVALID_RANGE", "Start must be 0 or more and count must be between 1 and 1000.");
        }
        for (let i = 0; i < count; i += 1) {
          items.push({
            serialNumber: `${String(body.prefix).trim()}${String(start + i).padStart(digits, "0")}`,
            productName: body.productName,
          });
        }
      } else {
        throw new AdminError(400, "INVALID_BODY", "Send a list of products or a prefix / start / count range.");
      }

      const result = await qr.createProducts(items);
      return res.status(201).json({ success: true, ...result });
    })
  );

  // GET /api/admin/qr-links?prefix=TEST&unregistered=1&limit=60
  router.get(
    "/api/admin/qr-links",
    handle(async (req, res) => {
      const result = await qr.listLinks({
        prefix: req.query.prefix,
        unregisteredOnly: req.query.unregistered === "1" || req.query.unregistered === "true",
        limit: req.query.limit,
      });
      return res.json({ success: true, ...result });
    })
  );

  // GET /api/admin/qr/TEST1036.png?size=1000   (or .svg)
  router.get(
    "/api/admin/qr/:file",
    handle(async (req, res) => {
      const match = /^([A-Za-z0-9_-]+)\.(png|svg)$/.exec(req.params.file || "");
      if (!match) throw new AdminError(400, "INVALID_FILE", "Use /api/admin/qr/<serial>.png or .svg");
      const image = await qr.image(match[1], match[2], req.query.size);
      res.set({ "Content-Type": image.contentType, "Cache-Control": "no-store" });
      return res.send(image.body);
    })
  );

  return router;
}

module.exports = { createAdminRouter, createAdminAuth };