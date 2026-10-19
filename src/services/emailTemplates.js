const path = require("path");
const { escapeHtml } = require("../utils/validate");

const ASSETS = path.join(__dirname, "..", "..", "assets", "email");

/** Company details printed in every email (same as the real app). Override with env variables if needed. */
const DEFAULT_COMPANY = {
  name: "Known-You Seeds (India) Pvt. Ltd.",
  address:
    "S. No. 87, Pimple-Jagtap Road, Bhima Koregaon, Tal. Shirur, Dist. Pune. PIN - 412 216. " +
    "Maharashtra., Pune, Maharashtra, 412216",
  supportEmail: "pankaj@knownyou.com",
  supportPhone: "8379992087",
  accountUrl: "http://www.knownyou.co.in",
};

// The real emails are set in Calibri (Windows/Mac Office fonts); Arial is the fallback for other devices
const FONT = "Calibri,Candara,'Segoe UI',Segoe,Optima,Arial,sans-serif";
const LINK = "color:#1155cc;text-decoration:underline;";

/**
 * Logos are shown inside the email body from a public HTTPS address.
 * Nothing is ever sent as an attachment.
 *
 * Easiest setup: copy the two files (known-you-seed-logo.jpg, dyrect-blue.png) from the frontend folder  public/email/  (they ship with
 * the frontend) and set  FRONTEND_PUBLIC_URL=https://your-site.com  in .env. The logos are then
 * read from  https://your-site.com/email/<file>.
 *
 * Other ways (the address must work from the internet, "localhost" does not):
 *   EMAIL_ASSET_BASE_URL=https://cdn.yourdomain.com/folder   -> a folder that holds both files
 *   BACKEND_PUBLIC_URL=https://api.yourdomain.com            -> served by this backend at /email-assets
 *   EMAIL_LOGO_URL / EMAIL_DYRECT_URL                        -> a separate link for each image
 */
const IMAGES = {
  logo: { file: "known-you-seed-logo.jpg", envUrl: "EMAIL_LOGO_URL" },
  dyrect: { file: "dyrect-blue.png", envUrl: "EMAIL_DYRECT_URL" },
};

const clean = (v) => String(v || "").trim().replace(/\/+$/, "");
const isPublicUrl = (url) =>
  /^https:\/\//i.test(url) && !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);

/** Live site of the app; the logos are read from its public/email folder when nothing else is set. */
const DEFAULT_ASSET_FOLDER = "https://knownyou.dyrect.co/email";

/** Folders that may hold the logo files, best match first. */
function assetFolders() {
  return [
    clean(process.env.EMAIL_ASSET_BASE_URL),
    clean(process.env.FRONTEND_PUBLIC_URL) && `${clean(process.env.FRONTEND_PUBLIC_URL)}/email`,
    clean(process.env.BACKEND_PUBLIC_URL) && `${clean(process.env.BACKEND_PUBLIC_URL)}/email-assets`,
    DEFAULT_ASSET_FOLDER,
  ].filter(Boolean);
}

/** Read at send time (not at start-up) so it always sees the values loaded from .env. */
function imageUrl(img) {
  const exact = String(process.env[img.envUrl] || "").trim();
  if (isPublicUrl(exact)) return exact;
  // "localhost" folders are skipped: nobody outside this computer can open them
  const folder = assetFolders().find(isPublicUrl);
  return folder ? `${folder}/${img.file}` : "";
}

/** Always empty: the logos are linked from a public address, never attached. */
function attachments() {
  return [];
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "Customer";

/** Grey page + centered logo + 500px white card + grey company box + "Powered by DYRECT". */
function layout({ title, bodyHtml, company }) {
  const logoUrl = imageUrl(IMAGES.logo);
  const dyrectUrl = imageUrl(IMAGES.dyrect);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f5f5f5" style="background:#f5f5f5;">
<tr><td align="center" style="padding:40px 10px 31px 10px;">

  ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" width="115" height="26" alt="Known-You Seed" style="display:block;border:0;margin:0 auto 17px auto;width:115px;height:auto;">` : `<div style="margin:0 auto 17px auto;font-family:${FONT};font-size:24px;line-height:28px;font-weight:bold;letter-spacing:0.5px;color:#3c3c3c;text-align:center;">Known-You Seed</div>`}

  <table role="presentation" width="500" cellspacing="0" cellpadding="0" border="0" style="width:500px;max-width:100%;">
    <tr><td style="background:#ffffff;padding:13px 20px;font-family:${FONT};font-size:13.6px;line-height:20px;color:#222222;text-align:left;">
${bodyHtml}
    </td></tr>
    <tr><td style="background:#e5e5e5;padding:17px 20px 12px 20px;font-family:${FONT};text-align:left;">
      <div style="font-size:16.5px;line-height:16px;font-weight:bold;color:#525252;">${escapeHtml(company.name)}</div>
      <div style="margin-top:7px;font-size:12.8px;line-height:19px;color:#737373;">${escapeHtml(company.address)}</div>
      <div style="margin-top:6px;font-size:12.8px;line-height:19px;"><a href="mailto:${escapeHtml(company.supportEmail)}" style="${LINK}">${escapeHtml(company.supportEmail)}</a></div>
      <div style="margin-top:8px;font-size:12.8px;line-height:19px;color:#525252;">${escapeHtml(company.supportPhone)}</div>
    </td></tr>
  </table>

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:31px;">
    <tr>
      <td style="font-family:${FONT};font-size:10px;line-height:10px;color:#acacac;padding-right:3px;vertical-align:middle;">Powered by</td>
      ${dyrectUrl ? `<td style="vertical-align:middle;"><img src="${escapeHtml(dyrectUrl)}" width="45" height="8" alt="DYRECT" style="display:block;border:0;width:45px;height:auto;"></td>` : `<td style="vertical-align:middle;"><span style="font-family:${FONT};font-size:10px;font-weight:bold;color:#2536F5;">DYRECT</span></td>`}
    </tr>
  </table>

</td></tr></table>
</body></html>`;
}

/** 1) Welcome email, sent right after a successful registration. */
function welcomeEmail({ customerName, company = DEFAULT_COMPANY }) {
  const name = escapeHtml(firstName(customerName));
  const url = escapeHtml(company.accountUrl);
  const bodyHtml = `      <b>Dear ${name},</b><br><br>
      Welcome to the <b>${escapeHtml(company.name)}</b> family, and thank you for choosing us! We're excited to have you on board.<br><br>
      Your account has been successfully set up. To get started, you can access your account and all related information by clicking the button below:<br><br>
      <a href="${url}" style="${LINK}font-weight:bold;">Access Your Account</a><br><br>
      If you have any questions or need assistance, please feel free to reach out to our support team.<br><br>
      We look forward to supporting your success!`;

  const text =
    `Dear ${firstName(customerName)},\n\n` +
    `Welcome to the ${company.name} family, and thank you for choosing us! We're excited to have you on board.\n\n` +
    `Your account has been successfully set up. To get started, you can access your account and all related information here:\n` +
    `${company.accountUrl}\n\n` +
    `If you have any questions or need assistance, please feel free to reach out to our support team.\n\n` +
    `We look forward to supporting your success!\n\n` +
    `${company.name}\n${company.address}\n${company.supportEmail}\n${company.supportPhone}`;

  return {
    subject: `Welcome to ${company.name}`,
    text,
    html: layout({ title: "Welcome", bodyHtml, company }),
    attachments: attachments(),
  };
}

/** 2) + 3) "We received your request" email for feedback and support (incident) forms. */
function acknowledgementEmail({ kind, customerName, productName, incidentNumber, company = DEFAULT_COMPANY }) {
  const name = escapeHtml(firstName(customerName));
  const mail = escapeHtml(company.supportEmail);
  const bodyHtml = `      Hi ${name},<br>
      Thank you for your request. We are going through the information that you have submitted and one of our representative will soon contact you. Please note the incident number for reference : ${escapeHtml(incidentNumber)}<br><br>
      If you need any urgent information or assistance, please feel free to call us on:<br>
      ${escapeHtml(company.supportPhone)}<br>
      Or email us on: <a href="mailto:${mail}" style="${LINK}">${mail}</a><br><br>
      Sincerely,<br>
      ${escapeHtml(company.name)} Support Team<br>
      <a href="mailto:${mail}" style="${LINK}">${mail}</a>`;

  const text =
    `Hi ${firstName(customerName)},\n` +
    `Thank you for your request. We are going through the information that you have submitted and one of our representative will soon contact you. Please note the incident number for reference : ${incidentNumber}\n\n` +
    `If you need any urgent information or assistance, please feel free to call us on:\n${company.supportPhone}\n` +
    `Or email us on: ${company.supportEmail}\n\n` +
    `Sincerely,\n${company.name} Support Team\n${company.supportEmail}\n\n` +
    `${company.name}\n${company.address}\n${company.supportEmail}\n${company.supportPhone}`;

  const label = kind === "feedback" ? "Feedback received for" : "Support incident received for";
  return {
    subject: `${label} ${productName || "your product"}`,
    text,
    html: layout({ title: label, bodyHtml, company }),
    attachments: attachments(),
  };
}

module.exports = { welcomeEmail, acknowledgementEmail, DEFAULT_COMPANY, firstName };