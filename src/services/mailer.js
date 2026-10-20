const dns = require("dns");
const nodemailer = require("nodemailer");
const { escapeHtml } = require("../utils/validate");
const { createHttpMailTransport } = require("./httpMailTransport");

// Cloud servers often have no working IPv6 route; connecting to Gmail over IPv6 then fails with ENETUNREACH
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* very old Node version */
}

const { welcomeEmail, acknowledgementEmail, DEFAULT_COMPANY } = require("./emailTemplates");

const BRAND = "Known-You Seed";

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:30px auto;background:#ffffff;padding:30px;border-radius:10px;">
    ${bodyHtml}
  </div>
</body></html>`;
}

function detailsTable(rows) {
  const tr = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#555;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;color:#111;font-weight:bold;">${escapeHtml(value || "-")}</td></tr>`
    )
    .join("");
  return `<table style="border-collapse:collapse;font-size:15px;">${tr}</table>`;
}

/**
 * Gmail SMTP that always connects over IPv4. Some servers have no IPv6 route and fail with
 * "connect ENETUNREACH 2607:f8b0:..." when the name resolves to an IPv6 address.
 * (A host that blocks SMTP altogether - Render, Railway ... - still needs RESEND_API_KEY / BREVO_API_KEY.)
 */
function createGmailTransport({ user, appPassword }) {
  const HOST = "smtp.gmail.com";
  let cached = null;

  const make = (host, extra = {}) =>
    nodemailer.createTransport({
      host,
      port: 465,
      secure: true,
      auth: { user, pass: appPassword },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 30000,
      ...extra,
    });

  async function transporter() {
    if (cached && cached.expires > Date.now()) return cached.value;
    let value;
    try {
      const [ip] = await dns.promises.resolve4(HOST);
      value = make(ip, { tls: { servername: HOST } }); // connect to the IPv4 address, check the certificate for the name
    } catch {
      value = make(HOST);
    }
    cached = { value, expires: Date.now() + 10 * 60 * 1000 };
    return value;
  }

  return { sendMail: async (message) => (await transporter()).sendMail(message) };
}

/**
 * How the emails are sent (first one that is configured wins):
 *  1. RESEND_API_KEY -> Resend over HTTPS      (works on every host)
 *  2. BREVO_API_KEY  -> Brevo over HTTPS       (works on every host)
 *  3. otherwise      -> Gmail SMTP with EMAIL_USER + EMAIL_APP_PASSWORD (blocked by some hosts)
 * For 1 and 2 set EMAIL_FROM to a sender address that is verified in that service.
 */
function pickTransport({ user, appPassword }) {
  const resendKey = String(process.env.RESEND_API_KEY || "").trim();
  const brevoKey = String(process.env.BREVO_API_KEY || "").trim();
  if (resendKey) return { name: "Resend (HTTPS)", http: true, transport: createHttpMailTransport("resend", resendKey) };
  if (brevoKey) return { name: "Brevo (HTTPS)", http: true, transport: createHttpMailTransport("brevo", brevoKey) };
  return {
    name: "Gmail SMTP",
    http: false,
    transport: createGmailTransport({ user, appPassword }),
  };
}

const NETWORK_ERRORS = /ETIMEDOUT|ECONNECTION|ESOCKET|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|Connection timeout/i;

function createMailer({ user, appPassword, feedbackTo, incidentTo, transport, company = {} }) {
  const companyInfo = { ...DEFAULT_COMPANY, ...Object.fromEntries(Object.entries(company).filter(([, v]) => v)) };
  const picked = transport ? { name: "custom transport", http: false, transport } : pickTransport({ user, appPassword });
  const transporter = picked.transport;
  if (!transport) {
    console.log(`Email: sending through ${picked.name}`);
    if (!picked.http && process.env.RENDER) {
      console.warn(
        "WARNING: this server runs on Render, which blocks outgoing SMTP (Gmail), so emails will NOT be sent. " +
          "Add BREVO_API_KEY (or RESEND_API_KEY) and EMAIL_FROM in Render > Environment and redeploy."
      );
    }
  }

  // The address shown in "From". Gmail always uses the logged-in account; Resend / Brevo need a verified sender.
  const fromAddress = () => String(process.env.EMAIL_FROM || user || "").trim();

  function ensureConfigured() {
    if (transport) return;
    if (picked.http) {
      if (!fromAddress()) {
        throw new Error("EMAIL_FROM is not configured (use a sender address that is verified in your email service)");
      }
      return;
    }
    if (!user || !appPassword) {
      throw new Error("EMAIL_USER / EMAIL_APP_PASSWORD are not configured");
    }
  }

  async function send(options) {
    ensureConfigured();
    try {
      return await transporter.sendMail({ from: `"${BRAND}" <${fromAddress()}>`, ...options });
    } catch (err) {
      console.error(`Email to ${options.to} failed through ${picked.name} (${err.code || "error"}): ${err.message}`);
      if (!picked.http && NETWORK_ERRORS.test(`${err.code || ""} ${err.message}`)) {
        console.error(
          "Hint: this server cannot reach Gmail. Many hosting services (Render, Railway, DigitalOcean ...) block SMTP. " +
            "Set RESEND_API_KEY (or BREVO_API_KEY) and EMAIL_FROM in the server environment to send over HTTPS instead."
        );
      }
      throw err;
    }
  }

  /** 1) Welcome email to the customer right after registration. */
  async function sendWelcomeEmail({ to, customerName }) {
    return send({ to, ...welcomeEmail({ customerName, company: companyInfo }) });
  }

  /** 2) / 3) "We received your request" email for the feedback and support forms. */
  async function sendAcknowledgementEmail({ to, kind, customerName, productName, incidentNumber }) {
    return send({
      to,
      ...acknowledgementEmail({ kind, customerName, productName, incidentNumber, company: companyInfo }),
    });
  }

  function customerRows({ customerName, email, phone, serialNumber, productName, incidentNumber }) {
    return [
      ...(incidentNumber ? [["Incident No.", incidentNumber]] : []),
      ["Name", customerName],
      ["Email", email],
      ["Mobile", phone],
      ["Product", productName],
      ["Serial No.", serialNumber],
    ];
  }

  /** Feedback goes to the configured company mailbox; Reply goes straight to the customer. */
  async function sendFeedbackEmail(data) {
    if (!feedbackTo) throw new Error("FEEDBACK_TO_EMAIL is not configured");
    return send({
      to: feedbackTo,
      replyTo: data.email || undefined,
      subject: `New customer feedback ${data.incidentNumber ? data.incidentNumber + " - " : "- "}${data.serialNumber}`,
      text:
        `New feedback received\n\nName: ${data.customerName}\nEmail: ${data.email || "-"}\n` +
        `Mobile: ${data.phone}\nProduct: ${data.productName || "-"}\nSerial No.: ${data.serialNumber}\n\n` +
        `Message:\n${data.message}`,
      html: layout(
        "New customer feedback",
        `<p style="margin:0 0 20px 0;font-size:18px;font-weight:bold;">New customer feedback</p>
         ${detailsTable(customerRows(data))}
         <p style="margin:20px 0 6px 0;font-size:15px;color:#555;">Message</p>
         <div style="font-size:16px;line-height:1.6;white-space:pre-wrap;background:#f8f9fa;padding:14px;border-radius:8px;">${escapeHtml(data.message)}</div>`
      ),
    });
  }

  async function sendIncidentEmail(data) {
    if (!incidentTo) throw new Error("INCIDENT_TO_EMAIL / FEEDBACK_TO_EMAIL is not configured");
    return send({
      to: incidentTo,
      replyTo: data.email || undefined,
      subject: `INCIDENT REPORT ${data.incidentNumber ? data.incidentNumber + " - " : "- "}${data.serialNumber}`,
      text:
        `New incident reported\n\nName: ${data.customerName}\nEmail: ${data.email || "-"}\n` +
        `Mobile: ${data.phone}\nProduct: ${data.productName || "-"}\nSerial No.: ${data.serialNumber}\n\n` +
        `Incident details:\n${data.message}`,
      html: layout(
        "Incident report",
        `<p style="margin:0 0 20px 0;font-size:18px;font-weight:bold;color:#b00020;">Incident report</p>
         ${detailsTable(customerRows(data))}
         <p style="margin:20px 0 6px 0;font-size:15px;color:#555;">Incident details</p>
         <div style="font-size:16px;line-height:1.6;white-space:pre-wrap;background:#fff5f5;padding:14px;border-radius:8px;">${escapeHtml(data.message)}</div>`
      ),
    });
  }

  return { sendWelcomeEmail, sendAcknowledgementEmail, sendFeedbackEmail, sendIncidentEmail };
}

module.exports = { createMailer };