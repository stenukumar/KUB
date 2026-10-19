const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

/**
 * Initialises Firebase Admin once and returns the Firestore instance.
 * Credentials come from env variables (hosting) or a local JSON file (development).
 */
function getDb(firebaseConfig) {
  if (getApps().length === 0) {
    const { projectId, clientEmail, privateKey, serviceAccountPath } = firebaseConfig;

    if (projectId && clientEmail && privateKey) {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      });
    } else if (serviceAccountPath) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const serviceAccount = require(path.resolve(serviceAccountPath));
      initializeApp({ credential: cert(serviceAccount) });
    } else {
      throw new Error(
        "Firebase credentials missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and " +
          "FIREBASE_PRIVATE_KEY (or FIREBASE_SERVICE_ACCOUNT_PATH) in your .env file."
      );
    }
  }
  return getFirestore();
}

module.exports = { getDb };
