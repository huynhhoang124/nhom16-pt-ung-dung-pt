const test=require('node:test'),assert=require('node:assert/strict');
const {enrichReply}=require('../src/reply-envelope');const {verifySignature}=require('../src/command-signature');
test('reply enriched/signed on transaction client with slot version and correlation/trace intact',async()=>{
  let queries=0;const c={query:async(sql,p)=>{queries++;assert.match(sql,/parking_slots/);assert.deepEqual(p,['A01']);return {rows:[{slot_code:'A01',status:'RESERVED',version:'7'}]};}};
  const payload={type:'COMMAND_RESULT',traceparent:'trace'},properties={messageId:'reply',correlationId:'u:key',type:'COMMAND_RESULT',headers:{traceparent:'trace'}};
  await enrichReply(c,{type:'reserve',payload:{slotCode:'A01'}},payload,properties,'key');assert.equal(queries,1);assert.equal(payload.slot.version,7);
  assert.equal(properties.correlationId,'u:key');assert.equal(properties.headers.traceparent,'trace');
  assert.ok(verifySignature('key',payload,{...properties,headers:{'x-command-signature':properties.headers['x-reply-signature']}}));
});
test('business failure on malformed UUID does not abort transaction again',async()=>{
  const c={query:async()=>{throw new Error('must not issue invalid UUID SQL');}},payload={statusCode:404},properties={headers:{}};
  await enrichReply(c,{type:'cancel',payload:{reservationId:'bad'}},payload,properties,'key');assert.equal(payload.slot,undefined);assert.ok(properties.headers['x-reply-signature']);
});
