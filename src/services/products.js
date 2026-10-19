const { toIso } = require("../utils/validate");

const COLLECTION = "qr_codes";

/**
 * Data access for product serial numbers.
 * Collection `qr_codes`, one document per serial number (document id = serial number),
 * the same structure your old backend and bulk-add script already use.
 */
function createProductStore(db) {
  const ref = (serial) => db.collection(COLLECTION).doc(serial);

  /** Public view of a product. Never exposes the customer's personal details. */
  function toPublic(serial, data) {
    return {
      serialNumber: data.serialNumber || serial,
      productName: data.productName || "",
      isRegistered: data.isRegistered === true,
      registeredAt: toIso(data.registeredAt),
    };
  }

  async function find(serial) {
    const snap = await ref(serial).get();
    return snap.exists ? snap.data() : null;
  }

  /** Hash mapping: finds the product that owns this QR hash. Returns { serial, data } or null. */
  async function findByHash(hash) {
    const snap = await db.collection(COLLECTION).where("qrHash", "==", hash).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { serial: doc.id, data: doc.data() };
  }

  /**
   * Atomically registers a product. Using a transaction means two people scanning
   * the same QR at the same moment can never both register it.
   * Returns { status: "registered" | "not_found" | "already_registered", product }.
   */
  async function register(serial, customer) {
    return db.runTransaction(async (tx) => {
      const docRef = ref(serial);
      const snap = await tx.get(docRef);

      if (!snap.exists) return { status: "not_found" };

      const data = snap.data();
      if (data.isRegistered === true) {
        return { status: "already_registered", product: toPublic(serial, data) };
      }

      const registeredAt = new Date();
      tx.update(docRef, {
        customerName: customer.customerName,
        email: customer.email,
        phone: customer.phone,
        isRegistered: true,
        status: "registered",
        registeredAt,
        agreedToPolicy: true,
      });

      return {
        status: "registered",
        product: toPublic(serial, { ...data, isRegistered: true, registeredAt }),
      };
    });
  }

  /**
   * All registered products that belong to a phone number (10 digits), newest first.
   * Only product details are returned - never the customer's own details.
   */
  async function listByPhone(phone) {
    const snap = await db
      .collection(COLLECTION)
      .where("phone", "==", phone)
      .where("isRegistered", "==", true)
      .limit(100)
      .get();

    return snap.docs
      .map((doc) => toPublic(doc.id, doc.data()))
      .sort((a, b) => String(b.registeredAt || "").localeCompare(String(a.registeredAt || "")));
  }

  /** Name and email of the customer who registered a product with this phone number (or null). */
  async function findCustomerByPhone(phone) {
    const snap = await db
      .collection(COLLECTION)
      .where("phone", "==", phone)
      .where("isRegistered", "==", true)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const data = snap.docs[0].data();
    return { name: data.customerName || "", email: data.email || "", phone };
  }

  /** Stores the outcome of the SMS / email so failed notifications can be followed up. */
  async function saveNotificationStatus(serial, notifications) {
    try {
      await ref(serial).update({ notifications });
    } catch (err) {
      console.error("Could not save notification status:", err.message);
    }
  }

  return { find, findByHash, register, listByPhone, findCustomerByPhone, toPublic, saveNotificationStatus };
}

module.exports = { createProductStore, COLLECTION };