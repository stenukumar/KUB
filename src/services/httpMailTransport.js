/**
 * Sends email through a provider's HTTPS API (port 443) instead of SMTP.
 *
 * Many hosting services (Render, Railway, DigitalOcean ...) block the SMTP ports 25 / 465 / 587, so
 * Gmail works on your own computer but every email times out on the deployed server. HTTPS is never blocked.
 *
 * It has the same sendMail() shape as a nodemailer transport, so mailer.js can use it without any other change.
 * Supported: Resend (RESEND_API_KEY) and Brevo (BREVO_API_KEY).
 */
const REQUEST_TIMEOUT_MS = 20000;

/** '"Known-You Seed" <support@site.com>'  ->  { name, email } */
function parseAddress(value) {
  const text = String(value || "").trim();
  const match = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(text);
  return match ? { name: match[1].trim(), email: match[2].trim() } : { name: "", email: text };
}

const list = (value) =>
  (Array.isArray(value) ? value : String(value || "").split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);

const PROVIDERS = {
  resend: {
    label: "Resend",
    url: "https://api.resend.com/emails",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: (msg) => {
      const sender = parseAddress(msg.from);
      return {
        from: sender.name ? `${sender.name} <${sender.email}>` : sender.email,
        to: list(msg.to),
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      };
    },
  },
  brevo: {
    label: "Brevo",
    url: "https://api.brevo.com/v3/smtp/email",
    headers: (key) => ({ "api-key": key, accept: "application/json" }),
    body: (msg) => {
      const sender = parseAddress(msg.from);
      return {
        sender: { ...(sender.name ? { name: sender.name } : {}), email: sender.email },
        to: list(msg.to).map((email) => ({ email })),
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
        ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}),
      };
    },
  },
};

function createHttpMailTransport(provider, apiKey, fetchImpl = (...args) => fetch(...args)) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown email provider "${provider}"`);

  return {
    async sendMail(msg) {
      const response = await fetchImpl(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...config.headers(apiKey) },
        body: JSON.stringify(config.body(msg)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const raw = await response.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        /* not JSON */
      }
      if (!response.ok) {
        const reason = data.message || data.error || raw.slice(0, 200) || response.statusText;
        const err = new Error(`${config.label} rejected the email (HTTP ${response.status}): ${reason}`);
        err.code = `HTTP_${response.status}`;
        throw err;
      }
      return { messageId: data.id || data.messageId || "", provider: config.label };
    },
  };
}

module.exports = { createHttpMailTransport, parseAddress };