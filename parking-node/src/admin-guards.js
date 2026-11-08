const { normalizePlate } = require("./plate");
// Shared lock permits concurrent user operations; broadcast mutation takes the exclusive lock.
async function guardAdminIn(c, { slotCode, licensePlate, unlock = false }) {
  await c.query("SELECT id FROM admin_command_gate WHERE id=1 FOR SHARE");
  // Read after acquiring the gate: a broadcast may commit while the lock is waiting.
  const { rows: [denied] } = await c.query(
    `SELECT EXISTS(SELECT 1 FROM banned_plates WHERE license_plate=$1) AS banned,
      EXISTS(SELECT 1 FROM admin_floor_locks l JOIN parking_slots s ON s.floor=l.floor
        WHERE s.slot_code=$2 AND l.locked) AS locked`,
    [licensePlate ? normalizePlate(licensePlate) : null, slotCode || null],
  );
  if (denied.banned) return { code: 403, body: { error: "PLATE_BANNED" } };
  if (denied.locked) return {
    code: 409,
    body: { error: unlock ? "FLOOR_LOCKED" : "SLOT_TAKEN" },
  };
  return null;
}
module.exports = { guardAdminIn };
