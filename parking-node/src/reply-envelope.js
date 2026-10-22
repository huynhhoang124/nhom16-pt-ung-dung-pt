const {signature}=require('./command-signature');
// Called by PD-02 BEFORE inserting its reply outbox, using that transaction client.
async function enrichReply(c,env,payload,properties,key){
  let sql,values;
  if(env.type==='reserve'){sql='SELECT slot_code,status,version FROM parking_slots WHERE slot_code=$1';values=[env.payload.slotCode];}
  if(env.type==='cancel'){sql='SELECT s.slot_code,s.status,s.version FROM parking_slots s JOIN reservations r ON r.slot_id=s.id WHERE r.id=$1';values=[env.payload.reservationId];}
  if(env.type==='pay'){sql='SELECT s.slot_code,s.status,s.version FROM parking_slots s JOIN parking_sessions p ON p.slot_id=s.id WHERE p.id=$1';values=[env.payload.sessionId];}
  // Invalid UUIDs are business failures. Never issue a second SQL error after recovery.
  if(sql&&(env.type==='reserve'||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values[0]??''))){
    const row=(await c.query(sql,values)).rows[0];
    if(row)payload.slot={slotCode:row.slot_code,status:row.status,version:Number(row.version)};
  }
  properties.headers={...properties.headers,'x-reply-signature':signature(key,payload,properties)};
}
module.exports={enrichReply};
