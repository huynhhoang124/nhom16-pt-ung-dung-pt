import { useEffect, useState } from 'react';
import L from 'leaflet';
import { CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from './ui.jsx';

// Chọn vị trí bãi trên bản đồ: bấm để cắm ghim, kéo ghim để chỉnh, tìm theo địa chỉ, hoặc lấy vị trí hiện tại.
// Tìm địa chỉ / đổi toạ độ ra địa chỉ dùng Nominatim, dự phòng Photon (đều là OpenStreetMap, miễn phí, có giới hạn
// số lượt) — nên chỉ gọi khi người dùng bấm Tìm hoặc vừa cắm ghim (không gọi theo từng phím gõ).
const HANOI = [21.0285, 105.8542];
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io';   // dự phòng khi mạng chặn Nominatim (cùng dữ liệu OpenStreetMap)

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};
// Photon trả từng phần địa chỉ -> ghép thành một dòng.
const photonLabel = (p) => [p.name, [p.housenumber, p.street].filter(Boolean).join(' '), p.locality, p.district, p.city]
  .filter((s, i, a) => s && a.indexOf(s) === i).join(', ');
// Tìm địa chỉ: Nominatim trước (địa chỉ tiếng Việt đầy đủ hơn), lỗi thì Photon.
async function geocode(q) {
  try {
    const d = await getJson(`${NOMINATIM}/search?format=jsonv2&limit=5&countrycodes=vn&accept-language=vi&q=${encodeURIComponent(q)}`);
    return d.map((x) => ({ label: x.display_name, pos: [Number(x.lat), Number(x.lon)] }));
  } catch {
    const d = await getJson(`${PHOTON}/api/?limit=5&lat=${HANOI[0]}&lon=${HANOI[1]}&q=${encodeURIComponent(q)}`);
    return d.features.filter((f) => !f.properties.countrycode || f.properties.countrycode === 'VN')
      .map((f) => ({ label: photonLabel(f.properties), pos: [f.geometry.coordinates[1], f.geometry.coordinates[0]] }));
  }
}
async function reverse(lat, lng) {
  try {
    return (await getJson(`${NOMINATIM}/reverse?format=jsonv2&accept-language=vi&lat=${lat}&lon=${lng}`)).display_name;
  } catch {
    const f = (await getJson(`${PHOTON}/reverse?lat=${lat}&lon=${lng}`)).features?.[0];
    return f ? photonLabel(f.properties) : null;
  }
}
const PIN = L.divIcon({ className: '', iconSize: null, html: '<div class="pick-pin"><span></span></div>' });

// Địa chỉ ngắn gọn cho khách: bỏ mã bưu chính, quốc gia; giữ 3 phần đầu.
const shortAddress = (d) => (d ?? '').split(',').map((s) => s.trim())
  .filter((s) => s && !/^\d{4,6}$/.test(s) && s !== 'Việt Nam').slice(0, 3).join(', ');

function ClickToPick({ onPick }) {
  useMapEvents({ click: (e) => onPick([e.latlng.lat, e.latlng.lng]) });
  return null;
}
function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => { if (target) map.flyTo(target, Math.max(map.getZoom(), 16), { duration: 0.6 }); }, [target, map]);
  // Bản đồ nằm trong hộp sửa / form có thể đổi cỡ sau khi tạo -> vẽ lại ô nền.
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function LocationPicker({ lat, lng, others = [], onPick }) {
  const pos = lat !== '' && lng !== '' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? [Number(lat), Number(lng)] : null;
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);   // null = chưa tìm; [] = không có kết quả
  const [busy, setBusy] = useState('');           // 'search' | 'reverse' | 'geo' | ''
  const [err, setErr] = useState('');
  const [fly, setFly] = useState(null);

  async function pick(p, address) {
    const round = (v) => Math.round(v * 1e6) / 1e6;
    const [la, ln] = [round(p[0]), round(p[1])];
    onPick({ lat: String(la), lng: String(ln), ...(address && { address }) });
    if (address) return;
    setBusy('reverse');
    try {
      const name = await reverse(la, ln);
      if (name) onPick({ lat: String(la), lng: String(ln), address: shortAddress(name) });
    } catch { /* không lấy được địa chỉ: giữ toạ độ, người dùng tự nhập địa chỉ */ }
    setBusy('');
  }

  async function search(e) {
    e?.preventDefault();
    if (q.trim().length < 3) return setErr('Nhập ít nhất 3 ký tự để tìm.');
    setErr(''); setBusy('search');
    try { setResults(await geocode(q.trim())); }
    catch { setErr('Không tìm được lúc này (mất mạng hoặc dịch vụ bản đồ bận). Hãy bấm thẳng lên bản đồ.'); }
    setBusy('');
  }

  function here() {
    if (!navigator.geolocation) return setErr('Trình duyệt không hỗ trợ lấy vị trí.');
    setErr(''); setBusy('geo');
    navigator.geolocation.getCurrentPosition(
      (p) => { const at = [p.coords.latitude, p.coords.longitude]; setFly(at); setBusy(''); pick(at); },
      () => { setBusy(''); setErr('Không lấy được vị trí (chưa cho phép?).'); }, { timeout: 10000 });
  }

  return (
    <div className="picker">
      <div className="picker-bar">
        {/* div thay vì form: picker nằm trong form thêm bãi, form lồng nhau không hợp lệ */}
        <div className="picker-search" role="search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm địa chỉ, vd 96A Trần Phú Hà Đông" aria-label="Tìm địa chỉ trên bản đồ"
            onKeyDown={(e) => e.key === 'Enter' && search(e)} />
          <button type="button" onClick={search} disabled={busy === 'search'}>{busy === 'search' ? <Icon name="loader" spin /> : <Icon name="search" />} Tìm</button>
        </div>
        <button type="button" onClick={here} disabled={busy === 'geo'}>{busy === 'geo' ? <Icon name="loader" spin /> : <Icon name="pin" />} Vị trí của tôi</button>
      </div>
      {err && <span className="error small">{err}</span>}
      {results && (
        <ul className="picker-results" aria-label="Kết quả tìm địa chỉ">
          {results.map((x, i) => (
            <li key={i}><button type="button" className="link" onClick={() => { setFly(x.pos); setResults(null); pick(x.pos, shortAddress(x.label)); }}>{x.label}</button></li>
          ))}
          {!results.length && <li className="muted small">Không thấy địa chỉ này. Thử gõ ngắn hơn, hoặc bấm thẳng lên bản đồ.</li>}
        </ul>
      )}
      <div className="picker-map">
        <MapContainer center={pos ?? HANOI} zoom={pos ? 16 : 12} scrollWheelZoom className="map picker-leaflet">
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <ClickToPick onPick={(p) => pick(p)} />
          <FlyTo target={fly} />
          {others.filter((o) => o.lat != null).map((o) => (
            <CircleMarker key={o.parkingId} center={[o.lat, o.lng]} radius={6} pathOptions={{ color: '#14224a', fillOpacity: 0.5, weight: 1 }}>
              <Tooltip>{o.name}</Tooltip>
            </CircleMarker>
          ))}
          {pos && <Marker position={pos} icon={PIN} draggable eventHandlers={{ dragend: (e) => { const ll = e.target.getLatLng(); pick([ll.lat, ll.lng]); } }} />}
        </MapContainer>
        <div className="picker-hint">
          {busy === 'reverse' ? <><Icon name="loader" spin /> Đang lấy địa chỉ…</>
            : pos ? <><Icon name="pin" /> {lat}, {lng} · kéo ghim để chỉnh</> : <><Icon name="pin" /> Bấm lên bản đồ để đặt vị trí bãi</>}
        </div>
      </div>
    </div>
  );
}
