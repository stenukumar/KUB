const config = require("./src/config/env");
const { getDb } = require("./src/config/firebase");
const { createSmsService } = require("./src/services/sms");
const { createMailer } = require("./src/services/mailer");
const { createApp } = require("./src/app");

const db = getDb(config.firebase);
const sms = createSmsService({ apiKey: config.sms.apiKey });
const mailer = createMailer({
  user: config.email.user,
  appPassword: config.email.appPassword,
  feedbackTo: config.email.feedbackTo,
  incidentTo: config.email.incidentTo,
  company: config.company,
});

if (config.allowedOrigins.length === 0) {
  console.warn("FRONTEND_URLS is empty: CORS allows every origin. Set it before going live.");
} else if (config.allowLanOrigins) {
  console.log("CORS: also allowing localhost and private-network addresses (development).");
}

process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

const app = createApp({ db, sms, mailer, allowedOrigins: config.allowedOrigins, allowLanOrigins: config.allowLanOrigins, logRequests: true });

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Server live on port ${config.port}`);
});