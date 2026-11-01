const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {mountReplayClaim}=require('../src/replay-claim');
test('replay claim fails closed without inbox, fences original atomically, refuses existing business result',async t=>{
  const db=new PGlite(),pool={query:(s,p)=>db.query(s,p)},app=express();app.use(express.json());mountReplayClaim(app,{pool,internalKey:'key'});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();});
  const call=(messageId,replayMessageId,key='key')=>fetch(`http://127.0.0.1:${server.address().port}/api/internal/commands/replay-claim`,{method:'POST',headers:{'x-internal-key':key,'content-type':'application/json'},body:JSON.stringify({messageId,replayMessageId})});
  assert.equal((await call('u:key','u:replay-one','wrong')).status,403);
  assert.equal((await call('u:key','u:replay-one')).status,503);
  await db.exec('CREATE TABLE inbox_messages(message_id TEXT PRIMARY KEY,command_type TEXT,request_hash TEXT,result JSONB,status_code INT,processed_at TIMESTAMPTZ)');
  assert.equal((await call('u:key','u:replay-one')).status,200);
  assert.equal((await call('u:key','u:replay-one')).status,200);
  assert.equal((await call('u:key','u:replay-two')).status,409);
  await db.query("INSERT INTO inbox_messages(message_id,request_hash,result,status_code) VALUES('u:done','business-hash','{}',201)");
  assert.equal((await call('u:done','u:replay-three')).status,409);
  assert.equal((await db.query("SELECT request_hash FROM inbox_messages WHERE message_id='u:done'")).rows[0].request_hash,'business-hash');
});
