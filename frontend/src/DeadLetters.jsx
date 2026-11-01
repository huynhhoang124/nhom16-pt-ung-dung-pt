import { useEffect, useState } from 'react';
import { api, message } from './api.js';
import './DeadLetters.css';

export default function DeadLetters() {
  const [items,setItems]=useState([]),[offset,setOffset]=useState(0),[selected,setSelected]=useState(null);
  const [edit,setEdit]=useState(false),[payload,setPayload]=useState('{}'),[type,setType]=useState('reserve');
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false);
  async function load() {
    const r=await api(`/api/admin/dlq?limit=20&offset=${offset}`);
    if(r.ok)setItems(r.data.items);else setNote(message(r.data));
  }
  useEffect(()=>{load();const timer=setInterval(load,5000);return()=>clearInterval(timer);},[offset]);
  function select(row){setSelected(row);setEdit(false);setPayload('{}');setType(row.type??'reserve');setNote('');}
  async function replay(e){
    e.preventDefault();let body={};
    if(edit){try{body={type,payload:JSON.parse(payload)};}catch{setNote('Dữ liệu phải là JSON hợp lệ.');return;}}
    setBusy(true);
    const r=await api(`/api/admin/dlq/${selected.id}/replay`,{method:'POST',body});
    setNote(r.ok?`Đã lưu yêu cầu đẩy lại ${r.data.messageId}. Theo dõi trạng thái trong bảng; broker confirm chưa xác nhận xử lý nghiệp vụ.`:message(r.data));
    setBusy(false);if(r.ok)setSelected(null);load();
  }
  return <section className="card dead-letters">
    <h3>Lệnh lỗi</h3>
    <p>Dữ liệu nhạy cảm được che. Đẩy lại giữ khoá chống trùng; sửa dữ liệu chỉ áp dụng cho lệnh bị từ chối trước nghiệp vụ.</p>
    <div className="scroll"><table><thead><tr><th>ID</th><th>Bãi</th><th>Loại</th><th>Lý do</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
      <tbody>{items.map(row=><tr key={row.id}><td>{row.id}</td><td>{row.parkingId??'—'}</td><td>{row.type??'Không đọc được'}</td><td>{row.reason}</td><td>{row.status}</td><td><button onClick={()=>select(row)}>Xem chi tiết</button></td></tr>)}</tbody></table></div>
    {!items.length&&<p>Không có lệnh lỗi trong trang này.</p>}
    <button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-20))}>Trang trước</button>{' '}
    <button disabled={items.length<20} onClick={()=>setOffset(offset+20)}>Trang sau</button>
    {selected&&<form className="dlq-editor" onSubmit={replay}>
      <h4>Lệnh #{selected.id}</h4>
      <p>Khoá: {selected.messageId??'—'} · {selected.routingKey} · {selected.reason}</p>
      <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(selected.payload,null,2)}</pre>
      <label><input type="checkbox" checked={edit} onChange={e=>setEdit(e.target.checked)}/> Sửa dữ liệu trước khi đẩy lại</label>
      {edit&&<><p>Nhập đầy đủ payload mới, gồm biển số thật nếu đặt chỗ. Không nhập token, actor hoặc thông tin quyền.</p>
        <select aria-label="Loại lệnh" value={type} onChange={e=>setType(e.target.value)}><option value="reserve">Đặt chỗ</option><option value="cancel">Huỷ đặt chỗ</option><option value="pay">Thanh toán</option></select>
        <textarea aria-label="Payload JSON" rows={8} value={payload} onChange={e=>setPayload(e.target.value)} required/></>}
      <button disabled={busy||selected.status!=='READY'}>Đẩy lại</button>
      <button type="button" onClick={()=>setSelected(null)}>Đóng</button>
    </form>}
    {note&&<p role="status">{note}</p>}
  </section>;
}
