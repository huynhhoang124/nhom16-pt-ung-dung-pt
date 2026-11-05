import {useEffect,useState} from 'react';
import {commandTracker} from './api.js';
export default function CommandStatus({userId}){
  const [rows,setRows]=useState([]);
  useEffect(()=>commandTracker.subscribe(setRows),[userId]);
  return <div aria-live="polite">{rows.map(r=><p className="banner" style={{overflowWrap:'anywhere'}} key={r.commandId}>
    {r.status==='PENDING'?(r.uncertain?'Đang xác minh trạng thái lệnh':'Đang xử lý'):r.status==='DONE'?'Đã hoàn tất':r.status==='EXPIRED'?'Lệnh đã hết hạn':'Lệnh không thành công'} · {r.commandId}
    {r.status!=='PENDING'&&<button className="link" onClick={()=>commandTracker.dismiss(r.commandId)}>Đóng</button>}
  </p>)}</div>;
}
