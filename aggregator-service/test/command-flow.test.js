const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {makeCommandFlow}=require('../src/command-flow');
const {makeReplyBatch,makeReplyHandler}=require('../src/command-replies');
const {signature}=require('../src/command-signature');
const {applyEvent}=require('../src/events');
const user={sub:'user',role:'USER'},request={parkingId:'A',type:'reserve',user,payload:{slotCode:'A01'},key:'key',traceparent:'00-11111111111111111111111111111111-2222222222222222-01'};
test('instance ID cannot collide with the durable recovery queue',()=>assert.throws(()=>makeCommandFlow({instanceId:'recovery'}),{code:'INVALID_AGGREGATOR_ID'}));
async function completed(flow){const end=Date.now()+3000;while(Date.now()<end){const row=await flow.get('user:key');if(row.status==='DONE')return row;await new Promise(r=>setTimeout(r,20));}throw new Error('command did not complete');}
function reply(opts,result={id:'reservation'},code=201){
  const b={schemaVersion:1,type:'COMMAND_RESULT',commandType:'reserve',commandId:opts.messageId,parkingId:'A',actor:opts.actor,
    statusCode:code,result,traceparent:opts.traceparent,slot:{slotCode:'A01',status:'RESERVED',version:2}};
  const properties={messageId:'reply',correlationId:opts.correlationId,type:'COMMAND_RESULT',headers:{traceparent:opts.traceparent}};
  properties.headers['x-reply-signature']=signature('key',b,properties);
  return {content:Buffer.from(JSON.stringify(b)),properties};
}
async function setup(t,options={}){
  const db=new PGlite();await db.exec(fs.readFileSync(path.join(__dirname,'../src/schema.sql'),'utf8'));
  const query=async(s,p)=>{const r=await db.query(s,p);return {...r,rowCount:r.affectedRows??r.rows.length};};
  const pool={query,connect:async()=>({query,release(){}})},calls=[],cache=new Map();let behaviour;
  const publisher={send:async(_p,_t,_b,opts)=>{calls.push(opts);return behaviour(opts);}};
  const flow=makeCommandFlow({pool,publisher,instanceId:'1',waitMs:3000,...options});
  const handle=makeReplyHandler({pool,cache,internalKey:'key',signal:flow.signal});
  behaviour=opts=>handle(reply(opts));flow.setReady(true);flow.start();
  t.after(async()=>{await flow.stop();await db.close();});
  return {db,pool,flow,handle,calls,cache,set(fn){behaviour=fn;}};
}
test('reply before publisher confirm releases request; same key yields same command and result, mismatch 422',async t=>{
  const {flow,calls,cache}=await setup(t);
  const a=await flow.execute(request);assert.equal(a.code,201);assert.equal(a.body.commandId,'user:key');
  assert.deepEqual(await flow.execute(request),a);assert.equal(calls.length,1);assert.equal(flow.pending.size,0);
  assert.equal(calls[0].messageId,calls[0].correlationId);assert.equal(calls[0].replyTo,'agg.1');assert.equal(calls[0].traceparent,request.traceparent);
  await assert.rejects(flow.execute({...request,payload:{slotCode:'A02'}}),{code:'IDEMPOTENCY_KEY_REUSED'});
  applyEvent(cache,{parkingId:'A',slot:'A01',status:'AVAILABLE',version:1});assert.equal(cache.get('A:A01').status,'RESERVED');
});
test('concurrent intents share one durable insert and preserve idempotency', async (t) => {
  const { flow, pool, calls } = await setup(t);
  const query = pool.query;
  let insertions = 0;
  pool.query = (sql, params) => {
    if (sql.includes('INSERT INTO commands')) insertions++;
    return query(sql, params);
  };

  const [first, replay, collision, distinct] = await Promise.allSettled([
    flow.execute(request),
    flow.execute(request),
    flow.execute({ ...request, payload: { slotCode: 'A02' } }),
    flow.execute({ ...request, key: 'next' }),
  ]);

  assert.equal(insertions, 1);
  assert.equal(first.value.code, 201);
  assert.deepEqual(replay.value, first.value);
  assert.equal(collision.reason.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(distinct.value.code, 201);
  assert.deepEqual(calls.map((call) => call.messageId), ['user:key', 'user:next']);
});

test('an invalid database value does not reject other intents in its batch', async (t) => {
  const { flow } = await setup(t);
  const [invalid, valid] = await Promise.allSettled([
    flow.execute({ ...request, payload: { slotCode: '\u0000' } }),
    flow.execute({ ...request, key: 'valid' }),
  ]);
  assert.equal(invalid.reason.code, 'COMMAND_PERSISTENCE_UNKNOWN');
  assert.equal(valid.value.code, 201);
  assert.equal(valid.value.body.commandId, 'user:valid');
});

test('reply batches wait for the shared COMMIT before exposing either result', { timeout: 1000 }, async () => {
  const commands = [];
  const commit = Promise.withResolvers();
  const pool = { async connect() {
    return {
      async query(sql, params) {
        commands.push(params?.[0] ?? sql);
        if (sql === 'COMMIT') return commit.promise;
        return params?.[0];
      },
      release() {},
    };
  } };
  const persist = makeReplyBatch(pool);
  let completed = 0;
  const first = persist('UPDATE', ['z']).then((value) => { completed++; return value; });
  const second = persist('UPDATE', ['a']).then((value) => { completed++; return value; });
  try {
    while (!commands.includes('COMMIT')) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(commands, ['BEGIN', 'a', 'z', 'COMMIT']);
    assert.equal(completed, 0);
  } finally {
    commit.resolve();
  }
  assert.deepEqual(await Promise.all([first, second]), ['z', 'a']);
});

test('a failed reply batch rolls back every result and permits redelivery', async () => {
  const commands = [];
  let fail = true;
  const pool = { async connect() {
    return {
      async query(sql, args) {
        commands.push(sql);
        if (args && fail) throw new Error('database write failed');
        return { rows: [] };
      },
      release() {},
    };
  } };
  const persist = makeReplyBatch(pool);
  const results = await Promise.allSettled([persist('UPDATE', ['a']), persist('UPDATE', ['b'])]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.ok(commands.includes('ROLLBACK'));
  assert.ok(!commands.includes('COMMIT'));
  fail = false;
  assert.deepEqual(await persist('UPDATE', ['a']), { rows: [] });
  assert.equal(commands.at(-1), 'COMMIT');
});

test('unknown publish stays PENDING/202; retry preserves identity and deadline',async t=>{
  const {flow,set,calls,pool,handle}=await setup(t,{waitMs:30});
  set(()=>{throw Object.assign(new Error('disconnect'),{code:'PUBLISH_UNKNOWN_RESULT'});});
  const a=await flow.execute(request);assert.equal(a.code,202);let row=await flow.get('user:key');assert.equal(row.status,'PENDING');assert.equal(row.uncertain,true);
  set(opts=>handle(reply(opts)));await pool.query("UPDATE commands SET next_publish_at=now()-interval '1 second'");await flow.pump();
  row=await completed(flow);assert.equal(row.status,'DONE');assert.equal(calls[1].messageId,calls[0].messageId);assert.equal(calls[1].deadlineAt,calls[0].deadlineAt);
});
test('definite mandatory return is FAILED_TO_SEND; safe retry uses original row/ID',async t=>{
  const {flow,set,handle}=await setup(t);set(()=>{throw Object.assign(new Error('return'),{code:'PARKING_NOT_FOUND',status:404});});
  const a=await flow.execute(request);assert.equal(a.code,404);assert.equal(a.body.sendStatus,'FAILED_TO_SEND');
  set(opts=>handle(reply(opts)));const b=await flow.execute(request);assert.equal(b.code,201);assert.equal(b.body.commandId,a.body.commandId);
});
test('duplicate and conflicting late replies cannot overwrite terminal result; correlation/actor/signature checked',async t=>{
  const {flow,handle,calls}=await setup(t);await flow.execute(request);const before=await flow.get('user:key');
  assert.equal(await handle(reply(calls[0])),true);assert.equal(await handle(reply(calls[0],{id:'different'})),false);
  assert.equal(await handle(reply({...calls[0],correlationId:'wrong'})),false);
  assert.equal(await handle(reply({...calls[0],actor:{userId:'attacker',role:'ADMIN'}})),false);
  const bad=reply(calls[0]);bad.content=Buffer.from('{}');assert.equal(await handle(bad),false);
  const after=await flow.get('user:key');assert.deepEqual(after.result,before.result);assert.equal(after.updated_at.getTime(),before.updated_at.getTime());
});
test('durable intent survives crash after claim before send; expired lease safely republishes',async t=>{
  let once=true;const {flow,pool,calls}=await setup(t,{waitMs:30,leaseMs:5000,afterClaim:()=>{if(once){once=false;throw new Error('test crash');}}});
  assert.equal((await flow.execute(request)).code,202);assert.equal(calls.length,0);
  await pool.query("UPDATE commands SET publish_lease_until=now()-interval '1 second'");await flow.pump();assert.equal((await completed(flow)).status,'DONE');assert.equal(calls.length,1);
});
test('shutdown resolves outstanding waiters as accepted, never failed transaction',async t=>{
  const {flow,set}=await setup(t);set(()=>{});const p=flow.execute(request);await new Promise(r=>setTimeout(r,10));await flow.stop();assert.equal((await p).code,202);assert.equal(flow.pending.size,0);
});

test('DB insert acknowledgement loss preserves the same ID as unknown, recovered intent can still finish',async t=>{
  const {flow,pool}=await setup(t);const original=pool.query;let first=true;
  pool.query=async(s,p)=>{const out=await original(s,p);if(first&&s.includes('INSERT INTO commands')){first=false;throw new Error('DB connection lost after commit');}return out;};
  await assert.rejects(flow.execute(request),e=>e.code==='COMMAND_PERSISTENCE_UNKNOWN'&&e.commandId==='user:key'&&e.unknown===true);
  assert.equal((await completed(flow)).id,'user:key');assert.equal((await flow.execute(request)).body.commandId,'user:key');
});

test('crash after broker confirm before durable send update recovers with identical ID/deadline',async t=>{
  let crash=true;const f=await setup(t,{waitMs:30,afterPublish:()=>{if(crash){crash=false;throw new Error('test exit after confirm');}}});
  f.set(()=>{});assert.equal((await f.flow.execute(request)).code,202);
  assert.equal((await f.flow.get('user:key')).publish_state,'UNKNOWN');
  f.set(opts=>f.handle(reply(opts)));await f.pool.query("UPDATE commands SET next_publish_at=now()-interval '1 second'");
  await f.flow.pump();await completed(f.flow);
  assert.equal(f.calls[0].messageId,f.calls[1].messageId);assert.equal(f.calls[0].deadlineAt,f.calls[1].deadlineAt);
});
test('DLQ failure finishes a PENDING command and signals its waiting request', async t => {
  const results = [];
  const { flow, set } = await setup(t, { onResult: row => results.push(row) });
  set(opts => flow.markFailed(opts.messageId, 'RETRY_EXHAUSTED'));
  const response = await flow.execute(request);
  const row = await flow.get('user:key');
  assert.equal(response.code, 500);
  assert.equal(response.body.error, 'RETRY_EXHAUSTED');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.failure_phase, 'EXECUTION');
  assert.equal(row.last_error, 'RETRY_EXHAUSTED');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, row.id);
  assert.equal(flow.pending.size, 0);
});
test('DLQ failure cannot overwrite a DONE command or signal it again', async t => {
  const results = [];
  const { flow } = await setup(t, { onResult: row => results.push(row) });
  await flow.execute(request);
  const before = await flow.get('user:key');
  await flow.markFailed(before.id, 'RETRY_EXHAUSTED');
  assert.deepEqual(await flow.get(before.id), before);
  assert.equal(results.length, 1);
});

test('reply topology not ready prevents publish; retry after recovery retains the same command',async t=>{
  const f=await setup(t);f.flow.setReady(false);
  const rejected=await f.flow.execute(request);assert.equal(rejected.code,503);assert.equal(rejected.body.sendStatus,'FAILED_TO_SEND');assert.equal(f.calls.length,0);
  f.flow.setReady(true);const done=await f.flow.execute(request);assert.equal(done.code,201);assert.equal(done.body.commandId,rejected.body.commandId);
});

test('publisher sends the next command before an earlier broker confirm arrives', async t => {
  const f = await setup(t, { waitMs: 1000 });
  f.flow.setReady(false);
  // Prepare queued durable rows without starting the worker.
  const create = (id, createdAt) => f.pool.query(
    `INSERT INTO commands(id, parking_id, type, user_id, request_hash, payload, actor, envelope, correlation_id, reply_to, created_at)
     VALUES ($1, 'A', 'reserve', 'user', 'hash', '{}', '{"userId":"user","role":"USER"}',
             $2, $1, 'agg.1', $3)`,
    [id, { issuedAt: Date.now(), deadlineAt: Date.now() + 10000 }, createdAt],
  );
  await create('user:batch-z', '2026-11-08T00:00:00.000001Z');
  await create('user:batch-a', '2026-11-08T00:00:00.000002Z');
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.set(async opts => {
    if (opts.messageId === 'user:batch-z') await blocked;
    await f.handle(reply(opts));
  });
  f.flow.setReady(true);
  const pumping = f.flow.pump();
  try {
    const deadline = Date.now() + 1000;
    while (f.calls.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(f.calls.map(call => call.messageId), ['user:batch-z', 'user:batch-a']);
    assert.equal((await f.flow.get('user:batch-z')).status, 'PENDING');
  } finally {
    release();
    await pumping;
  }
  assert.equal((await f.flow.get('user:batch-z')).status, 'DONE');
  assert.equal((await f.flow.get('user:batch-a')).status, 'DONE');
});

test('batch persistence confirms only successful publishes and retains uncertain attempts', async t => {
  const f = await setup(t);
  f.flow.setReady(false);
  const before = (await f.pool.query('SHOW synchronous_commit')).rows;
  await f.pool.query(`INSERT INTO commands(id,parking_id,type,user_id,request_hash,payload,actor,envelope,correlation_id,reply_to)
    SELECT id,'A','reserve','user','hash','{}','{"userId":"user","role":"USER"}',$1,id,'agg.1'
    FROM unnest(ARRAY['user:good','user:unknown']) id`,
    [{ issuedAt: Date.now(), deadlineAt: Date.now() + 10000 }]);
  f.set(async opts => {
    if (opts.messageId === 'user:unknown') throw Object.assign(new Error('lost confirm'), { code: 'PUBLISH_UNKNOWN_RESULT' });
  });
  f.flow.setReady(true);
  await f.flow.pump();
  const good = await f.flow.get('user:good'), unknown = await f.flow.get('user:unknown');
  assert.deepEqual((await f.pool.query('SHOW synchronous_commit')).rows, before);
  assert.equal(good.publish_state, 'CONFIRMED');
  assert.equal(good.publish_lease_until, null);
  assert.equal(good.status, 'PENDING', 'publisher confirm is not a business result');
  assert.equal(unknown.publish_state, 'UNKNOWN');
  assert.equal(unknown.uncertain, true);
  assert.equal(unknown.status, 'PENDING');
});

test('the committed reply notifies peers once; a redelivery only acknowledges the existing result', async t => {
  const f = await setup(t);
  const received = [];
  await f.db.listen('command_results', payload => received.push(JSON.parse(payload)));
  assert.equal((await f.flow.execute(request)).code, 201);
  const deadline = Date.now() + 1000;
  while (!received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'user:key');
  assert.equal((await f.flow.get(received[0].id)).status, 'DONE');
  assert.equal(await f.handle(reply(f.calls[0])), true);
  assert.equal(received.length, 1);
});
