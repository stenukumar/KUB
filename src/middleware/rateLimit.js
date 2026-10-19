/**
 * Small in-memory rate limiter (no extra dependency).
 * Good enough for a single server instance. If you run several instances,
 * replace it with a shared store (e.g. express-rate-limit + Redis).
 */
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({
        success: false,
        code: "RATE_LIMITED",
        message: message || "Too many requests. Please try again later.",
      });
    }
    return next();
  };
}

module.exports = { rateLimit };