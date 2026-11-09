const { normalizePlate } = require("./plate");
// Shared lock permits concurrent user operations; broadcast mutation takes the exclusive lock.
const ADMIN_GATE_SQL = "SELECT id FROM admin_command_gate WHERE id=1 FOR SHARE";
async function guardAdminIn(c, input) {
  await c.query(ADMIN_GATE_SQL);
  return checkAdminIn(c, input);
}
const ADMIN_POLICY_SQL = `SELECT EXISTS(SELECT 1 FROM banned_plates WHERE license_plate=$1) AS banned,
  EXISTS(SELECT 1 FROM admin_floor_locks l JOIN parking_slots s ON s.floor=l.floor
    WHERE s.slot_code=$2 AND l.locked) AS locked`;
function adminDenial(denied, unlock = false) {
  if (denied.banned) return { code: 403, body: { error: "PLATE_BANNED" } };
  if (denied.locked) return {
    code: 409,
    body: { error: unlock ? "FLOOR_LOCKED" : "SLOT_TAKEN" },
  };
  return null;
}
// Caller must already hold the shared gate in this transaction.
async function checkAdminIn(c, { slotCode, licensePlate, unlock = false }) {
  // Read after acquiring the gate: a broadcast may commit while the lock is waiting.
  const { rows: [denied] } = await c.query(ADMIN_POLICY_SQL,
    [licensePlate ? normalizePlate(licensePlate) : null, slotCode || null]);
  return adminDenial(denied, unlock);
}
module.exports = { guardAdminIn, checkAdminIn, adminDenial, ADMIN_POLICY_SQL, ADMIN_GATE_SQL };
