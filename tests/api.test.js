const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createMailer } = require("../src/services/mailer");

// ---- minimal in-memory Firestore fake ------------------------------------
function fakeDb(seed = {}) {
  const store = { qr_codes: { ...seed }, feedback: {}, incidents: {}, counters: {} };
  let n = 0;
  const docRef = (col, id) => ({
    id,
    async get() {
      const d = store[col][id];
      return { exists: d !== undefined, data: () => ({ ...d }) };
    },
    async update(patch) {
      store[col][id] = { ...store[col][id], ...patch };
    },
    async set(data) {
      store[col][id] = { ...data };
    },
  });
  return {
    store,
    collection: (col) => ({
      doc: (id) => docRef(col, id),
      where(field, op, value) {
        const filters = [[field, value]];
        const query = {
          where(f, o, v) { filters.push([f, v]); return query; },
          limit() { return query; },
          async get() {
            const docs = Object.entries(store[col])
              .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
              .map(([id, d]) => ({ id, data: () => ({ ...d }) }));
            return { docs };
          },
        };
        return query;
      },
      async add(data) {
        const id = `auto${++n}`;
        store[col][id] = { ...data };
        return docRef(col, id);
      },
    }),
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        update: (ref, patch) => ref.update(patch),
        set: (ref, data) => ref.set(data),
      });
    },
  };
}

function setup({ smsFails = false, mailFails = false } = {}) {
  const calls = { sms: [], reg: [], fb: [], inc: [], ack: [] };
  const db = fakeDb({
    PRI0132111: { serialNumber: "PRI0132111", productName: "Papaya Red Lady", isRegistered: false, status: "unused" },
    PRI0132222: {
      serialNumber: "PRI0132222", productName: "Papaya Red Lady", isRegistered: true,
      customerName: "Secret Person", email: "secret@x.com", phone: "9000000000", registeredAt: new Date("2026-09-06"),
    },
  });
  const sms = {
    sendRegistrationSms: async (p) => { calls.sms.push(p); if (smsFails) throw new Error("sms down"); return { return: true }; },
  };
  const mailer = {
    sendWelcomeEmail: async (d) => { calls.reg.push(d); if (mailFails) throw new Error("smtp down"); },
    sendAcknowledgementEmail: async (d) => { calls.ack.push(d); if (mailFails) throw new Error("smtp down"); },
    sendFeedbackEmail: async (d) => { calls.fb.push(d); if (mailFails) throw new Error("smtp down"); },
    sendIncidentEmail: async (d) => { calls.inc.push(d); if (mailFails) throw new Error("smtp down"); },
  };
  const app = createApp({ db, sms, mailer });
  return { app, db, calls };
}

async function call(app, method, path, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

const customer = { serialNumber: "pri0132111", name: " Satish ", email: "Sat@Example.com", phone: "+91 98765 43210", agreedToPolicy: true };

test("verify: unknown serial is rejected", async () => {
  const { app } = setup();
  const r = await call(app, "GET", "/api/products/PRI9999999");
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "SERIAL_NOT_FOUND");
});

test("verify: malformed serial is rejected", async () => {
  const { app } = setup();
  const r = await call(app, "GET", "/api/products/a%2Fb");
  assert.equal(r.status, 400);
});

test("verify: unused serial can be registered", async () => {
  const { app } = setup();
  const r = await call(app, "GET", "/api/products/PRI0132111");
  assert.equal(r.status, 200);
  assert.equal(r.json.canRegister, true);
  assert.equal(r.json.product.productName, "Papaya Red Lady");
});

test("verify: registered serial reports already registered and leaks no customer data", async () => {
  const { app } = setup();
  const r = await call(app, "GET", "/api/products/PRI0132222");
  assert.equal(r.status, 200);
  assert.equal(r.json.canRegister, false);
  assert.equal(r.json.message, "This product is already registered.");
  assert.doesNotMatch(JSON.stringify(r.json), /Secret Person|secret@x\.com|9000000000/);
});

test("register: success saves data and sends SMS + email", async () => {
  const { app, db, calls } = setup();
  const r = await call(app, "POST", "/api/register", customer);
  assert.equal(r.status, 201);
  assert.equal(r.json.notifications.sms.queued, true);
  assert.equal(r.json.notifications.email.queued, true);
  assert.deepEqual(calls.sms, ["9876543210"]);
  assert.equal(calls.reg[0].to, "sat@example.com");
  const saved = db.store.qr_codes.PRI0132111;
  assert.equal(saved.isRegistered, true);
  assert.equal(saved.customerName, "Satish");
  assert.equal(saved.phone, "9876543210");
});

test("register: second attempt gets 409 already registered", async () => {
  const { app } = setup();
  await call(app, "POST", "/api/register", customer);
  const r = await call(app, "POST", "/api/register", customer);
  assert.equal(r.status, 409);
  assert.equal(r.json.message, "This product is already registered.");
});

test("register: unknown serial is blocked", async () => {
  const { app } = setup();
  const r = await call(app, "POST", "/api/register", { ...customer, serialNumber: "PRI9999999" });
  assert.equal(r.status, 404);
});

test("register: validation errors", async () => {
  const { app } = setup();
  assert.equal((await call(app, "POST", "/api/register", { ...customer, name: "" })).json.code, "NAME_REQUIRED");
  assert.equal((await call(app, "POST", "/api/register", { ...customer, phone: "123" })).json.code, "INVALID_PHONE");
  assert.equal((await call(app, "POST", "/api/register", { ...customer, email: "nope" })).json.code, "INVALID_EMAIL");
});

test("register: still succeeds when SMS and email providers fail", async () => {
  const { app, db } = setup({ smsFails: true, mailFails: true });
  const r = await call(app, "POST", "/api/register", customer);
  assert.equal(r.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 50)); // background notifications finish
  assert.equal(db.store.qr_codes.PRI0132111.notifications.sms.sent, false);
  assert.equal(db.store.qr_codes.PRI0132111.notifications.email.sent, false);
  assert.equal(db.store.qr_codes.PRI0132111.isRegistered, true);
});

test("register: replies immediately even when SMS/email providers are very slow", async () => {
  const { db } = setup();
  const never = () => new Promise(() => {});
  const app = createApp({
    db,
    sms: { sendRegistrationSms: never },
    mailer: { sendWelcomeEmail: never, sendAcknowledgementEmail: never, sendFeedbackEmail: never, sendIncidentEmail: never },
  });
  const started = Date.now();
  const r = await call(app, "POST", "/api/register", customer);
  assert.equal(r.status, 201);
  assert.ok(Date.now() - started < 1000);
});

test("register: email is optional", async () => {
  const { app, calls } = setup();
  const r = await call(app, "POST", "/api/register", { ...customer, email: "" });
  assert.equal(r.status, 201);
  assert.equal(r.json.notifications.email.skipped, true);
  assert.equal(calls.reg.length, 0);
  assert.equal(calls.sms.length, 1);
});

test("feedback: needs a registered product", async () => {
  const { app } = setup();
  const r = await call(app, "POST", "/api/feedback", { ...customer, message: "good" });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "NOT_REGISTERED");
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50)); // let background emails finish

test("feedback and incident: saved, numbered INC0000001/2, company + customer emails sent", async () => {
  const { app, db, calls } = setup();
  await call(app, "POST", "/api/register", customer);

  const fb = await call(app, "POST", "/api/feedback", { ...customer, message: "Great seeds" });
  assert.equal(fb.status, 201);
  assert.equal(fb.json.incidentNumber, "INC0000001");

  const inc = await call(app, "POST", "/api/incidents", { ...customer, message: "Packet was torn" });
  assert.equal(inc.status, 201);
  assert.equal(inc.json.incidentNumber, "INC0000002"); // one shared counter
  await tick();

  assert.equal(calls.fb[0].message, "Great seeds");
  assert.equal(calls.fb[0].incidentNumber, "INC0000001");
  assert.equal(calls.inc[0].serialNumber, "PRI0132111");
  assert.equal(Object.keys(db.store.feedback).length, 1);
  assert.equal(Object.keys(db.store.incidents).length, 1);

  // customer confirmation emails (feedback + support wording)
  assert.deepEqual(calls.ack.map((a) => a.kind), ["feedback", "incident"]);
  assert.equal(calls.ack[0].to, "sat@example.com");
  assert.equal(calls.ack[1].incidentNumber, "INC0000002");
  assert.equal(calls.ack[0].productName, "Papaya Red Lady");
  assert.equal(db.store.counters.incidents.value, 2);
});

test("feedback: no customer confirmation when no email was entered, company still gets it", async () => {
  const { app, calls } = setup();
  await call(app, "POST", "/api/register", { ...customer, email: "" });
  const r = await call(app, "POST", "/api/feedback", { ...customer, email: "", message: "hello" });
  assert.equal(r.status, 201);
  await tick();
  assert.equal(calls.ack.length, 0);
  assert.equal(calls.fb.length, 1);
});

test("feedback: message is kept and customer gets an instant reply even if the mail server is down", async () => {
  const { app } = setup();
  await call(app, "POST", "/api/register", customer);
  const down = setup({ mailFails: true });
  down.db.store.qr_codes.PRI0132111 = { ...down.db.store.qr_codes.PRI0132111, isRegistered: true };
  const r = await call(down.app, "POST", "/api/feedback", { ...customer, message: "hello" });
  assert.equal(r.status, 201);
  await tick();
  const saved = Object.values(down.db.store.feedback)[0];
  assert.equal(saved.message, "hello");
  assert.equal(saved.emailSent, false);
  assert.equal(saved.customerEmailSent, false);
});

test("feedback: empty message rejected", async () => {
  const { app } = setup();
  const r = await call(app, "POST", "/api/feedback", { ...customer, message: "  " });
  assert.equal(r.json.code, "MESSAGE_REQUIRED");
});

test("customer products: lists everything registered with the phone number", async () => {
  const { app } = setup();
  await call(app, "POST", "/api/register", customer); // 9876543210 registers PRI0132111
  const r = await call(app, "POST", "/api/customers/products", { phone: "+91 98765 43210" });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.products[0].serialNumber, "PRI0132111");
  assert.equal(r.json.products[0].productName, "Papaya Red Lady");
});

test("customer products: another phone number sees nothing and no personal data leaks", async () => {
  const { app } = setup();
  await call(app, "POST", "/api/register", customer);
  const other = await call(app, "POST", "/api/customers/products", { phone: "9000000001" });
  assert.equal(other.json.count, 0);
  const mine = await call(app, "POST", "/api/customers/products", { phone: "9876543210" });
  assert.doesNotMatch(JSON.stringify(mine.json), /Satish|sat@example\.com/i);
});

test("customer products: invalid phone is rejected", async () => {
  const { app } = setup();
  const r = await call(app, "POST", "/api/customers/products", { phone: "123" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "INVALID_PHONE");
});

test("feedback and support still work when FEEDBACK_TO_EMAIL / INCIDENT_TO_EMAIL are not configured", async () => {
  const sent = [];
  const mailer = createMailer({
    user: "shop@gmail.com",
    appPassword: "x",
    feedbackTo: undefined,
    incidentTo: undefined,
    transport: { sendMail: async (o) => sent.push(o) },
  });
  const { db } = setup();
  const app = createApp({ db, sms: { sendRegistrationSms: async () => {} }, mailer });
  await call(app, "POST", "/api/register", customer);

  const fb = await call(app, "POST", "/api/feedback", { ...customer, message: "hello" });
  assert.equal(fb.status, 201);
  const inc = await call(app, "POST", "/api/incidents", { ...customer, message: "torn packet" });
  assert.equal(inc.status, 201);
  await tick();

  // the customer still receives both confirmation emails; only the company copy is skipped
  const subjects = sent.map((m) => m.subject);
  assert.ok(subjects.includes("Feedback received for Papaya Red Lady"));
  assert.ok(subjects.includes("Support incident received for Papaya Red Lady"));
  const saved = Object.values(db.store.feedback)[0];
  assert.equal(saved.emailSent, false);
  assert.match(saved.emailError, /FEEDBACK_TO_EMAIL is not configured/);
  assert.equal(saved.customerEmailSent, true);
});