import L from 'leaflet';
import { CircleMarker, MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon, NodeBadge } from './ui.jsx';

const HANOI = [21.0285, 105.8542];

// Điểm bãi = divIcon ".pin" hiện số chỗ trống, màu theo tỉ lệ (≥ 50 % xanh, 20–49 % vàng, < 20 % đỏ); mất kết nối xám.
const WIFI_OFF = '<i class="i i-wifi-off" aria-hidden="true"></i>';
function pin(p) {
  const on = p.status !== 'OFFLINE';
  const pct = p.total > 0 ? p.available / p.total : 0;
  const cls = !on ? 'pin off' : pct < 0.2 ? 'pin low' : pct < 0.5 ? 'pin mid' : 'pin';
  const label = on ? `<span>${Number(p.available) || 0}</span>` : WIFI_OFF;
  return L.divIcon({ className: '', iconSize: null, html: `<div class="${cls}"><b>${label}</b></div>` });
}

export default function ParkingMap({ items, me, onOpen }) {
  const center = me ?? (items.find((p) => p.lat != null) ? [items.find((p) => p.lat != null).lat, items.find((p) => p.lat != null).lng] : HANOI);
  return (
    <div style={{ position: 'relative' }}>
      <MapContainer center={center} zoom={12} className="map" scrollWheelZoom>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {me && <CircleMarker center={me} radius={7} pathOptions={{ color: '#416180', fillOpacity: 0.9 }}><Popup>Vị trí của bạn</Popup></CircleMarker>}
        {items.filter((p) => p.lat != null).map((p) => (
          <Marker key={p.parkingId} position={[p.lat, p.lng]} icon={pin(p)} title={p.name}>
            <Popup>
              <div className="lot-head" style={{ gap: 'var(--space-3)' }}>
                <span className="lot-name" style={{ fontSize: 18 }}>{p.name}</span>
                <NodeBadge status={p.status} />
              </div>
              <div className="muted small">{p.address}{p.distance != null && ` · ${p.distance.toFixed(1)} km`}</div>
              <p className="mono" style={{ margin: 'var(--space-2) 0' }}>
                {p.status !== 'OFFLINE' ? `${p.available}/${p.total} chỗ trống` : 'Mất kết nối: tạm không nhận đặt chỗ'}
              </p>
              <button className="primary" style={{ width: '100%' }} onClick={() => onOpen(p.parkingId)}>Xem sơ đồ &amp; đặt chỗ</button>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      <div className="map-legend">
        <span><i className="sw" style={{ background: 'var(--pin-hi)' }} /> ≥ 50% trống</span>
        <span><i className="sw" style={{ background: 'var(--pin-mid)' }} /> 20–49%</span>
        <span><i className="sw" style={{ background: 'var(--pin-low)' }} /> &lt; 20%</span>
        <span><Icon name="wifi-off" /> Mất kết nối</span>
      </div>
    </div>
  );
}
