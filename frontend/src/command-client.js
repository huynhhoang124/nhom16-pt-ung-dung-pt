// Pure client controller; injected dependencies make socket-loss/reload behaviour testable.
export function makeCommandClient({api,socket,storage,user,newKey,digest,intervalMs=1000}){
  const read=(k,f)=>{try{return JSON.parse(storage.getItem(k))??f;}catch{return f;}};
  let records=read('parking.commands',[]),keys=read('parking.commandKeys',{}),timer,busy=false;
  records=Array.isArray(records)?records.filter(r=>r&&typeof r.commandId==='string'&&typeof r.userId==='string'):[];
  if(!keys||typeof keys!=='object'||Array.isArray(keys))keys={};
  const listeners=new Set(),waiting=new Map();
  const snapshot=()=>records.filter(r=>r.userId===user()?.id);
  const save=()=>{try{storage.setItem('parking.commands',JSON.stringify(records));storage.setItem('parking.commandKeys',JSON.stringify(keys));}catch{}for(const cb of listeners)cb(snapshot());};
  const ensure=()=>{if(!timer)timer=setInterval(()=>poll().catch(()=>{}),intervalMs);};
  async function poll(){
    if(busy)return;busy=true;
    try{
      for(const [id,w] of waiting)if(w.userId!==user()?.id){w.resolve({ok:false,status:401,data:{error:'SESSION_CHANGED'}});waiting.delete(id);}
      for(const r of snapshot().filter(x=>x.status==='PENDING')){
        const response=await api(`/api/commands/${encodeURIComponent(r.commandId)}`);
        if(response.ok&&response.data?.status==='PENDING'&&r.uncertain){r.uncertain=false;save();}
        if(!response.ok||!['DONE','FAILED','EXPIRED'].includes(response.data?.status))continue;
        r.status=response.data.status;r.statusCode=response.data.statusCode;
        const result={ok:r.statusCode>=200&&r.statusCode<300,status:r.statusCode??500,data:{...response.data.result,commandId:r.commandId}};
        waiting.get(r.commandId)?.resolve(result);waiting.delete(r.commandId);
        for(const key of Object.keys(keys))if(keys[key].commandId===r.commandId)delete keys[key];
        save();
      }
      if(!snapshot().some(r=>r.status==='PENDING')&&!waiting.size){clearInterval(timer);timer=undefined;}
    }finally{busy=false;}
  }
  async function request(path,opts={},onPending=()=>{}){
    const userId=user()?.id;
    const fingerprint=await digest(JSON.stringify({userId,path,method:opts.method,body:opts.body??null}));
    const key=keys[fingerprint]?.key??opts.headers?.['idempotency-key']??newKey();
    keys[fingerprint]={key};save();
    const r=await api(path,{...opts,headers:{...opts.headers,'idempotency-key':key}});
    if(r.status!==202&&!r.data?.unknown){if(r.status!==0&&r.status!==504){delete keys[fingerprint];save();}return r;}
    const id=r.data.commandId;
    if(typeof id!=='string')return {ok:false,status:502,data:{error:'INVALID_COMMAND_RESPONSE'}};
    keys[fingerprint]={key,commandId:id};
    if(!records.some(x=>x.commandId===id&&x.userId===userId))records.push({commandId:id,userId,status:'PENDING',uncertain:r.data.unknown===true});
    onPending(id);save();
    // Multiple callers waiting on one command share the durable result.
    let resolve;const promise=new Promise(r=>{resolve=r;});
    const prior=waiting.get(id);
    waiting.set(id,{userId,resolve:result=>{prior?.resolve(result);resolve(result);}});
    ensure();poll().catch(()=>{});return promise;
  }
  const event=()=>{ensure();poll().catch(()=>{});};socket.on('COMMAND_RESULT',event);socket.on('connect',event);
  return {request,poll,snapshot,subscribe(cb){listeners.add(cb);cb(snapshot());ensure();poll().catch(()=>{});return()=>listeners.delete(cb);},
    dismiss(id){records=records.filter(r=>r.commandId!==id||r.status==='PENDING');save();},
    close(){clearInterval(timer);socket.off('COMMAND_RESULT',event);socket.off('connect',event);for(const w of waiting.values())w.resolve({ok:false,status:0,data:{error:'CLIENT_STOPPED'}});waiting.clear();}};
}
