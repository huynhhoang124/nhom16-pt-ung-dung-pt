import { useEffect, useRef, useState } from 'react';
import { api, message, session } from '../api.js';
import './Broadcast.css';

const EXAMPLES = {
  setPricing: { rules: [{ vehicleType:'CAR',firstBlockMin:120,firstBlockFee:25000,nextHourFee:10000,overnightFee:30000,maxDayFee:150000 }] },
  lockFloor: { floor:1,locked:true },
  banPlates: { plates:['30A-123.45'],banned:true },
};
export default function Broadcast() {
  const [zones,setZones]=useState([]),[zone,setZone]=useState('all'),[type,setType]=useState('setPricing');
  const [body,setBody]=useState(JSON.stringify(EXAMPLES.setPricing,null,2));
  const [result,setResult]=useState(null),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  const identity=session.get()?.user?.id ?? session.get()?.user?.sub ?? session.get()?.token;
  // Only command ID is retained, scoped to the authenticated session. No plates or command payload in storage.
  const storageKey=`parking.broadcast.${identity?.slice(-24)??'anonymous'}`;
  const request=useRef(null);
  useEffect(()=>{
    api('/api/admin/broadcast/zones').then(r=>{if(r.ok)setZones(r.data);});
    try{const id=sessionStorage.getItem(storageKey);if(id)api(`/api/admin/broadcast/${encodeURIComponent(id)}`).then(r=>{if(r.ok)setResult(r.data);});}catch{/* storage disabled */}
  },[storageKey]);
  useEffect(()=>{
    if(!result?.broadcastId||!result.missing.length||result.expired)return;
    const id=result.broadcastId;
    const timer=setInterval(()=>api(`/api/admin/broadcast/${encodeURIComponent(id)}`).then(r=>{if(r.ok)setResult(r.data);}),2000);
    return()=>clearInterval(timer);
  },[result?.broadcastId,result?.missing.length,result?.expired]);
  async function send(e) {
    e.preventDefault();let payload;
    try{payload=JSON.parse(body);}catch{setNote('Payload phải là JSON hợp lệ.');return;}
    const input={zone,type,body:payload}, fingerprint=JSON.stringify(input);
    if(request.current?.fingerprint!==fingerprint)request.current={fingerprint,key:crypto.randomUUID()};
    setBusy(true);setNote('Đang gom phản hồi, tối đa 5 giây…');
    const r=await api('/api/admin/broadcast',{method:'POST',body:input,headers:{'Idempotency-Key':request.current.key}});
    setBusy(false);
    if(r.ok||r.data?.broadcastId){setResult(r.data);setNote('');try{sessionStorage.setItem(storageKey,r.data.broadcastId);}catch{/* storage disabled */}}
    else setNote(r.data?.error==='ADMIN_BROADCAST_NOT_READY'?'Kênh quản trị chưa sẵn sàng. Cần tích hợp consumer PD-02/PD-03 trước khi bật.':message(r.data));
  }
  return <section className="card">
    <h3>Phát lệnh quản trị theo vùng</h3>
    <p className="muted">Lệnh có hạn 10 phút. Kết quả tự cập nhật; bãi chưa phản hồi vẫn có thể áp dụng sau đó.</p>
    <form className="broadcast-form" onSubmit={send}>
      <label>Vùng <select value={zone} onChange={e=>setZone(e.target.value)}><option value="all">Tất cả bãi đã đăng ký</option>{zones.map(z=><option key={z}>{z}</option>)}</select></label>
      <label>Loại lệnh <select value={type} onChange={e=>{setType(e.target.value);setBody(JSON.stringify(EXAMPLES[e.target.value],null,2));}}>
        <option value="setPricing">Đổi bảng giá</option><option value="lockFloor">Khóa / mở tầng</option><option value="banPlates">Cấm / bỏ cấm biển số</option></select></label>
      <label className="broadcast-payload">Payload JSON <textarea aria-label="Payload quản trị" rows={10} value={body} onChange={e=>setBody(e.target.value)} spellCheck={false}/></label>
      <button className="primary" disabled={busy}>{busy?'Đang xử lý…':'Gửi lệnh'}</button>
    </form>
    {note&&<p role="status">{note}</p>}
    {result&&<div aria-live="polite">
      <p><strong>{result.applied.length}/{result.total} bãi đã áp dụng{result.missing.length?`, bãi ${result.missing.join(', ')} chưa phản hồi`:''}</strong></p>
      <p className="muted">Lệnh {result.type} · Vùng {result.zone}</p>
      <p className="muted" style={{overflowWrap:'anywhere'}}>Mã lệnh: {result.broadcastId} · Gửi: {result.publishState}</p>
      {result.expired&&result.missing.length>0&&<p>Đã hết hạn; các bãi chưa phản hồi chưa có bằng chứng áp dụng. Hãy kiểm tra lại kết quả.</p>}
      <div className="scroll"><table><thead><tr><th>Bãi</th><th>Kết quả</th></tr></thead><tbody>{result.targets.map(id=><tr key={id}><td>{id}</td><td>{result.applied.includes(id)?'Đã áp dụng':result.rejected.find(r=>r.parkingId===id)?`Từ chối: ${result.rejected.find(r=>r.parkingId===id).error}`:'Chưa phản hồi'}</td></tr>)}</tbody></table></div>
      <button type="button" onClick={()=>api(`/api/admin/broadcast/${encodeURIComponent(result.broadcastId)}`).then(r=>{if(r.ok)setResult(r.data);})}>Xem kết quả cập nhật</button>
      {!result.missing.length&&<button type="button" onClick={()=>{request.current=null;setResult(null);try{sessionStorage.removeItem(storageKey);}catch{/* storage disabled */}}}>Soạn lệnh mới</button>}
    </div>}
  </section>;
}
