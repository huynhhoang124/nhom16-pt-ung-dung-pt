const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{PGlite}=require('@electric-sql/pglite');
const express=require('express'),jwt=require('jsonwebtoken');
const {makeDlq,mountDlq}=require('../src/dlq');
const {makeAuth}=require('../src/auth');
const {signature,proof}=require('../src/retry-contract');
async function setup(t){
  const db=new PGlite();t.after(()=>db.close());await db.exec(fs.readFileSync(path.join(__dirname,'../src/schema.sql'),'utf8'));
  const query=async(s,p)=>{const r=await db.query(s,p);return {...r,rowCount:r.affectedRows??r.rows.length};};
  const pool={query,connect:async()=>({query,release(){}})},sent=[];
  const dlq=makeDlq({pool,internalKey:'key',publish:async(...args)=>sent.push(args),claimReplay:async()=>{}});
  return {db,pool,dlq,sent};
}
function message(payload={},reason='INVALID_SCHEMA'){
  const b={schemaVersion:1,type:'reserve',parkingId:'A',actor:{userId:'u',role:'USER'},payload};
  const properties={messageId:'u:key',correlationId:'corr',replyTo:'agg.1',type:'reserve',headers:{}};
  properties.headers['x-command-signature']=signature('key',b,properties);
  const content=Buffer.from(JSON.stringify(b));
  Object.assign(properties.headers,{'x-original-routing-key':'cmd.A.reserve','x-failure-reason':reason,'x-dlq-signature':proof('key',content,properties,reason,'cmd.A.reserve')});
  return {content,properties,fields:{routingKey:'dead'}};
}
const valid={slotCode:'A01',licensePlate:'30A-123.45'};
test('persist before ack boundary: duplicate delivery stored once; API projection masks plate and signature',async t=>{
  const {dlq}=await setup(t),m=message(valid);await dlq.store(m);await dlq.store(m);
  const r=await dlq.list();assert.equal(r.items.length,1);assert.equal(r.items[0].payload.licensePlate,'[đã che]');
  assert.ok(!JSON.stringify(r).includes('x-command-signature'));assert.ok(!JSON.stringify(r).includes('30A-123.45'));
});
test('replay edit creates one durable intent, relay retries same ID after publish failure; no inbox deletion',async t=>{
  const {pool,dlq,sent}=await setup(t);await dlq.store(message());const id=(await dlq.list()).items[0].id;
  const r=await dlq.replay(id,{payload:valid},'admin');assert.equal(r.status,'PUBLISHING');assert.match(r.messageId,/^u:replay-/);
  await assert.rejects(dlq.replay(id,{},'admin'),{code:'REPLAY_ALREADY_REQUESTED'});
  const failing=makeDlq({pool,internalKey:'key',publish:async()=>{throw new Error('disconnect');}});
  await assert.rejects(failing.relay());assert.equal((await dlq.list()).items[0].status,'PUBLISHING');
  await dlq.relay();assert.equal(sent[0][3].messageId,r.messageId);assert.equal((await dlq.list()).items[0].status,'BROKER_CONFIRMED');
  assert.equal(JSON.parse(sent[0][2]).actor.userId,'u');
});
test('exhausted retry reuses original ID unchanged; editing cannot force an already committed operation',async t=>{
  const {dlq}=await setup(t);await dlq.store(message(valid,'RETRY_EXHAUSTED'));const id=(await dlq.list()).items[0].id;
  await assert.rejects(dlq.replay(id,{payload:{...valid,slotCode:'A02'}},'admin'),{code:'EDIT_REQUIRES_PRE_EXECUTION_FAILURE'});
  assert.equal((await dlq.replay(id,{},'admin')).messageId,'u:key');
});
test('unverified DLQ and invalid edits rejected; expired pending replay never republished',async t=>{
  const {dlq,pool,sent}=await setup(t);const m=message();delete m.properties.headers['x-command-signature'];await dlq.store(m);
  const id=(await dlq.list()).items[0].id;await assert.rejects(dlq.replay(id,{payload:valid},'admin'),{code:'UNTRUSTED_ENVELOPE'});
  await dlq.store(message(valid,'RETRY_EXHAUSTED'));const id2=(await dlq.list()).items[0].id;
  await dlq.replay(id2,{},'admin');await pool.query("UPDATE dead_letters SET replay_body=jsonb_set(replay_body,'{deadlineAt}','1') WHERE id=$1",[id2]);
  await dlq.relay();assert.equal(sent.length,0);assert.equal((await dlq.list()).items[0].status,'REPLAY_EXPIRED');
});
test('HTTP ADMIN permissions, pagination and validation',async t=>{
  const {dlq}=await setup(t);const app=express();app.use(express.json());mountDlq(app,{dlq,need:makeAuth('secret').need});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}`;
  const call=(path,role,method='GET',body)=>fetch(url+path,{method,headers:{'content-type':'application/json',...(role?{authorization:`Bearer ${jwt.sign({sub:'admin',role},'secret')}`}:{})},body:body&&JSON.stringify(body)});
  assert.equal((await call('/api/admin/dlq')).status,401);assert.equal((await call('/api/admin/dlq','USER')).status,403);
  assert.equal((await call('/api/admin/dlq?limit=101','ADMIN')).status,400);assert.equal((await call('/api/admin/dlq','ADMIN')).status,200);
  assert.equal((await call('/api/admin/dlq/1/replay','USER','POST',{})).status,403);
  assert.equal((await call('/api/admin/dlq/no/replay','ADMIN','POST',{})).status,400);
  assert.equal((await call('/api/admin/dlq/999/replay','ADMIN','POST',{})).status,404);
});
