const amqp=require('amqplib');
const {randomUUID,createHash}=require('node:crypto');
const {makeConnector}=require('./amqp-connect');
const {canonical,verifySignature}=require('./command-signature');
const {applyEvent}=require('./events');
const {context,propagation,ROOT_CONTEXT,SpanKind,SpanStatusCode,trace}=require('@opentelemetry/api');
const replyTracer=trace.getTracer('aggregator/replies');
const INSTANCE_QUEUE_ARGS={'x-queue-type':'quorum','x-message-ttl':60000};
const RECOVERY='agg.replies.recovery';

function makeReplyHandler({pool,internalKey,cache=new Map(),signal=async()=>{},source=null,persist=(sql,args)=>pool.query(sql,args)}){
  return async m=>{
    let b;try{if(m.content.length>65536)return false;b=JSON.parse(m.content);}catch{return false;}
    const p=m.properties;
    if(!b||b.type!=='COMMAND_RESULT'||b.schemaVersion!==1||!Number.isInteger(b.statusCode)||b.statusCode<200||b.statusCode>599||
      !b.result||typeof b.result!=='object'||!verifySignature(internalKey,b,{...p,headers:{...p.headers,'x-command-signature':p.headers?.['x-reply-signature']}}))return false;
    const traceparent=p.headers?.traceparent??b.traceparent;
    const parent=traceparent?propagation.extract(ROOT_CONTEXT,{traceparent}):ROOT_CONTEXT;
    return replyTracer.startActiveSpan('command.reply.receive',{
      kind:SpanKind.CONSUMER,attributes:{'messaging.system':'rabbitmq','messaging.destination.name':'parking.replies'},
    },parent,async span=>{
    try{
    const hash=createHash('sha256').update(canonical({code:b.statusCode,result:b.result})).digest('hex');
    const slot=b.slot&&typeof b.slot.slotCode==='string'&&['AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','HIDDEN'].includes(b.slot.status)&&Number.isSafeInteger(b.slot.version)&&b.slot.version>=0?b.slot:null;
    const identity=[b.commandId,p.correlationId,b.parkingId,b.commandType,b.actor];
    const match='id=$1 AND correlation_id=$2 AND parking_id=$3 AND type=$4 AND actor=$5::jsonb';
    const carrier={};
    propagation.inject(context.active(),carrier);
    // Notify other instances in the result transaction. The local instance already has the returned row.
    const updated=await persist(`WITH updated AS (
      UPDATE commands SET status=$6,result=$7,status_code=$8,reply_hash=$9,slot=$10,
        updated_at=now(),failure_phase=NULL,publish_state='CONFIRMED',publish_lease_until=NULL
        WHERE ${match} AND status='PENDING' RETURNING *
    )
    SELECT updated.* FROM updated CROSS JOIN LATERAL pg_notify('command_results',
      json_build_object('id',updated.id,'source',$11::text,
        'traceparent',COALESCE($12::text,updated.envelope->>'traceparent'))::text)`,
      [...identity,b.statusCode<400?'DONE':'FAILED',b.result,b.statusCode,hash,slot,source,carrier.traceparent??traceparent??null]);
    const changed=updated.rows[0];
    const row=changed??(await pool.query(
      `SELECT * FROM commands WHERE ${match} AND reply_hash=$6`,[...identity,hash])).rows[0];
    if(!row)return false;
    if(row.slot)applyEvent(cache,{parkingId:row.parking_id,slot:row.slot.slotCode,status:row.slot.status,version:row.slot.version});
    if(changed)await signal(row,{notified:true}); // durable update and notify precede broker ack.
    return true;
    }catch(error){span.recordException(error);span.setStatus({code:SpanStatusCode.ERROR,message:error.message});throw error;}
    finally{span.end();}
    });
  };
}

function makeReplyBatch(pool) {
  const queue = [];
  let scheduled = false;

  async function flush() {
    while (queue.length) {
      // Match the publishing worker lock order for overlapping command rows.
      const batch = queue.splice(0, 16).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      try {
        const records = batch.map(({ args }, ordinal) => ({
          command_id: args[0], correlation_id: args[1], parking_id: args[2], type: args[3], actor: args[4],
          status: args[5], result: args[6], status_code: args[7], reply_hash: args[8], slot: args[9],
          source: args[10], traceparent: args[11], ordinal,
        }));
        const { rows } = await context.with(batch[0].parent, () => pool.query(
          `WITH locked AS MATERIALIZED (
             SELECT id FROM commands WHERE id=ANY($2::text[]) ORDER BY created_at, id FOR UPDATE
           ), replies AS (
             SELECT DISTINCT ON (c.id) r.*
             FROM jsonb_to_recordset($1::jsonb) AS r(command_id text, correlation_id text, parking_id text,
               type text, actor jsonb, status text, result jsonb, status_code int, reply_hash text, slot jsonb,
               source text, traceparent text, ordinal int)
             JOIN locked l ON l.id=r.command_id
             JOIN commands c ON c.id=l.id AND c.correlation_id=r.correlation_id AND c.parking_id=r.parking_id
               AND c.type=r.type AND c.actor=r.actor AND c.status='PENDING'
             ORDER BY c.id, r.ordinal
           ), updated AS (
             UPDATE commands c SET status=r.status,result=r.result,status_code=r.status_code,reply_hash=r.reply_hash,
               slot=r.slot,updated_at=now(),failure_phase=NULL,publish_state='CONFIRMED',publish_lease_until=NULL
             FROM replies r WHERE c.id=r.command_id AND c.status='PENDING'
             RETURNING c.*, r.ordinal AS batch_ordinal, r.source AS batch_source, r.traceparent AS batch_traceparent
           )
           SELECT updated.* FROM updated CROSS JOIN LATERAL pg_notify('command_results',
             json_build_object('id',updated.id,'source',updated.batch_source,
               'traceparent',COALESCE(updated.batch_traceparent,updated.envelope->>'traceparent'))::text)`,
          [JSON.stringify(records), records.map((record) => record.command_id)]));
        const results = new Map(rows.map(({ batch_ordinal, batch_source, batch_traceparent, ...row }) =>
          [batch_ordinal, row]));
        // One statement commits every result before callers update caches or acknowledge RabbitMQ.
        batch.forEach((entry, ordinal) => entry.resolve({ rows: results.has(ordinal) ? [results.get(ordinal)] : [] }));
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      }
    }
    scheduled = false;
  }

  return (_sql, args) => new Promise((resolve, reject) => {
    queue.push({ id: args[0], args, parent: context.active(), resolve, reject });
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => void flush(), 3);
    }
  });
}

async function startReplyService({pool,url,instanceId,internalKey,flow,cache,onResult,connect=amqp.connect,log=console,retryMs=1000}){
  const owner=randomUUID();
  const claim=await pool.query(`INSERT INTO aggregator_instances(id,owner,lease_until) VALUES($1,$2,now()+interval '15 seconds')
    ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until
    WHERE aggregator_instances.lease_until<now() RETURNING id`,[instanceId,owner]);
  if(!claim.rowCount)throw new Error('DUPLICATE_AGGREGATOR_ID');
  const connectAny=makeConnector(url,connect);
  const handle=makeReplyHandler({pool,internalKey,cache,source:owner,persist:makeReplyBatch(pool),async signal(row,options){
    await flow.signal(row,options);
    onResult?.(row,context.active());
  }});
  let stopped=false,state,listener,notifyTimer,wake,retryTimer;
  const reconnectListener=()=>{clearTimeout(notifyTimer);if(!stopped)notifyTimer=setTimeout(listen,retryMs);};
  const heartbeat=setInterval(async()=>{
    try{const r=await pool.query("UPDATE aggregator_instances SET lease_until=now()+interval '15 seconds' WHERE id=$1 AND owner=$2",[instanceId,owner]);if(!r.rowCount)await stop();}
    catch{flow.setReady(false);if(state)end(state);}
  },5000);
  async function listen(){
    if(stopped)return;
    try{
      const c=await pool.connect();if(stopped){c.release(true);return;}listener=c;
      const lost=()=>{if(listener!==c)return;listener=undefined;c.release(true);reconnectListener();};
      c.on('error',lost);c.on('end',lost);
      c.on('notification',async n=>{
        if(n.channel!=='command_results')return;
        try{
          let notice;try{notice=JSON.parse(n.payload);}catch{/* Legacy instances notify with a raw commandId. */}
          if(notice?.source===owner)return;
          const id=typeof notice?.id==='string'?notice.id:n.payload;
          const row=await flow.get(id);
          if(row&&row.status!=='PENDING'){
            flow.settle(row.id,row);
            const traceparent=notice?.traceparent??row.envelope?.traceparent;
            const parent=traceparent?propagation.extract(ROOT_CONTEXT,{traceparent}):ROOT_CONTEXT;
            onResult?.(row,parent);
          }
        }catch{log.error('command notification failed');}
      });
      await c.query('LISTEN command_results');
    }catch{if(listener){listener.release(true);listener=undefined;}reconnectListener();}
  }
  listen();
  function end(s){if(s.dead)return;s.dead=true;flow.setReady(false);s.closed();s.conn.close().catch(()=>{});}
  const loop=(async()=>{
    while(!stopped){let s;
      try{
        const conn=await connectAny();s={conn,dead:false,inFlight:new Set()};state=s;
        const closed=new Promise(r=>{s.closed=r;});conn.on('error',()=>end(s));conn.on('close',()=>end(s));
        if(stopped){end(s);break;}
        const ch=await conn.createChannel();s.ch=ch;ch.on('error',()=>end(s));ch.on('close',()=>end(s));
        await ch.assertExchange('parking.replies','direct',{durable:true});
        const own=`agg.replies.${instanceId}`;
        await ch.assertQueue(own,{durable:true,arguments:INSTANCE_QUEUE_ARGS});
        await ch.assertQueue(RECOVERY,{durable:true,arguments:{'x-queue-type':'quorum'}});
        await ch.bindQueue(RECOVERY,'parking.replies',`agg.${instanceId}`);
        // The shared queue persists results for every instance. Drain legacy copies without publishing new ones.
        await ch.unbindQueue(own,'parking.replies',`agg.${instanceId}`);
        await ch.prefetch(16);
        for(const queue of [own,RECOVERY])await ch.consume(queue,m=>{
          if(!m){end(s);return;}
          if(s.dead||stopped)return;
          const job=handle(m).then(()=>{if(!s.dead)ch.ack(m);})
            .catch(()=>{log.error('reply persistence failed');end(s);})
            .finally(()=>s.inFlight.delete(job));
          s.inFlight.add(job);
        },{noAck:false});
        if(s.dead)throw new Error('reply setup closed');
        flow.setReady(true);await closed;
      }catch{if(s)end(s);log.error('reply consumer reconnect');}
      if(s)await Promise.all(s.inFlight);
      if(!stopped)await new Promise(r=>{wake=r;retryTimer=setTimeout(r,retryMs);});wake=undefined;
    }
  })();
  async function stop(){
    if(stopped)return;stopped=true;flow.setReady(false);clearInterval(heartbeat);clearTimeout(notifyTimer);clearTimeout(retryTimer);wake?.();
    if(state)end(state);await loop;
    if(listener){const c=listener;listener=undefined;await c.query('UNLISTEN command_results').catch(()=>{});c.release(true);}
    await pool.query('DELETE FROM aggregator_instances WHERE id=$1 AND owner=$2',[instanceId,owner]);
  }
  return {stop,handle};
}
module.exports={makeReplyBatch,makeReplyHandler,startReplyService,INSTANCE_QUEUE_ARGS,RECOVERY};
