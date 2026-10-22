// Opt in against an isolated RabbitMQ + PostgreSQL; never purges queues or volumes.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..');
const {Pool}=require('../aggregator-service/node_modules/pg');
const amqp=require('../aggregator-service/node_modules/amqplib');
const {makeCommands}=require('../aggregator-service/src/commands');
const {makeDlq,mountDlq}=require('../aggregator-service/src/dlq');
const {makeAuth}=require('../aggregator-service/src/auth');
const {mountReplayClaim}=require('../parking-node/src/replay-claim');
const express=require('../aggregator-service/node_modules/express'),jwt=require('../aggregator-service/node_modules/jsonwebtoken');
const {withDeadline,makeRetryOrDead,testFailures}=require('../parking-node/src/command-retry');
const {randomUUID}=require('node:crypto');
const source=process.env.PD02_SOURCE_ROOT;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,ms=25000){const start=Date.now();while(Date.now()-start<ms){const out=await fn();if(out)return out;await sleep(100);}throw new Error('wait timeout');}
test('PD08 broker + PostgreSQL integration with separate PD02 checkout', {skip:!source,timeout:80000},async t=>{
  const {makeCommandProcessor,startCommandConsumer}=require(path.join(source,'commands'));
  const {init}=require(path.join(source,'db'));
  const url=process.env.PD08_AMQP_URL,db=process.env.PD08_DATABASE_URL;
  assert.ok(url&&db,'isolated broker/database URLs required');
  const pool=new Pool({connectionString:db});
  const prefix=`T${Date.now().toString().slice(-5)}`;
  await init(pool,prefix,4);
  await pool.query(fs.readFileSync(path.join(root,'aggregator-service/src/schema.sql'),'utf8'));
  const ids=[],reservations=[];let consumer;
  const conn=await amqp.connect(url),ch=await conn.createChannel();
  // Require idle source queues; protects a user stack from competing test consumers.
  for(const q of ['cmd.A','cmd.B','cmd.C','cmd.dead']){const r=await ch.checkQueue(q);assert.equal(r.consumerCount,0);assert.equal(r.messageCount,0);}
  const key='pd08-test-key',pub=makeCommands(url,{signingKey:key,ttlMs:60000,replyTo:'pd08.test'});
  const claimApp=express();claimApp.use(express.json());mountReplayClaim(claimApp,{pool,internalKey:key});
  const claimServer=claimApp.listen(0,'127.0.0.1');await new Promise(r=>claimServer.once('listening',r));
  const dead=makeDlq({pool,url,internalKey:key,ttlMs:60000,claimReplay:async(_,messageId,replayMessageId)=>{
    const r=await fetch(`http://127.0.0.1:${claimServer.address().port}/api/internal/commands/replay-claim`,{method:'POST',headers:{'x-internal-key':key,'content-type':'application/json'},body:JSON.stringify({messageId,replayMessageId})});
    if(!r.ok)throw Object.assign(new Error('CLAIM_REJECTED'),{status:r.status});
  }});
  const processor=makeCommandProcessor({pool,parkingId:'A',internalKey:key});
  let hook=()=>{},times=[];
  const wrapped=withDeadline(processor,{internalKey:key,parkingId:'A',beforeDispatch:m=>{times.push(Date.now());hook(m);}});
  const retry=makeRetryOrDead({url,internalKey:key});
  consumer=startCommandConsumer({url,pool,parkingId:'A',internalKey:key,processCommand:wrapped,retryOrDead:retry,
    afterCommit:()=>{},log:{info(){},error(){}},retryMs:500});
  await wait(async()=> (await ch.checkQueue('cmd.A')).consumerCount===1);
  const actor={userId:`pd08-${randomUUID()}`,role:'USER'};
  const send=async(slot,opts={})=>{
    const id=`${actor.userId}:${randomUUID()}`;ids.push(id);
    await pub.send('A','reserve',{slotCode:slot,licensePlate:'30A-123.45'},{actor,messageId:id,...opts});return id;
  };
  t.after(async()=>{
    await consumer?.stop();await pub.close();await dead.close();await retry.close();
    claimServer.closeAllConnections();await new Promise(r=>claimServer.close(r));
    // Only rows belonging to this test; never deletes application inbox or broker volumes.
    await pool.query('DELETE FROM command_reply_outbox WHERE command_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM inbox_messages WHERE message_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM parking_events WHERE slot_code LIKE $1',[`${prefix}%`]);
    await pool.query('DELETE FROM reservations WHERE request_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM dead_letters WHERE message_id=ANY($1::text[])',[ids]);
    await pool.query('DELETE FROM parking_slots WHERE slot_code LIKE $1',[`${prefix}%`]);
    await conn.close();await pool.end();
  });
  await t.test('TC57: two transient errors, 2s + 10s, third delivery one committed effect',async()=>{
    const id=`${actor.userId}:${randomUUID()}`;ids.push(id);times=[];
    hook=testFailures({enabled:true,messageId:id,count:2});
    await pub.send('A','reserve',{slotCode:`${prefix}01`,licensePlate:'30A-123.45'},{actor,messageId:id});
    const r=await wait(async()=> (await pool.query('SELECT * FROM reservations WHERE request_id=$1',[id])).rows[0]);reservations.push(r.id);
    assert.equal(times.length,3);assert.ok(times[1]-times[0]>=1900);assert.ok(times[2]-times[1]>=9900);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[id])).rows[0].n,1);
    console.log('TC57 retry intervals ms:',times[1]-times[0],times[2]-times[1]);
    for(const q of ['cmd.B','cmd.C'])assert.equal((await ch.checkQueue(q)).messageCount,0);
  });
  await t.test('TC58 backend: invalid schema -> durable DLQ -> ADMIN edit/replay -> one reservation',async()=>{
    hook=()=>{};const id=await send(`${prefix}02`,{schemaVersion:2});
    const m=await wait(()=>ch.get('cmd.dead',{noAck:false}));await dead.store(m);await dead.store(m);ch.ack(m);
    const row=(await dead.list()).items.find(x=>x.messageId===id);assert.ok(row);assert.equal(row.reason,'INVALID_SCHEMA');
    const app=express();app.use(express.json());mountDlq(app,{dlq:dead,need:makeAuth('test-secret').need});
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    try {
      const token=jwt.sign({sub:'admin',role:'ADMIN'},'test-secret');
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/admin/dlq/${row.id}/replay`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({payload:{slotCode:`${prefix}03`,licensePlate:'30B-456.78'}})});
      assert.equal(response.status,202);const body=await response.json();ids.push(body.messageId);
      await dead.relay();await wait(async()=> (await pool.query('SELECT 1 FROM reservations WHERE request_id=$1',[body.messageId])).rowCount===1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM dead_letters WHERE message_id=$1',[id])).rows[0].n,1);
    } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  });
  await t.test('edited replay cannot bypass an existing inbox result under the original ID',async()=>{
    const original=ids[0];
    await pub.send('A','reserve',{slotCode:`${prefix}04`,licensePlate:'30D-111.22'},{actor,messageId:original,schemaVersion:2});
    const m=await wait(()=>ch.get('cmd.dead',{noAck:false}));await dead.store(m);ch.ack(m);
    const row=(await dead.list()).items.find(x=>x.messageId===original);
    await assert.rejects(dead.replay(row.id,{payload:{slotCode:`${prefix}04`,licensePlate:'30D-333.44'}},'admin'),e=>e.status===409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[original])).rows[0].n,1);
  });
  await t.test('retry exhaustion reaches durable DLQ after two delays; business 409 never retries',async()=>{
    const id=`${actor.userId}:${randomUUID()}`;ids.push(id);
    hook=m=>{if(m.properties.messageId===id)throw new Error('TEST_TRANSIENT');};
    await pub.send('A','reserve',{slotCode:`${prefix}04`,licensePlate:'30C-111.22'},{actor,messageId:id});
    const m=await wait(()=>ch.get('cmd.dead',{noAck:false}));
    assert.equal(m.properties.messageId,id);assert.equal(m.properties.headers['x-retry'],2);
    assert.equal(m.properties.headers['x-failure-reason'],'RETRY_EXHAUSTED');await dead.store(m);ch.ack(m);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[id])).rows[0].n,0);
    hook=()=>{};const business=await send(`${prefix}01`);
    await wait(async()=> (await pool.query('SELECT status_code FROM inbox_messages WHERE message_id=$1',[business])).rows[0]?.status_code===409);
    for(const q of ['cmd.retry.2s','cmd.retry.10s'])assert.equal((await ch.checkQueue(q)).messageCount,0);
  });
  await t.test('retry crosses total deadline: no renewal and no late reservation',async()=>{
    const short=makeCommands(url,{signingKey:key,ttlMs:500,replyTo:'pd08.test'});const id=`${actor.userId}:${randomUUID()}`;ids.push(id);
    hook=testFailures({enabled:true,messageId:id,count:1});
    await short.send('A','reserve',{slotCode:`${prefix}04`,licensePlate:'30C-222.33'},{actor,messageId:id});await short.close();
    const m=await wait(()=>ch.get('cmd.expired',{noAck:false}));assert.equal(m.properties.messageId,id);ch.ack(m);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[id])).rows[0].n,0);
    assert.equal(JSON.parse(m.content).deadlineAt-JSON.parse(m.content).issuedAt,500);
  });
  await t.test('total deadline elapsed before dispatch: no late effect, forwarded to PD06 expired queue',async()=>{
    const short=makeCommands(url,{signingKey:key,ttlMs:50,replyTo:'pd08.test'});const id=`${actor.userId}:${randomUUID()}`;ids.push(id);
    await consumer.stop();consumer=null;
    await short.send('A','reserve',{slotCode:`${prefix}04`,licensePlate:'30C-222.33'},{actor,messageId:id});await short.close();
    await sleep(200);
    const m=await wait(()=>ch.get('cmd.expired',{noAck:false}));assert.equal(m.properties.messageId,id);ch.ack(m);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reservations WHERE request_id=$1',[id])).rows[0].n,0);
  });
});
