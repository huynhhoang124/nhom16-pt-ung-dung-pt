// Real broker + PG, candidate requires PD-02 inbox and PD-03 signed reply hook.
// RUN_PD04_BROKER=1 COMPOSE_PROJECT_NAME=... COMPOSE_FILE=... node --test tests/pd04-broadcast.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../aggregator-service/package.json',import.meta.url));
const amqp=require('amqplib'),{signature}=require('./src/command-signature');
const root=fileURLToPath(new URL('..',import.meta.url));
try{process.loadEnvFile(new URL('../.env',import.meta.url));}catch{/* explicit environment */}
const enabled=process.env.RUN_PD04_BROKER==='1',key=process.env.INTERNAL_KEY??'dev';
const compose=(...args)=>execFileSync('docker',['compose',...args],{cwd:root,encoding:'utf8'}).trim();
const sql=(id,q)=>compose('exec','-T',`db-${id}`,'psql','-U','postgres','-d','parking','-tAc',q);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;do{const v=await fn();if(v)return v;await sleep(200);}while(Date.now()<end);throw new Error('Timed out waiting for broker/DB evidence');}
async function api(path,token,body,requestKey){const r=await fetch('http://localhost:8000'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token&&{authorization:`Bearer ${token}`}),...(requestKey&&{'idempotency-key':requestKey})},body:body&&JSON.stringify(body)});return {status:r.status,body:await r.json()};}
const login=async username=>(await api('/api/auth/login',null,{username,password:process.env.DEMO_PASSWORD??'123456'})).body.token;
const rule=fee=>({rules:[{vehicleType:'CAR',firstBlockMin:120,firstBlockFee:fee,nextHourFee:10000,overnightFee:30000,maxDayFee:150000}]});
test('PD-04 broker candidate A/B/C: fanout, duplicate, offline >10s, expiry, persistence, authorization', {skip:!enabled,timeout:180000},async t=>{
  const ids=['A','B','C'],lower=ids.map(x=>x.toLowerCase()),prefix=`pd04-${randomUUID().slice(0,8)}`;
  const old=Object.fromEntries(lower.map(id=>[id,JSON.parse(sql(id,'SELECT json_agg(row_to_json(p)) FROM pricing_rules p'))]));
  let conn,ch,token;const commandIds=[];let captured=[];
  const slot=`P4${randomUUID().replaceAll('-','').slice(0,6)}`,plate=`55A${String(Math.floor(Math.random()*90000)+10000)}`;
  let adminFixtures=false;
  try{
    token=await login('admin');assert.ok(token);
    conn=await amqp.connect(process.env.PD04_AMQP_URL??'amqp://parking:parking@localhost:5673/%2F');ch=await conn.createConfirmChannel();
    await ch.assertExchange('parking.commands','topic',{durable:true});
    const probe=await ch.assertQueue('',{exclusive:true});await ch.bindQueue(probe.queue,'parking.commands','cmd.zone-bac.#');
    await ch.consume(probe.queue,m=>{if(m){captured.push({body:JSON.parse(m.content),properties:m.properties});ch.ack(m);}});
    await t.test('one publish; all targets apply; ten HTTP duplicates and broker redelivery stay one inbox effect',async()=>{
      const replies=await Promise.all(Array.from({length:10},()=>api('/api/admin/broadcast',token,{zone:'bac',type:'setPricing',body:rule(31001)},prefix+'-one')));
      replies.forEach(r=>assert.equal(r.status,200));const v=replies[0].body;commandIds.push(v.broadcastId);assert.deepEqual(v.applied,ids);
      assert.ok(replies.every(r=>r.body.broadcastId===v.broadcastId));
      const wires=captured.filter(m=>m.properties.messageId===v.broadcastId);assert.equal(wires.length,1);const wire=wires[0];
      assert.equal(wire.properties.correlationId,v.broadcastId);assert.equal(wire.properties.replyTo,'agg.broadcast');assert.equal(wire.properties.deliveryMode,2);assert.ok(Number(wire.properties.expiration)>590000);
      // Explicit duplicate of the exact signed message, same business ID.
      await new Promise((resolve,reject)=>ch.publish('parking.commands','cmd.zone-bac.setPricing',Buffer.from(JSON.stringify(wire.body)),{...wire.properties,mandatory:true,persistent:true},e=>e?reject(e):resolve()));
      await until(()=>lower.every(id=>Number(sql(id,`SELECT count(*) FROM command_reply_outbox WHERE command_id='${v.broadcastId}'`))>=2));
      for(const id of lower){assert.equal(Number(sql(id,`SELECT count(*) FROM inbox_messages WHERE message_id='${v.broadcastId}'`)),1);assert.equal(Number(sql(id,"SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'")),31001);}
    });
    await t.test('C stopped >10 seconds: 2/3 first, durable late result then persistence after restart',async()=>{
      compose('stop','parking-c');const start=Date.now();
      const first=await api('/api/admin/broadcast',token,{zone:'bac',type:'setPricing',body:rule(31002)},prefix+'-offline');
      assert.equal(first.status,200);commandIds.push(first.body.broadcastId);assert.deepEqual(first.body.applied,['A','B']);assert.deepEqual(first.body.missing,['C']);
      await sleep(Math.max(0,12000-(Date.now()-start)));compose('start','parking-c');
      const final=await until(async()=>{const r=await api(`/api/admin/broadcast/${encodeURIComponent(first.body.broadcastId)}`,token);return r.body.applied?.length===3&&r.body;});
      assert.deepEqual(final.missing,[]);assert.ok(Date.now()-start>10000);
      compose('restart','parking-c');await until(async()=>{try{return (await fetch('http://localhost:8003/health')).ok;}catch{return false;}});
      assert.equal(Number(sql('c',"SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'")),31002);
      assert.equal(Number(sql('c',`SELECT count(*) FROM inbox_messages WHERE message_id='${first.body.broadcastId}'`)),1);
      console.log('C late application elapsed ms:',Date.now()-start);
    });
    await t.test('signed expired admin command is recorded as 410, with no late mutation',async()=>{
      const sample=captured[0];const id=sample.properties.messageId.split(':broadcast-')[0]+':broadcast-'+prefix+'-expired';commandIds.push(id);
      const issuedAt=Date.now()-600001,body={...sample.body,payload:rule(99999),issuedAt,deadlineAt:issuedAt+600000};
      const p={...sample.properties,messageId:id,correlationId:id,expiration:'600000',persistent:true,mandatory:true,headers:{...sample.properties.headers}};
      p.headers['x-command-signature']=signature(key,body,p);
      await new Promise((resolve,reject)=>ch.publish('parking.commands','cmd.zone-bac.setPricing',Buffer.from(JSON.stringify(body)),p,e=>e?reject(e):resolve()));
      await until(()=>lower.every(l=>sql(l,`SELECT status_code FROM inbox_messages WHERE message_id='${id}'`)==='410'));
      for(const l of lower)assert.equal(Number(sql(l,"SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'")),31002);
    });
    await t.test('broker expires remaining admin deadline while C is offline; restart cannot apply it',async()=>{
      compose('stop','parking-c');
      const sample=captured[0],id=sample.properties.messageId.split(':broadcast-')[0]+':broadcast-'+prefix+'-broker-expired';commandIds.push(id);
      const deadlineAt=Date.now()+250,body={...sample.body,payload:rule(31003),issuedAt:deadlineAt-600000,deadlineAt};
      const p={...sample.properties,messageId:id,correlationId:id,expiration:'250',persistent:true,mandatory:true,headers:{...sample.properties.headers}};
      p.headers['x-command-signature']=signature(key,body,p);
      await new Promise((resolve,reject)=>ch.publish('parking.commands','cmd.zone-bac.setPricing',Buffer.from(JSON.stringify(body)),p,e=>e?reject(e):resolve()));
      await sleep(1000);compose('start','parking-c');
      await until(async()=>{try{return (await fetch('http://localhost:8003/health')).ok;}catch{return false;}});await sleep(1000);
      assert.equal(Number(sql('c',`SELECT count(*) FROM inbox_messages WHERE message_id='${id}'`)),0);
      assert.equal(Number(sql('c',"SELECT first_block_fee FROM pricing_rules WHERE vehicle_type='CAR'")),31002);
      // Isolated test project only. Consume our expired record without purging the queue.
      let seen=false;
      for(let i=0;i<10;i++){const m=await ch.get('cmd.expired',{noAck:false});if(!m)break;if(m.properties.messageId===id){seen=true;ch.ack(m);}else{ch.nack(m,false,true);break;}}
      assert.equal(seen,true);
    });
    await t.test('management topology: only admin route, quorum/SAC, prefetch 16/4; admin-only endpoints',async()=>{
      const headers={authorization:'Basic '+Buffer.from('parking:parking').toString('base64')};
      const bindings=await (await fetch('http://localhost:15673/api/bindings/%2F',{headers})).json();
      for(const id of ids){assert.equal(bindings.filter(b=>b.source==='parking.commands'&&b.routing_key==='cmd.zone-bac.#'&&b.destination.startsWith(`cmd.${id}`)).length,1);
        assert.ok(bindings.some(b=>b.destination===`cmd.${id}.admin`&&b.routing_key==='cmd.zone-bac.#'));
        const q=await (await fetch(`http://localhost:15673/api/queues/%2F/cmd.${id}.admin`,{headers})).json();assert.equal(q.type,'quorum');assert.equal(q.arguments['x-single-active-consumer'],true);assert.equal(q.effective_policy_definition['message-ttl'],600000);
      }
      const consumers=await until(async()=>{
        const rows=await (await fetch('http://localhost:15673/api/consumers/%2F',{headers})).json();
        return ids.every(id=>rows.some(c=>c.queue.name===`cmd.${id}`&&c.prefetch_count===16)&&rows.some(c=>c.queue.name===`cmd.${id}.admin`&&c.prefetch_count===4))&&rows;
      });
      for(const id of ids){assert.ok(consumers.some(c=>c.queue.name===`cmd.${id}`&&c.prefetch_count===16));assert.ok(consumers.some(c=>c.queue.name===`cmd.${id}.admin`&&c.prefetch_count===4));}
      assert.equal((await api('/api/admin/broadcast',null,{zone:'bac',type:'lockFloor',body:{floor:1,locked:true}})).status,401);
      const user=await login('user1');assert.equal((await api('/api/admin/broadcast',user,{zone:'bac',type:'lockFloor',body:{floor:1,locked:true}})).status,403);
      assert.equal((await api('/api/admin/broadcast',token,{zone:'nam',type:'lockFloor',body:{floor:1,locked:true}})).status,404);
      assert.equal((await api('/api/admin/broadcast',token,{zone:'bac',type:'lockFloor',body:{floor:-1,locked:true}})).status,400);
    });
    await t.test('lockFloor and banPlates persist across node restart; duplicate lock does not increment version',async()=>{
      for(const l of lower){assert.equal(Number(sql(l,'SELECT count(*) FROM parking_slots WHERE floor=99')),0);assert.equal(Number(sql(l,`SELECT count(*) FROM banned_plates WHERE license_plate='${plate}'`)),0);}
      adminFixtures=true;
      for(const l of lower)sql(l,`INSERT INTO parking_slots(slot_code,floor,type) VALUES('${slot}',99,'CAR')`);
      const send=async(type,body,suffix)=>{const r=await api('/api/admin/broadcast',token,{zone:'bac',type,body},prefix+suffix);commandIds.push(r.body.broadcastId);assert.equal(r.status,200);assert.deepEqual(r.body.applied,ids);return r.body;};
      const locked=await send('lockFloor',{floor:99,locked:true},'-lock');
      const wire=captured.find(m=>m.properties.messageId===locked.broadcastId);
      await new Promise((resolve,reject)=>ch.publish('parking.commands','cmd.zone-bac.lockFloor',Buffer.from(JSON.stringify(wire.body)),{...wire.properties,mandatory:true,persistent:true},e=>e?reject(e):resolve()));
      await until(()=>lower.every(l=>Number(sql(l,`SELECT count(*) FROM command_reply_outbox WHERE command_id='${locked.broadcastId}'`))>=2));
      for(const l of lower)assert.equal(Number(sql(l,`SELECT version FROM parking_slots WHERE slot_code='${slot}'`)),1);
      const unmaint=await fetch(`http://localhost:8001/api/slots/${slot}/unmaintenance`,{method:'POST',headers:{'content-type':'application/json','x-internal-key':key},body:'{}'});assert.equal(unmaint.status,409);
      await send('banPlates',{plates:[plate],banned:true},'-ban');
      compose('restart','parking-a');await until(async()=>{try{return (await fetch('http://localhost:8001/health')).ok;}catch{return false;}});
      assert.equal(sql('a',`SELECT status FROM parking_slots WHERE slot_code='${slot}'`),'MAINTENANCE');
      assert.equal(Number(sql('a',`SELECT count(*) FROM banned_plates WHERE license_plate='${plate}'`)),1);
      const denied=await fetch('http://localhost:8001/api/reservations',{method:'POST',headers:{'content-type':'application/json','x-internal-key':key},body:JSON.stringify({requestId:prefix+'-guard',userId:'test',slotCode:slot,licensePlate:plate})});assert.equal(denied.status,403);
      await send('banPlates',{plates:[plate],banned:false},'-unban');await send('lockFloor',{floor:99,locked:false},'-unlock');
    });
  }finally{
    compose('start','parking-a','parking-c');await ch?.close().catch(()=>{});await conn?.close().catch(()=>{});
    for(const id of lower){for(const r of old[id])sql(id,`UPDATE pricing_rules SET first_block_min=${r.first_block_min},first_block_fee=${r.first_block_fee},next_hour_fee=${r.next_hour_fee},overnight_fee=${r.overnight_fee},max_day_fee=${r.max_day_fee??'NULL'} WHERE vehicle_type='${r.vehicle_type}'`);
      if(adminFixtures)sql(id,`DELETE FROM admin_locked_slots WHERE slot_id IN (SELECT id FROM parking_slots WHERE slot_code='${slot}'); DELETE FROM admin_floor_locks WHERE floor=99; DELETE FROM parking_events WHERE slot_code='${slot}'; DELETE FROM parking_slots WHERE slot_code='${slot}'; DELETE FROM banned_plates WHERE license_plate='${plate}'`);
      for(const command of commandIds){sql(id,`DELETE FROM command_reply_outbox WHERE command_id='${command}'; DELETE FROM inbox_messages WHERE message_id='${command}'`);}}
    for(const command of commandIds)sql('agg',`DELETE FROM admin_broadcast_results WHERE broadcast_id='${command}'; DELETE FROM admin_broadcasts WHERE id='${command}'`);
  }
});
test('TC61 Nam D/E/F', {skip:'Blocked: PD-03 not merged and dev has no D/E/F services or authoritative zone data'},()=>{});
