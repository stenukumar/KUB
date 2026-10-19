const axios = require("axios");
const { normalizePhone } = require("../utils/validate");

const FAST2SMS_API_URL = "https://www.fast2sms.com/dev/bulkV2";

// Same text as your old backend.
const REGISTRATION_SMS =
  "Congratulations!\n" +
  "This is an original known-You Seed product. " +
  "For more products info. visit http://www.knownyou.co.in";

function createSmsService({ apiKey, http = axios }) {
  async function send(phone, message) {
    const number = normalizePhone(phone);
    if (!number) throw new Error("Invalid Indian mobile number");
    if (!apiKey) throw new Error("FAST2SMS_API_KEY is not configured");

    const response = await http.post(
      FAST2SMS_API_URL,
      { route: "q", message, numbers: number, sms_details: "1" },
      {
        headers: { authorization: apiKey, "Content-Type": "application/json" },
        timeout: 10000,
      }
    );

    if (response.data && response.data.return === false) {
      const reason = Array.isArray(response.data.message)
        ? response.data.message.join(", ")
        : response.data.message;
      throw new Error(reason || "Fast2SMS rejected the SMS request");
    }
    return response.data;
  }

  return {
    isConfigured: Boolean(apiKey),
    sendRegistrationSms: (phone) => send(phone, REGISTRATION_SMS),
    sendOtpSms: (phone, code) =>
      send(phone, `${code} is your verification code for Known-You Seed. It is valid for 5 minutes. Do not share it with anyone.`),
  };
}

module.exports = { createSmsService, REGISTRATION_SMS };