const test = require("node:test");
const assert = require("node:assert/strict");
const { createMailer } = require("../src/services/mailer");

function mailer() {
  const sent = [];
  const m = createMailer({
    user: "shop@gmail.com",
    feedbackTo: "company@x.com",
    incidentTo: "company@x.com",
    transport: { sendMail: async (o) => sent.push(o) },
  });
  return { m, sent };
}

test("welcome email: subject, first name, button, footer and embedded images", async () => {
  const { m, sent } = mailer();
  await m.sendWelcomeEmail({ to: "c@x.com", customerName: "Satish Korishetti" });
  const mail = sent[0];
  assert.equal(mail.to, "c@x.com");
  assert.equal(mail.subject, "Welcome to Known-You Seeds (India) Pvt. Ltd.");
  assert.match(mail.html, /<b>Dear Satish,<\/b>/);
  assert.match(mail.html, /Access Your Account/);
  assert.match(mail.html, /Your account has been successfully set up/);
  assert.match(mail.html, /S\. No\. 87, Pimple-Jagtap Road/);
  assert.match(mail.html, /8379992087/);
  assert.match(mail.html, /Powered by/);
  assert.deepEqual(mail.attachments.map((a) => a.cid), ["ky-logo", "ky-dyrect"]);
  assert.match(mail.from, /Known-You Seed/);
});

test("feedback confirmation email matches the real app wording", async () => {
  const { m, sent } = mailer();
  await m.sendAcknowledgementEmail({ to: "c@x.com", kind: "feedback", customerName: "Satish", productName: "Papaya Red Lady", incidentNumber: "INC0000798" });
  const mail = sent[0];
  assert.equal(mail.subject, "Feedback received for Papaya Red Lady");
  assert.match(mail.html, /Hi Satish,/);
  assert.match(mail.html, /Please note the incident number for reference : INC0000798/);
  assert.match(mail.html, /Known-You Seeds \(India\) Pvt\. Ltd\. Support Team/);
  assert.match(mail.html, /pankaj@knownyou\.com/);
  assert.match(mail.text, /INC0000798/);
});

test("support confirmation email has its own subject", async () => {
  const { m, sent } = mailer();
  await m.sendAcknowledgementEmail({ to: "c@x.com", kind: "incident", customerName: "Satish", productName: "Muskmelon - Bobby", incidentNumber: "INC0000796" });
  assert.equal(sent[0].subject, "Support incident received for Muskmelon - Bobby");
  assert.match(sent[0].html, /INC0000796/);
});

test("customer names cannot inject HTML into emails", async () => {
  const { m, sent } = mailer();
  await m.sendWelcomeEmail({ to: "c@x.com", customerName: "<script>alert(1)</script>" });
  assert.doesNotMatch(sent[0].html, /<script>/);
});

test("company notification mentions the incident number", async () => {
  const { m, sent } = mailer();
  await m.sendFeedbackEmail({ customerName: "S", email: "c@x.com", phone: "9876543210", serialNumber: "PRI1", productName: "P", message: "hi", incidentNumber: "INC0000005" });
  assert.match(sent[0].subject, /INC0000005/);
  assert.match(sent[0].html, /Incident No\./);
});