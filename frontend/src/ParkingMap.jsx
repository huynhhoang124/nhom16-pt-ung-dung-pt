import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

const HANOI = [21.0285, 105.8542];

// Màu theo tỉ lệ chỗ trống; bãi mất kết nối màu xám. Dùng CircleMarker (vẽ SVG) nên không cần ảnh icon.
const color = (p) => (p.status !== 'ONLINE' ? '#8a939d' : p.available === 0 ? '#c62828' : p.available / p.total < 0.2 ? '#b26a00' : '#1a7f37');

export default function ParkingMap({ items, me, onOpen }) {
  const center = me ?? (items.find((p) => p.lat != null) ? [items.find((p) => p.lat != null).lat, items.find((p) => p.lat != null).lng] : HANOI);
  return (
    <MapContainer center={center} zoom={12} className="map" scrollWheelZoom>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {me && <CircleMarker center={me} radius={7} pathOptions={{ color: '#1f6feb', fillOpacity: 0.9 }}><Popup>Vị trí của bạn</Popup></CircleMarker>}
      {items.filter((p) => p.lat != null).map((p) => (
        <CircleMarker key={p.parkingId} center={[p.lat, p.lng]} radius={14} pathOptions={{ color: color(p), fillColor: color(p), fillOpacity: 0.6 }}>
          <Popup>
            <strong>{p.name}</strong><br />
            {p.status === 'ONLINE' ? `${p.available}/${p.total} chỗ trống` : 'Mất kết nối'}
            {p.distance != null && <> · {p.distance.toFixed(1)} km</>}<br />
            <button className="link" onClick={() => onOpen(p.parkingId)}>Xem bãi, đặt chỗ →</button>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
