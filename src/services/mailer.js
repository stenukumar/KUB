const nodemailer = require("nodemailer");
const { escapeHtml } = require("../utils/validate");

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

function createMailer({ user, appPassword, feedbackTo, incidentTo, transport, company = {} }) {
  const companyInfo = { ...DEFAULT_COMPANY, ...Object.fromEntries(Object.entries(company).filter(([, v]) => v)) };
  const transporter =
    transport ||
    nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: appPassword },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });

  function ensureConfigured() {
    if (!transport && (!user || !appPassword)) {
      throw new Error("EMAIL_USER / EMAIL_APP_PASSWORD are not configured");
    }
  }

  async function send(options) {
    ensureConfigured();
    return transporter.sendMail({ from: `"${BRAND}" <${user}>`, ...options });
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