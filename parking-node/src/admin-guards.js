const {normalizePlate}=require('./plate');
// Shared lock permits concurrent user operations; broadcast mutation takes the exclusive lock.
async function guardAdminIn(c,{slotCode,licensePlate,unlock=false}) {
  await c.query('SELECT id FROM admin_command_gate WHERE id=1 FOR SHARE');
  if(licensePlate&&(await c.query('SELECT 1 FROM banned_plates WHERE license_plate=$1',[normalizePlate(licensePlate)])).rowCount)return {code:403,body:{error:'PLATE_BANNED'}};
  if(slotCode&&(await c.query(`SELECT 1 FROM admin_floor_locks l JOIN parking_slots s ON s.floor=l.floor
    WHERE s.slot_code=$1 AND l.locked`,[slotCode])).rowCount)return {code:409,body:{error:unlock?'FLOOR_LOCKED':'SLOT_TAKEN'}};
  return null;
}
module.exports={guardAdminIn};
