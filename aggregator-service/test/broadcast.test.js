const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const express=require('express'),http=require('node:http');
const {PGlite}=require('@electric-sql/pglite');
const {makeBroadcasts,snapshotTargets,TTL}=require('../src/broadcast');
const {mountBroadcasts}=require('../src/broadcast-runtime');
const {signature}=require('../src/command-signature');
const {makeAuth}=require('../src/auth');
const reg={all:()=>[{id:'A'},{id:'B'},{id:'C',status:'OFFLINE'}],get:id=>({id})},zones={A:'bac',B:'bac',C:'bac'};
const input={zone:'bac',type:'lockFloor',body:{floor:1,locked:true}},actor={userId:'admin',role:'ADMIN'};
const reply=(id,parkingId,code=200)=>{
  const b={schemaVersion:1,type:'COMMAND_RESULT',commandType:'lockFloor',commandId:id,parkingId,actor,statusCode:code,result:code<400?{applied:true}:{error:'FLOOR_IN_USE'}};
  const p={messageId:`reply-${parkingId}`,correlationId:id,type:'COMMAND_RESULT',headers:{}};
  p.headers['x-reply-signature']=signature('key',b,p);
  return {content:Buffer.from(JSON.stringify(b)),properties:p};
};
test('target snapshot includes offline lots; unknown zone and no ordinary/admin double routing',()=>{
  assert.deepEqual(snapshotTargets(reg,zones,'bac'),['A','B','C']);assert.throws(()=>snapshotTargets(reg,zones,'nam'),{code:'ZONE_NOT_FOUND'});
  const d=JSON.parse(fs.readFileSync(path.join(__dirname,'../../rabbitmq/definitions.json')));
  for(const id of ['A','B','C'])for(const key of ['cmd.zone-bac.#','cmd.all.#']){
    const targets=d.bindings.filter(b=>b.routing_key===key&&b.destination.startsWith(`cmd.${id}`));
    assert.deepEqual(targets.map(b=>b.destination),[`cmd.${id}.admin`]);
  }
  assert.equal(d.policies.find(p=>p.name==='admin-command-delivery').definition['message-ttl'],TTL);
  const nodeValidate=require('../../parking-node/src/admin-payload').validateAdmin;
  const validate=require('../src/admin-payload').validateAdmin;
  for(const [type,body] of [['lockFloor',{floor:1,locked:true}],['lockFloor',{floor:1,locked:1}],['banPlates',{plates:['30A-123.45'],banned:true}],['setPricing',{rules:[{vehicleType:'CAR',firstBlockMin:1,firstBlockFee:2,nextHourFee:3,overnightFee:4,maxDayFee:10000001}]}]])assert.equal(validate(type,body),nodeValidate(type,body));
});
test('persistent snapshot, per-lot dedup and late replies, key reuse, unknown publish, admin authorization',async()=>{
  const db=new PGlite();const query=async(sql,p)=>{const r=p?await db.query(sql,p):(await db.exec(sql)).at(-1);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};};
  const pool={query,connect:async()=>({query,release(){}})};
  await query(fs.readFileSync(path.join(__dirname,'../src/broadcast-schema.sql'),'utf8'));
  let sends=0,mode='ok',captured;
  const f=makeBroadcasts({pool,reg,zones,enabled:true,internalKey:'key',waitMs:30,publisher:{async send(...args){sends++;captured=args;if(mode==='unknown')throw Object.assign(new Error(),{code:'PUBLISH_NACKED'});}}});
  f.setReady(true);
  let server;
  try{
    const v=await f.submit(input,actor,'one');assert.equal(sends,1);assert.equal(v.missing.length,3);
    assert.equal(captured[0],'zone-bac');assert.equal(captured[3].deadlineAt-captured[3].issuedAt,TTL);assert.equal(captured[3].replyTo,'agg.broadcast');
    assert.equal(await f.handle(reply(v.broadcastId,'A')),true);assert.equal(await f.handle(reply(v.broadcastId,'A')),true);
    await f.handle(reply(v.broadcastId,'B',409));assert.equal(await f.handle(reply(v.broadcastId,'Z')),false);
    let view=await f.get(v.broadcastId);assert.deepEqual(view.applied,['A']);assert.deepEqual(view.missing,['C']);assert.equal(view.rejected[0].parkingId,'B');
    assert.equal(await f.handle(reply(v.broadcastId,'A',409)),false);assert.deepEqual((await f.get(v.broadcastId)).applied,['A']);
    await f.handle(reply(v.broadcastId,'C'));view=await f.submit(input,actor,'one');assert.equal(sends,1);assert.deepEqual(view.applied,['A','C']);
    await assert.rejects(f.submit({...input,body:{floor:2,locked:true}},actor,'one'),{code:'IDEMPOTENCY_KEY_REUSED'});
    await assert.rejects(f.submit({...input,body:{floor:1,locked:'yes'}},actor,'bad'),{status:400});
    await assert.rejects(f.submit({...input,zone:'nam'},actor,'nam'),{status:404});
    mode='unknown';const unknown=await f.submit(input,actor,'unknown');assert.equal(unknown.publishState,'UNKNOWN');assert.equal(unknown.applied.length,0);
    const app=express();app.use(express.json());const auth=makeAuth('jwt');mountBroadcasts(app,{need:auth.need,broadcasts:f});
    server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url+'/api/admin/broadcast/zones')).status,401);
    const jwt=require('jsonwebtoken');
    for(const role of ['USER','STAFF'])assert.equal((await fetch(url+'/api/admin/broadcast/zones',{headers:{authorization:`Bearer ${jwt.sign({sub:'u',role},'jwt')}`}})).status,403);
    const response=await fetch(url+`/api/admin/broadcast/${encodeURIComponent(v.broadcastId)}`,{headers:{authorization:`Bearer ${jwt.sign({sub:'admin',role:'ADMIN'},'jwt')}`}});
    assert.equal(response.status,200);assert.equal((await response.json()).total,3);
  }finally{if(server)await new Promise(r=>server.close(r));await f.stop();await db.close();}
});
