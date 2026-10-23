const amqp = require('amqplib');
const { makeConnector } = require('./amqp-connect');
const { REPLY_TO } = require('./broadcast');

// Separate routing key from PD-03 instance replies: competing consumers must never discard each other's messages.
function startBroadcastReplies({ url, broadcasts, log = console, retryMs = 1000, connect = u => amqp.connect(u,{timeout:2000}) }) {
  const connectAny=makeConnector(url,connect);
  let stopped=false,state,wake,timer;
  broadcasts.ensureTargets=async targets=>{
    if(!state||state.dead||!state.ch)throw Object.assign(new Error('ADMIN_BROADCAST_NOT_READY'),{code:'ADMIN_BROADCAST_NOT_READY',status:503});
    for(const {id,zone} of targets){
      const queue=`cmd.${id}.admin`,ch=state.ch;
      await ch.assertQueue(queue,{durable:true,arguments:{'x-queue-type':'quorum','x-single-active-consumer':true}});
      // A/B/C definitions seed bac; a different static zone requires removing that owned seed binding.
      if(['A','B','C'].includes(id)&&zone!=='bac')await ch.unbindQueue(queue,'parking.commands','cmd.zone-bac.#');
      await ch.bindQueue(queue,'parking.commands','cmd.all.#');
      if(zone)await ch.bindQueue(queue,'parking.commands',`cmd.zone-${zone}.#`);
    }
  };
  const end=s=>{if(s.dead)return;s.dead=true;broadcasts.setReady(false);s.closed();s.conn.close().catch(()=>{});};
  const loop=(async()=>{
    while(!stopped){let s;
      try{
        const conn=await connectAny();s={conn,dead:false,tail:Promise.resolve()};state=s;
        const closed=new Promise(r=>{s.closed=r;});conn.on('error',()=>end(s));conn.on('close',()=>end(s));
        if(stopped){end(s);break;}
        const ch=await conn.createChannel();s.ch=ch;ch.on('error',()=>end(s));ch.on('close',()=>end(s));
        await ch.assertExchange('parking.replies','direct',{durable:true});
        await ch.assertQueue('agg.broadcast.replies',{durable:true,arguments:{'x-queue-type':'quorum'}});
        await ch.bindQueue('agg.broadcast.replies','parking.replies',REPLY_TO);
        await ch.prefetch(20);
        const tag=await ch.consume('agg.broadcast.replies',m=>{
          if(!m){end(s);return;}
          s.tail=s.tail.then(async()=>{if(stopped||s.dead)return;await broadcasts.handle(m);if(!s.dead)ch.ack(m);})
            .catch(()=>{log.error('broadcast reply persistence failed');end(s);});
        },{noAck:false});
        s.tag=tag.consumerTag;
        if(s.dead)throw new Error('REPLY_SETUP_CLOSED');
        broadcasts.setReady(true);await closed;
      }catch{if(s)end(s);log.error('broadcast reply reconnect');}
      if(s)await s.tail;
      if(!stopped)await new Promise(r=>{wake=r;timer=setTimeout(r,retryMs);});wake=undefined;
    }
  })();
  return {async stop(){stopped=true;broadcasts.setReady(false);clearTimeout(timer);wake?.();
    if(state&&!state.dead){if(state.tag)await state.ch.cancel(state.tag).catch(()=>{});await state.tail;end(state);}await loop;}};
}
function mountBroadcasts(app,{need,broadcasts}) {
  app.get('/api/admin/broadcast/zones',need('ADMIN'),(_req,res)=>res.json(broadcasts.zones ?? []));
  app.post('/api/admin/broadcast',need('ADMIN'),async(req,res)=>{
    try {
      const trace=req.get('traceparent');
      if(trace&&!/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(trace))return res.status(400).json({error:'INVALID_TRACEPARENT'});
      const view=await broadcasts.submit(req.body,{userId:req.user.sub,role:req.user.role},req.get('idempotency-key'),trace?{traceparent:trace}:{});
      res.status(view.publishState==='REJECTED'?404:200).json(view);
    }catch(e){res.status(e.status??503).json({error:e.code??'BROADCAST_UNAVAILABLE'});}
  });
  app.get('/api/admin/broadcast/:id',need('ADMIN'),async(req,res)=>{
    if(req.params.id.length>255)return res.status(400).json({error:'INVALID_ID'});
    try{const out=await broadcasts.get(req.params.id);res.status(out?200:404).json(out??{error:'BROADCAST_NOT_FOUND'});}
    catch{res.status(503).json({error:'BROADCAST_UNAVAILABLE'});}
  });
}
module.exports={startBroadcastReplies,mountBroadcasts};
