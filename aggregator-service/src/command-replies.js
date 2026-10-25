const amqp=require('amqplib');
const {randomUUID,createHash}=require('node:crypto');
const {makeConnector}=require('./amqp-connect');
const {canonical,verifySignature}=require('./command-signature');
const {context,propagation,ROOT_CONTEXT,SpanKind,SpanStatusCode,trace}=require('@opentelemetry/api');
const {applyEvent}=require('./events');
const INSTANCE_QUEUE_ARGS={'x-queue-type':'quorum','x-message-ttl':60000};
const RECOVERY='agg.replies.recovery';
const replyTracer=trace.getTracer('aggregator/command-replies');

function makeReplyHandler({pool,internalKey,cache=new Map(),signal=async()=>{}}){
  return async m=>{
    let b;try{if(m.content.length>65536)return false;b=JSON.parse(m.content);}catch{return false;}
    const p=m.properties;
    if(!b||b.type!=='COMMAND_RESULT'||b.schemaVersion!==1||!Number.isInteger(b.statusCode)||b.statusCode<200||b.statusCode>599||
      !b.result||typeof b.result!=='object'||!verifySignature(internalKey,b,{...p,headers:{...p.headers,'x-command-signature':p.headers?.['x-reply-signature']}}))return false;
    const c=await pool.connect();let row,changed=false,accepted=false;
    try{
      await c.query('BEGIN');
      row=(await c.query('SELECT * FROM commands WHERE id=$1 FOR UPDATE',[b.commandId])).rows[0];
      if(row&&p.correlationId===row.correlation_id&&b.parkingId===row.parking_id&&b.commandType===row.type&&canonical(b.actor)===canonical(row.actor)){
        const hash=createHash('sha256').update(canonical({code:b.statusCode,result:b.result})).digest('hex');
        accepted=row.status==='PENDING'||row.reply_hash===hash;
        if(accepted&&row.status==='PENDING'){
          const slot=b.slot&&typeof b.slot.slotCode==='string'&&['AVAILABLE','RESERVED','OCCUPIED','MAINTENANCE','HIDDEN'].includes(b.slot.status)&&Number.isSafeInteger(b.slot.version)&&b.slot.version>=0?b.slot:null;
          row=(await c.query(`UPDATE commands SET status=$2,result=$3,status_code=$4,reply_hash=$5,slot=$6,updated_at=now(),failure_phase=NULL,publish_state='CONFIRMED',publish_lease_until=NULL
            WHERE id=$1 AND status='PENDING' RETURNING *`,[row.id,b.statusCode<400?'DONE':'FAILED',b.result,b.statusCode,hash,slot])).rows[0];
          changed=true;
        }
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    if(accepted&&row.slot)applyEvent(cache,{parkingId:row.parking_id,slot:row.slot.slotCode,status:row.slot.status,version:row.slot.version});
    if(changed)await signal(row); // durable update and notify precede broker ack.
    return accepted;
  };
}

async function startReplyService({pool,url,instanceId,internalKey,flow,cache,onResult,connect=u=>amqp.connect(u,{timeout:2000}),log=console,retryMs=1000}){
  const owner=randomUUID();
  const claim=await pool.query(`INSERT INTO aggregator_instances(id,owner,lease_until) VALUES($1,$2,now()+interval '15 seconds')
    ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until
    WHERE aggregator_instances.lease_until<now() RETURNING id`,[instanceId,owner]);
  if(!claim.rowCount)throw new Error('DUPLICATE_AGGREGATOR_ID');
  const connectAny=makeConnector(url,connect),handle=makeReplyHandler({pool,internalKey,cache,signal:flow.signal});
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
        try{const row=await flow.get(n.payload);if(row&&row.status!=='PENDING')onResult?.(row);}catch{log.error('command notification failed');}
      });
      await c.query('LISTEN command_results');
    }catch(error){
      if(listener){listener.release(true);listener=undefined;}
      log.error('command notification listener reconnect',{error:error.message});
      reconnectListener();
    }
  }
  listen();
  function end(s){if(s.dead)return;s.dead=true;flow.setReady(false);s.closed();s.conn.close().catch(()=>{});}
  const loop=(async()=>{
    while(!stopped){let s;
      try{
        const conn=await connectAny();s={conn,dead:false,tail:Promise.resolve()};state=s;
        const closed=new Promise(r=>{s.closed=r;});conn.on('error',()=>end(s));conn.on('close',()=>end(s));
        if(stopped){end(s);break;}
        const ch=await conn.createChannel();s.ch=ch;ch.on('error',()=>end(s));ch.on('close',()=>end(s));
        await ch.assertExchange('parking.replies','direct',{durable:true});
        const own=`agg.replies.${instanceId}`;
        await ch.assertQueue(own,{durable:true,arguments:INSTANCE_QUEUE_ARGS});
        await ch.assertQueue(RECOVERY,{durable:true,arguments:{'x-queue-type':'quorum'}});
        await ch.bindQueue(own,'parking.replies',`agg.${instanceId}`);
        await ch.bindQueue(RECOVERY,'parking.replies',`agg.${instanceId}`);
        await ch.prefetch(50);
        for(const queue of [own,RECOVERY])await ch.consume(queue,m=>{
          if(!m){end(s);return;}
          s.tail=s.tail.then(async()=>{
            if(s.dead||stopped)return;
            const parent=propagation.extract(ROOT_CONTEXT,m.properties?.headers??{});
            await context.with(parent,()=>replyTracer.startActiveSpan('command.reply.process',{
              kind:SpanKind.CONSUMER,
              attributes:{'messaging.system':'rabbitmq','messaging.destination.name':'parking.replies',
                'messaging.message.id':m.properties?.messageId},
            },async span=>{
              try{await handle(m);if(!s.dead)ch.ack(m);}
              catch(error){span.recordException(error);span.setStatus({code:SpanStatusCode.ERROR,message:error.message});throw error;}
              finally{span.end();}
            }));
          }).catch(()=>{log.error('reply persistence failed');end(s);});
        },{noAck:false});
        if(s.dead)throw new Error('reply setup closed');
        flow.setReady(true);await closed;
      }catch(error){
        if(s)end(s);
        log.error('reply consumer reconnect',{error:error.message});
      }
      if(s)await s.tail;
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
module.exports={makeReplyHandler,startReplyService,INSTANCE_QUEUE_ARGS,RECOVERY};
