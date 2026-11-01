const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {makeTransfer}=require('../src/command-transfer');
test('stalled setup times out; late connection retired; shared wire helpers match both service contexts',async()=>{
  let resolve;const stalled=new Promise(r=>resolve=r),pub=makeTransfer('fake',{connect:()=>stalled,timeoutMs:15});
  await assert.rejects(pub('x','a',Buffer.from('a'),{}),/SETUP_TIMEOUT/);
  let closed=false;const conn=new EventEmitter();conn.close=async()=>{closed=true;};resolve(conn);
  await new Promise(r=>setImmediate(r));await pub.close();assert.equal(closed,true);
  const fs=require('node:fs'),path=require('node:path');
  for(const name of ['command-transfer.js','retry-contract.js'])assert.equal(
    fs.readFileSync(path.join(__dirname,'../src',name),'utf8'),fs.readFileSync(path.join(__dirname,'../../aggregator-service/src',name),'utf8'));
});
test('concurrent same messageId maps mandatory return independently of out of order confirms',async()=>{
  const conn=new EventEmitter(),ch=new EventEmitter(),sent=[];conn.createConfirmChannel=async()=>ch;conn.close=async()=>conn.emit('close');
  ch.publish=(...args)=>sent.push(args);
  const pub=makeTransfer('fake',{connect:async()=>conn});
  const a=pub('x','a',Buffer.from('a'),{messageId:'same'}),b=pub('x','b',Buffer.from('b'),{messageId:'same'});
  const rejected=assert.rejects(b,/PUBLISH_RETURNED/);
  await new Promise(r=>setImmediate(r));ch.emit('return',{properties:sent[1][3]});sent[1][4]();sent[0][4]();
  await Promise.all([a,rejected]);await pub.close();
});
test('nack and disconnect are failures; reconnect next call',async()=>{
  const all=[];
  const connect=async()=>{const conn=new EventEmitter(),ch=new EventEmitter();conn.createConfirmChannel=async()=>ch;conn.close=async()=>conn.emit('close');ch.publish=(...args)=>all.push({conn,args});return conn;};
  const pub=makeTransfer('fake',{connect});const a=pub('x','a',Buffer.from('a'),{});const ar=assert.rejects(a,/nacked/);
  await new Promise(r=>setImmediate(r));all[0].args[4](new Error('message nacked'));await ar;
  const b=pub('x','a',Buffer.from('a'),{});const br=assert.rejects(b,/UNKNOWN/);await new Promise(r=>setImmediate(r));all[1].conn.emit('close');await br;
  const c=pub('x','a',Buffer.from('a'),{});await new Promise(r=>setImmediate(r));assert.notEqual(all[2].conn,all[1].conn);all[2].args[4]();await c;await pub.close();
});
