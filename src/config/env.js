require("dotenv").config();

const list = (value) =>
  String(value || "")
    .split(",")
    .map((v) => v.trim().replace(/\/+$/, ""))
    .filter(Boolean);

module.exports = {
  port: Number(process.env.PORT) || 5000,
  allowedOrigins: list(process.env.FRONTEND_URLS),
  // Development: also trust localhost and private-network addresses (192.168.x.x, 10.x.x.x ...).
  // Set ALLOW_LAN_ORIGINS=false (or NODE_ENV=production) to trust only FRONTEND_URLS.
  allowLanOrigins:
    process.env.ALLOW_LAN_ORIGINS !== undefined
      ? process.env.ALLOW_LAN_ORIGINS.toLowerCase() === "true"
      : process.env.NODE_ENV !== "production",
  frontendPublicUrl: (process.env.FRONTEND_PUBLIC_URL || "").replace(/\/+$/, ""),

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  },

  sms: {
    apiKey: process.env.FAST2SMS_API_KEY,
  },

  // Printed in the customer emails. Leave empty to use the defaults from your sample emails.
  company: {
    supportEmail: process.env.SUPPORT_EMAIL,
    supportPhone: process.env.SUPPORT_PHONE,
    accountUrl: process.env.ACCOUNT_URL || (process.env.FRONTEND_PUBLIC_URL ? `${process.env.FRONTEND_PUBLIC_URL.replace(/\/+$/, "")}/welcome` : ""),
  },

  email: {
    user: process.env.EMAIL_USER,
    appPassword: process.env.EMAIL_APP_PASSWORD,
    feedbackTo: process.env.FEEDBACK_TO_EMAIL,
    incidentTo: process.env.INCIDENT_TO_EMAIL || process.env.FEEDBACK_TO_EMAIL,
  },
};