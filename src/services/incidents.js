const COUNTER_DOC = "counters/incidents";

/**
 * Hands out incident numbers like INC0000796 for feedback and support requests.
 * One shared counter stored in Firestore (collection `counters`, document `incidents`);
 * a transaction guarantees two customers never get the same number.
 * To start from a higher number, edit the field `value` of that document in the Firebase console.
 */
function createIncidentCounter(db) {
  const ref = () => db.collection("counters").doc("incidents");

  async function next() {
    const value = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref());
      const current = snap.exists ? Number(snap.data().value) || 0 : 0;
      const nextValue = current + 1;
      tx.set(ref(), { value: nextValue, updatedAt: new Date() });
      return nextValue;
    });
    return `INC${String(value).padStart(7, "0")}`;
  }

  return { next, COUNTER_DOC };
}

module.exports = { createIncidentCounter };