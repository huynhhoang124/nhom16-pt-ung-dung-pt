const { canonical, verifySignature } = require('./command-signature');
const { validateAdmin } = require('./admin-payload');
const { savePricing } = require('./db');
const { normalizePlate } = require('./plate');
const TYPES=['setPricing','lockFloor','banPlates'];
const business=(code,error)=>({code,body:{error}});

function decodeAdmin(m,parkingId,internalKey) {
  const invalid=reason=>{const e=new Error(reason);e.code='INVALID_ADMIN_COMMAND';throw e;};
  if(m.content.length>10240)invalid('COMMAND_TOO_LARGE');
  let b;try{b=JSON.parse(m.content);}catch{invalid('INVALID_JSON');}
  if(!b||typeof b!=='object'||Array.isArray(b))invalid('INVALID_ENVELOPE');
  const p=m.properties??{};
  if(!verifySignature(internalKey,b,p))invalid('UNTRUSTED_COMMAND');
  if(b.schemaVersion!==1||!TYPES.includes(b.type)||b.actor?.role!=='ADMIN'||!/^\w[\w-]{0,63}$/.test(b.actor.userId??''))invalid('INVALID_ENVELOPE');
  if(!Array.isArray(b.targets)||b.targets.length<1||b.targets.length>100||new Set(b.targets).size!==b.targets.length||
    b.targets.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(id))||!b.targets.includes(parkingId))invalid('NOT_A_TARGET');
  if(!/^(all|zone-[a-z0-9_-]{1,32})$/.test(b.parkingId??'')||m.fields?.routingKey!==`cmd.${b.parkingId}.${b.type}`)invalid('ROUTING_MISMATCH');
  if(!Number.isSafeInteger(b.issuedAt)||!Number.isSafeInteger(b.deadlineAt)||b.deadlineAt-b.issuedAt!==600000)invalid('INVALID_ADMIN_DEADLINE');
  if(typeof p.messageId!=='string'||!p.messageId.startsWith(`${b.actor.userId}:broadcast-`)||p.messageId.length>150||
    p.correlationId!==p.messageId||p.replyTo!=='agg.broadcast'||p.type!==b.type||!/^[0-9]+$/.test(p.expiration??''))invalid('INVALID_PROPERTIES');
  for(const k of ['schemaVersion','actor','causationId','traceparent','hlc','fencingToken']) {
    if(p.headers?.[k]!==undefined&&canonical(p.headers[k])!==canonical(b[k]))invalid('HEADER_MISMATCH');
  }
  return {...b,messageId:p.messageId,correlationId:p.correlationId,replyTo:p.replyTo,expiration:p.expiration};
}

async function applyAdminIn(c,env,{parkingId}) {
  if(env.actor?.role!=='ADMIN')return business(403,'FORBIDDEN');
  const invalid=validateAdmin(env.type,env.payload);
  if(invalid)return business(400,invalid);
  // Serialize admin mutations in this DB. clock_timestamp AFTER the lock protects expired commands waiting behind a transaction.
  await c.query('SELECT id FROM admin_command_gate WHERE id=1 FOR UPDATE');
  const expired=async()=>new Date((await c.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime()>=env.deadlineAt;
  if(await expired())return business(410,'ADMIN_COMMAND_EXPIRED');
  const b=env.payload;
  if(env.type==='setPricing') {
    await c.query('SELECT vehicle_type FROM pricing_rules ORDER BY vehicle_type FOR UPDATE');
    if(await expired())return business(410,'ADMIN_COMMAND_EXPIRED');
    await savePricing(c,b.rules);
    return {code:200,body:{applied:true,updated:b.rules.length}};
  }
  if(env.type==='banPlates') {
    const plates=b.plates.map(normalizePlate).sort();
    if(b.banned)await c.query(`INSERT INTO banned_plates(license_plate,command_id)
      SELECT unnest($1::text[]),$2 ON CONFLICT(license_plate) DO UPDATE SET command_id=$2,updated_at=now()`,[plates,env.messageId]);
    else await c.query('DELETE FROM banned_plates WHERE license_plate=ANY($1::text[])',[plates]);
    return {code:200,body:{applied:true,updated:plates.length,banned:b.banned}};
  }
  const rows=(await c.query("SELECT * FROM parking_slots WHERE floor=$1 AND status<>'HIDDEN' ORDER BY id FOR UPDATE",[b.floor])).rows;
  if(!rows.length)return business(404,'FLOOR_NOT_FOUND');
  if(await expired())return business(410,'ADMIN_COMMAND_EXPIRED');
  if(b.locked&&(rows.some(s=>['RESERVED','OCCUPIED'].includes(s.status))||
    (await c.query("SELECT 1 FROM reservations r JOIN parking_slots s ON s.id=r.slot_id WHERE s.floor=$1 AND r.status IN ('ACTIVE','USED') LIMIT 1",[b.floor])).rowCount))return business(409,'FLOOR_IN_USE');
  await c.query(`INSERT INTO admin_floor_locks(floor,locked,command_id) VALUES($1,$2,$3)
    ON CONFLICT(floor) DO UPDATE SET locked=$2,command_id=$3,updated_at=now()`,[b.floor,b.locked,env.messageId]);
  const changed=[];
  for(const slot of rows) {
    if(b.locked&&slot.status!=='AVAILABLE')continue;
    if(!b.locked&&!(await c.query('SELECT 1 FROM admin_locked_slots WHERE slot_id=$1',[slot.id])).rowCount)continue;
    if(!b.locked&&slot.status!=='MAINTENANCE') {await c.query('DELETE FROM admin_locked_slots WHERE slot_id=$1',[slot.id]);continue;}
    const status=b.locked?'MAINTENANCE':'AVAILABLE';
    const out=await c.query('UPDATE parking_slots SET status=$2,version=version+1,updated_at=now() WHERE id=$1 AND version=$3 RETURNING version',[slot.id,status,slot.version]);
    if(!out.rowCount)throw new Error('ADMIN_SLOT_CAS_CONFLICT');
    if(b.locked)await c.query('INSERT INTO admin_locked_slots(slot_id,floor) VALUES($1,$2) ON CONFLICT DO NOTHING',[slot.id,b.floor]);
    else await c.query('DELETE FROM admin_locked_slots WHERE slot_id=$1',[slot.id]);
    const version=Number(out.rows[0].version);
    const counts=(await c.query("SELECT count(*) FILTER(WHERE status='AVAILABLE')::int AS available,count(*) FILTER(WHERE status<>'HIDDEN')::int AS total FROM parking_slots")).rows[0];
    await c.query('INSERT INTO parking_events(event_type,slot_code,payload) VALUES($1,$2,$3)',
      [b.locked?'MAINTENANCE_ON':'MAINTENANCE_OFF',slot.slot_code,{event:'SLOT_UPDATED',type:b.locked?'MAINTENANCE_ON':'MAINTENANCE_OFF',parkingId,slot:slot.slot_code,status,version,...counts,commandId:env.messageId}]);
    changed.push({slotCode:slot.slot_code,status,version});
  }
  return {code:200,body:{applied:true,floor:b.floor,locked:b.locked,updated:changed.length}};
}
async function dispatchAdminIn(c,env,options) {
  await c.query('SAVEPOINT admin_effects');
  let out=await applyAdminIn(c,env,options);
  const now=new Date((await c.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  if(now>=env.deadlineAt){await c.query('ROLLBACK TO SAVEPOINT admin_effects');out=business(410,'ADMIN_COMMAND_EXPIRED');}
  await c.query('RELEASE SAVEPOINT admin_effects');
  return out;
}
module.exports={decodeAdmin,dispatchAdminIn,TYPES};
