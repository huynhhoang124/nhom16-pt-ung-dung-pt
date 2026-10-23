const { randomUUID, createHash } = require('node:crypto');
const { canonical, verifySignature } = require('./command-signature');
const { validateAdmin } = require('./admin-payload');
const TTL = 600000;
const REPLY_TO = 'agg.broadcast';
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const segment = s => typeof s === 'string' && /^[a-z0-9_-]{1,32}$/.test(s);

// Transitional zone source: only registered lots are eligible; OFFLINE is still a target.
function snapshotTargets(reg, zones, zone) {
  if (!segment(zone)) throw fail('INVALID_ZONE');
  const ids = reg.all().filter(n => zone === 'all' || (n.zone ?? zones[n.id]) === zone).map(n => n.id).sort();
  if (!ids.length) throw fail('ZONE_NOT_FOUND', 404);
  if (ids.length > 100 || ids.some(id => !/^[A-Za-z0-9_-]{1,32}$/.test(id))) throw fail('INVALID_TARGETS');
  return ids;
}

function makeBroadcasts({ pool, publisher, reg, zones = {}, internalKey, waitMs = 5000, now = Date.now, enabled = false }) {
  let stopped = false, ready = false, timer, job;
  const owner = randomUUID();
  async function get(id) {
    const row = (await pool.query('SELECT * FROM admin_broadcasts WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    const replies = (await pool.query('SELECT * FROM admin_broadcast_results WHERE broadcast_id=$1 ORDER BY parking_id', [id])).rows;
    const applied = replies.filter(r => r.status_code < 400).map(r => r.parking_id);
    const rejected = replies.filter(r => r.status_code >= 400).map(r => ({ parkingId: r.parking_id, statusCode: r.status_code, error: /^[A-Z_]{1,64}$/.test(r.result.error??'') ? r.result.error : 'COMMAND_REJECTED' }));
    const missing = row.targets.filter(id => !replies.some(r => r.parking_id === id));
    return { broadcastId: row.id, zone: row.zone, type: row.command_type, targets: row.targets,
      applied, rejected, missing, total: row.targets.length, publishState: row.publish_state,
      deadlineAt: row.deadline_at, expired: now() >= new Date(row.deadline_at).getTime(),
      // Payloads (in particular banned plates), HMAC and raw node errors never leave this projection.
      results: replies.map(r => ({ parkingId: r.parking_id, statusCode: r.status_code, receivedAt: r.received_at })),
      error: row.last_error };
  }
  async function submit(input, actor, key = randomUUID(), metadata = {}) {
    if (!enabled || !ready || stopped) throw fail('ADMIN_BROADCAST_NOT_READY', 503);
    if (actor?.role !== 'ADMIN') throw fail('FORBIDDEN', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'body,type,zone') throw fail('INVALID_PAYLOAD');
    const {zone,type,body}=input;
    const invalid = validateAdmin(type, body);
    if (invalid) throw fail(invalid);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw fail('INVALID_IDEMPOTENCY_KEY');
    const id = `${actor.userId}:broadcast-${key}`;
    const requestHash = hash({ zone, type, body, actor });
    const prior = (await pool.query('SELECT request_hash FROM admin_broadcasts WHERE id=$1', [id])).rows[0];
    if (prior && prior.request_hash !== requestHash) throw fail('IDEMPOTENCY_KEY_REUSED', 422);
    if (!prior) {
      const targets = snapshotTargets(reg, zones, zone);
      await api.ensureTargets?.(targets.map(id=>({id,zone:reg.get(id)?.zone??zones[id]})));
      const issuedAt = now(), deadlineAt = issuedAt + TTL;
      const envelope = { schemaVersion: 1, type, parkingId: zone === 'all' ? 'all' : `zone-${zone}`,
        actor, payload: body, targets, issuedAt, deadlineAt, ...metadata };
      await pool.query(`INSERT INTO admin_broadcasts(id,user_id,zone,command_type,request_hash,envelope,targets,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
      [id,actor.userId,zone,type,requestHash,envelope,JSON.stringify(targets),new Date(deadlineAt)]);
      const inserted = (await pool.query('SELECT request_hash FROM admin_broadcasts WHERE id=$1',[id])).rows[0];
      if (inserted.request_hash !== requestHash) throw fail('IDEMPOTENCY_KEY_REUSED',422);
    }
    // Durable intent is committed before any publish. Worker owns recovery after HTTP disconnect.
    void pump();
    const until = Date.now() + waitMs;
    while (!stopped) {
      const view = await get(id);
      if (!view.missing.length || view.publishState === 'REJECTED' || Date.now() >= until) return view;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return get(id);
  }
  async function publishNext() {
    if (!ready || stopped) return;
    const c = await pool.connect(); let row;
    try {
      await c.query('BEGIN');
      row = (await c.query(`SELECT * FROM admin_broadcasts WHERE
        (publish_state='QUEUED' OR (publish_state IN ('SENDING','UNKNOWN') AND lease_until<now()))
        AND deadline_at>clock_timestamp() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (row) await c.query("UPDATE admin_broadcasts SET publish_state='SENDING',lease_owner=$2,lease_until=now()+interval '10 seconds' WHERE id=$1",[row.id,owner]);
      await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK').catch(()=>{}); throw e; } finally { c.release(); }
    if (!row) return;
    const e = row.envelope;
    try {
      await publisher.send(e.parkingId,e.type,e.payload,{ ...e, messageId:row.id,correlationId:row.id,replyTo:REPLY_TO });
      await pool.query("UPDATE admin_broadcasts SET publish_state='CONFIRMED',last_error=NULL WHERE id=$1 AND lease_owner=$2",[row.id,owner]);
    } catch(error) {
      // Fanout nack can mean SOME target queues accepted. Never present it as an atomic rejection.
      const rejected = error.code === 'PARKING_NOT_FOUND' && row.publish_state === 'QUEUED';
      await pool.query('UPDATE admin_broadcasts SET publish_state=$3,last_error=$4,lease_until=now()+interval \'2 seconds\' WHERE id=$1 AND lease_owner=$2',
        [row.id,owner,rejected?'REJECTED':'UNKNOWN',rejected?'NO_ROUTE':'PUBLISH_OUTCOME_UNKNOWN']);
    }
  }
  function pump() {
    if (!job) job = publishNext().catch(()=>{}).finally(()=>{job=undefined;});
    return job;
  }
  async function handle(m) {
    let b; try { if(m.content.length>65536)return false; b=JSON.parse(m.content); } catch { return false; }
    const p=m.properties ?? {};
    if (b?.type!=='COMMAND_RESULT' || b.schemaVersion!==1 || !Number.isInteger(b.statusCode) || b.statusCode<200 || b.statusCode>599 ||
      !b.result || typeof b.result!=='object' || !verifySignature(internalKey,b,{...p,headers:{...p.headers,'x-command-signature':p.headers?.['x-reply-signature']}})) return false;
    const row=(await pool.query('SELECT * FROM admin_broadcasts WHERE id=$1',[b.commandId])).rows[0];
    if (!row || p.correlationId!==row.id || b.commandType!==row.command_type || !row.targets.includes(b.parkingId) || canonical(b.actor)!==canonical(row.envelope.actor)) return false;
    const digest=hash({statusCode:b.statusCode,result:b.result});
    await pool.query(`INSERT INTO admin_broadcast_results(broadcast_id,parking_id,status_code,result,reply_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(broadcast_id,parking_id) DO NOTHING`,[row.id,b.parkingId,b.statusCode,b.result,digest]);
    const stored=(await pool.query('SELECT reply_hash FROM admin_broadcast_results WHERE broadcast_id=$1 AND parking_id=$2',[row.id,b.parkingId])).rows[0];
    return stored.reply_hash===digest; // First committed terminal result wins, including late replies.
  }
  const api = { submit,get,handle,pump,setReady(value){ready=value;},start(){timer=setInterval(pump,100);},
    async stop(){stopped=true;clearInterval(timer);await job;} };
  return api;
}
module.exports={makeBroadcasts,snapshotTargets,TTL,REPLY_TO};
