import { useEffect, useRef, useState } from "react";
import { api, message, session, newKey, formatPlate } from "../api.js";
import "./Broadcast.css";
import { makeBroadcastRequest, digestBroadcast } from "../broadcast-request.js";
import { ConfirmDialog, Icon } from "../ui.jsx";

// PD-04: phát một lệnh quản trị tới nhiều bãi. Soạn bằng FORM theo từng loại lệnh (không bắt gõ JSON);
// dữ liệu gửi đi vẫn đúng hợp đồng validateAdmin (aggregator-service/src/admin-payload.js), xem được ở mục
// "Dữ liệu gửi đi". Chống gửi trùng (Idempotency-Key theo nội dung lệnh) và theo dõi kết quả giữ như cũ.

const TYPES = {
  setPricing: "Đổi bảng giá",
  lockFloor: "Khoá / mở tầng",
  banPlates: "Cấm / bỏ cấm biển số",
};
const VEHICLE = { CAR: "Ô tô", MOTO: "Xe máy" };
// [khoá, nhãn, gợi ý, được bỏ trống]
const PRICE_FIELDS = [
  ["firstBlockMin", "Thời gian giá mở đầu", "phút", false],
  ["firstBlockFee", "Giá mở đầu", "đ", false],
  ["nextHourFee", "Mỗi giờ tiếp theo", "đ/giờ", false],
  ["overnightFee", "Phụ thu qua đêm", "đ", false],
  ["maxDayFee", "Tối đa mỗi ngày", "đ · trống = không giới hạn", true],
];
const DEFAULT_RULES = {
  CAR: { vehicleType: "CAR", firstBlockMin: 120, firstBlockFee: 25000, nextHourFee: 10000, overnightFee: 30000, maxDayFee: 150000 },
  MOTO: { vehicleType: "MOTO", firstBlockMin: 120, firstBlockFee: 5000, nextHourFee: 2000, overnightFee: 5000, maxDayFee: 20000 },
};
const ZONE_LABEL = { all: "Tất cả bãi A–F", bac: "Vùng Bắc (A–C)", nam: "Vùng Nam (D–F)" };
const STATE_LABEL = { QUEUED: "đang chờ gửi", SENDING: "đang gửi", UNKNOWN: "chưa rõ, đang thử lại", CONFIRMED: "đã tới hàng đợi các bãi", REJECTED: "bị từ chối" };
// Cùng luật với aggregator-service/src/plate.js
const normPlate = (p) => String(p ?? "").toUpperCase().replace(/[\s.\-]/g, "");
const isPlate = (p) => /^\d{2}[A-Z]{1,2}\d?\d{4,5}$/.test(p);
const money = (v) => `${Number(v).toLocaleString("vi-VN")} đ`;

// Biên dịch form -> payload đúng hợp đồng; trả { body, errors }.
function compile(type, f) {
  const errors = {};
  if (type === "setPricing") {
    const picked = Object.keys(VEHICLE).filter((v) => f.vehicles[v]);
    if (!picked.length) errors.vehicles = "Chọn ít nhất một loại xe.";
    const rules = picked.map((v) => {
      const r = { vehicleType: v };
      for (const [k, , , optional] of PRICE_FIELDS) {
        const raw = String(f.rules[v][k] ?? "").trim();
        if (raw === "" && optional) { r[k] = null; continue; }
        const n = Number(raw);
        if (raw === "" || !Number.isInteger(n) || n < 0 || n > 10_000_000) errors[`${v}.${k}`] = "Số nguyên từ 0 đến 10.000.000.";
        else if (k === "firstBlockMin" && n < 1) errors[`${v}.${k}`] = "Ít nhất 1 phút.";
        r[k] = n;
      }
      return r;
    });
    return { body: { rules }, errors };
  }
  if (type === "lockFloor") {
    const floor = Number(f.floor);
    if (!Number.isInteger(floor) || floor < 1 || floor > 100) errors.floor = "Tầng từ 1 đến 100.";
    return { body: { floor, locked: f.locked }, errors };
  }
  // banPlates: mỗi dòng / dấu phẩy một biển; tự bỏ trùng
  const list = [...new Set(String(f.plates).split(/[\n,;]+/).map(normPlate).filter(Boolean))];
  const bad = list.filter((p) => !isPlate(p));
  if (!list.length) errors.plates = "Nhập ít nhất một biển số.";
  else if (bad.length) errors.plates = `Biển số không hợp lệ: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""} (vd 30A-123.45).`;
  else if (list.length > 100) errors.plates = "Tối đa 100 biển số mỗi lệnh.";
  return { body: { plates: list.map(formatPlate), banned: f.banned }, errors, count: list.length };
}

// Câu tóm tắt lệnh cho hộp xác nhận và kết quả.
function describe(type, body) {
  if (type === "setPricing") return body.rules.map((r) => `${VEHICLE[r.vehicleType]}: ${r.firstBlockMin} phút đầu ${money(r.firstBlockFee)}, mỗi giờ tiếp ${money(r.nextHourFee)}, qua đêm ${money(r.overnightFee)}, tối đa ${r.maxDayFee == null ? "không giới hạn" : money(r.maxDayFee)}/ngày`);
  if (type === "lockFloor") return [`${body.locked ? "Khoá" : "Mở khoá"} toàn bộ tầng ${body.floor}`];
  return [`${body.banned ? "Cấm" : "Bỏ cấm"} ${body.plates.length} biển số: ${body.plates.slice(0, 6).join(", ")}${body.plates.length > 6 ? "…" : ""}`];
}

export default function Broadcast() {
  const [zones, setZones] = useState([]),
    [zone, setZone] = useState("all"),
    [type, setType] = useState("setPricing");
  const [form, setForm] = useState({
    vehicles: { CAR: true, MOTO: false },
    rules: { CAR: { ...DEFAULT_RULES.CAR }, MOTO: { ...DEFAULT_RULES.MOTO } },
    floor: "1", locked: true,
    plates: "", banned: true,
  });
  const [touched, setTouched] = useState(false);
  const [ask, setAsk] = useState(null);
  const [result, setResult] = useState(null),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false);
  const identity =
    session.get()?.user?.id ?? session.get()?.user?.sub ?? session.get()?.token;
  // Only command ID is retained, scoped to the authenticated session. No plates or command payload in storage.
  const storageKey = `parking.broadcast.${identity?.slice(-24) ?? "anonymous"}`;
  const request = useRef(null);
  if (!request.current)
    request.current = makeBroadcastRequest({
      storage: sessionStorage,
      storageKey: storageKey + ".request",
      digest: digestBroadcast,
      newKey,
    });
  useEffect(() => {
    api("/api/admin/broadcast/zones").then((r) => {
      if (r.ok) setZones(r.data);
    });
    // Bảng giá: lấy giá hiện tại của bãi đầu tiên làm điểm xuất phát (chỉ cần sửa số muốn đổi).
    api("/api/parkings").then(async (r) => {
      const first = r.ok && r.data.find((p) => p.status !== "OFFLINE");
      if (!first) return;
      const pr = await api(`/api/parkings/${first.parkingId}/pricing`);
      if (pr.ok) setForm((f) => ({ ...f, rules: { ...f.rules, ...Object.fromEntries(pr.data.map((x) => [x.vehicleType, { ...x }])) } }));
    });
    try {
      const id =
        sessionStorage.getItem(storageKey) ??
        request.current.read()?.broadcastId;
      if (id)
        api(`/api/admin/broadcast/${encodeURIComponent(id)}`).then((r) => {
          if (r.ok) setResult(r.data);
        });
    } catch {
      /* storage disabled */
    }
  }, [storageKey]);
  useEffect(() => {
    if (!result?.broadcastId || !result.missing.length || result.expired)
      return;
    const id = result.broadcastId;
    const timer = setInterval(
      () =>
        api(`/api/admin/broadcast/${encodeURIComponent(id)}`).then((r) => {
          if (r.ok) setResult(r.data);
        }),
      2000,
    );
    return () => clearInterval(timer);
  }, [result?.broadcastId, result?.missing.length, result?.expired]);

  const compiled = compile(type, form);
  const errs = touched ? compiled.errors : {};
  const setRule = (v, k, value) => setForm((f) => ({ ...f, rules: { ...f.rules, [v]: { ...f.rules[v], [k]: value } } }));

  async function send() {
    const input = { zone, type, body: compiled.body };
    const intent = await request.current.prepare(input, identity);
    setBusy(true);
    setNote("Đang gom phản hồi, tối đa 5 giây…");
    const r = await api("/api/admin/broadcast", {
      method: "POST",
      body: input,
      headers: { "Idempotency-Key": intent.key },
    });
    setBusy(false);
    if (r.ok || r.data?.broadcastId) {
      setResult(r.data);
      setNote("");
      try {
        sessionStorage.setItem(storageKey, r.data.broadcastId);
      } catch {
        /* storage disabled */
      }
    } else
      setNote(
        r.data?.error === "ADMIN_BROADCAST_NOT_READY"
          ? "Kênh quản trị đang khởi tạo hoặc mất kết nối. Hãy thử lại cùng yêu cầu."
          : message(r.data),
      );
  }
  function review(e) {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(compiled.errors).length) return setNote("Kiểm tra lại các ô đang báo đỏ.");
    setNote("");
    setAsk({
      title: `${TYPES[type]} · ${ZONE_LABEL[zone] ?? zone}`,
      body: (
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          <ul className="bc-summary">{describe(type, compiled.body).map((line) => <li key={line}>{line}</li>)}</ul>
          <span>Lệnh có hiệu lực 10 phút; bãi đang mất kết nối sẽ áp dụng khi kết nối lại trong thời gian đó.</span>
        </div>
      ),
      label: "Gửi lệnh", run: send,
    });
  }

  const field = (key, label, input, hint) => (
    <label className="field">
      {label}
      {input}
      {errs[key] ? <span className="error">{errs[key]}</span> : hint && <span className="hint">{hint}</span>}
    </label>
  );

  return (
    <section className="card">
      <h3>Phát lệnh quản trị A–F</h3>
      <p className="muted">
        Gửi một thay đổi tới nhiều bãi cùng lúc. Lệnh có hạn 10 phút; kết quả từng bãi tự cập nhật.
      </p>
      {!result && (
        <form className="broadcast-form" onSubmit={review} noValidate>
          {field("zone", "Gửi tới",
            <select value={zone} onChange={(e) => setZone(e.target.value)}>
              <option value="all">{ZONE_LABEL.all}</option>
              {zones.map((z) => <option key={z} value={z}>{ZONE_LABEL[z] ?? z}</option>)}
            </select>)}
          {field("type", "Loại lệnh",
            <select value={type} onChange={(e) => { setType(e.target.value); setTouched(false); setNote(""); }}>
              {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>)}

          {type === "setPricing" && (
            <div className="bc-block">
              <div className="bc-row" role="group" aria-label="Loại xe áp dụng">
                <span className="muted small">Áp dụng cho:</span>
                {Object.entries(VEHICLE).map(([v, label]) => (
                  <label key={v} className="check">
                    <input type="checkbox" checked={form.vehicles[v]} onChange={(e) => setForm((f) => ({ ...f, vehicles: { ...f.vehicles, [v]: e.target.checked } }))} />
                    {label}
                  </label>
                ))}
                {errs.vehicles && <span className="error small">{errs.vehicles}</span>}
              </div>
              <p className="muted small" style={{ margin: 0 }}>Đã điền sẵn bảng giá đang dùng ở một bãi; chỉ sửa số muốn đổi.</p>
              {Object.keys(VEHICLE).filter((v) => form.vehicles[v]).map((v) => (
                <fieldset key={v} className="bc-prices">
                  <legend>{VEHICLE[v]}</legend>
                  {PRICE_FIELDS.map(([k, label, hint]) => field(`${v}.${k}`, label,
                    <input type="number" inputMode="numeric" min={k === "firstBlockMin" ? 1 : 0} step={k === "firstBlockMin" ? 1 : 1000}
                      value={form.rules[v][k] ?? ""} placeholder={k === "maxDayFee" ? "Không giới hạn" : undefined}
                      aria-invalid={errs[`${v}.${k}`] ? "true" : undefined} onChange={(e) => setRule(v, k, e.target.value)} />, hint))}
                </fieldset>
              ))}
            </div>
          )}

          {type === "lockFloor" && (
            <div className="bc-block bc-two">
              {field("floor", "Tầng",
                <input type="number" inputMode="numeric" min="1" max="100" value={form.floor}
                  aria-invalid={errs.floor ? "true" : undefined} onChange={(e) => setForm((f) => ({ ...f, floor: e.target.value }))} />,
                "Áp dụng cho tầng này ở mọi bãi được chọn.")}
              <div className="field">
                Thao tác
                <div className="seg" role="group" aria-label="Khoá hoặc mở tầng">
                  <button type="button" className={form.locked ? "tab active" : "tab"} aria-pressed={form.locked} onClick={() => setForm((f) => ({ ...f, locked: true }))}><Icon name="lock" /> Khoá tầng</button>
                  <button type="button" className={!form.locked ? "tab active" : "tab"} aria-pressed={!form.locked} onClick={() => setForm((f) => ({ ...f, locked: false }))}>Mở khoá</button>
                </div>
                <span className="hint">Khoá: các ô của tầng ngừng nhận đặt chỗ và xe vào.</span>
              </div>
            </div>
          )}

          {type === "banPlates" && (
            <div className="bc-block">
              <div className="field">
                Thao tác
                <div className="seg" role="group" aria-label="Cấm hoặc bỏ cấm">
                  <button type="button" className={form.banned ? "tab active" : "tab"} aria-pressed={form.banned} onClick={() => setForm((f) => ({ ...f, banned: true }))}><Icon name="ban" /> Cấm</button>
                  <button type="button" className={!form.banned ? "tab active" : "tab"} aria-pressed={!form.banned} onClick={() => setForm((f) => ({ ...f, banned: false }))}>Bỏ cấm</button>
                </div>
              </div>
              {field("plates", `Biển số${compiled.count ? ` (${compiled.count})` : ""}`,
                <textarea rows={4} value={form.plates} placeholder={"30A-123.45\n29B1-678.90"} spellCheck={false}
                  aria-invalid={errs.plates ? "true" : undefined} onChange={(e) => setForm((f) => ({ ...f, plates: e.target.value }))} />,
                "Mỗi dòng một biển (hoặc cách nhau bằng dấu phẩy). Gõ thế nào cũng được, hệ thống tự chuẩn hoá và bỏ trùng.")}
            </div>
          )}

          <details className="bc-json">
            <summary>Dữ liệu gửi đi (cho kỹ thuật)</summary>
            <pre>{JSON.stringify({ zone, type, body: compiled.body }, null, 2)}</pre>
          </details>
          <button className="primary" disabled={busy}>
            {busy ? <><Icon name="loader" spin /> Đang xử lý…</> : <><Icon name="send" /> Xem lại &amp; gửi</>}
          </button>
        </form>
      )}
      {note && <p role="status" className={Object.keys(errs).length ? "error" : undefined}>{note}</p>}
      {result && (
        <div aria-live="polite" className="stack" style={{ gap: "var(--space-3)" }}>
          <p style={{ margin: 0 }}>
            <strong>
              {result.applied.length}/{result.total} bãi đã áp dụng
              {result.missing.length ? ` · bãi ${result.missing.join(", ")} chưa phản hồi` : ""}
            </strong>
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {TYPES[result.type] ?? result.type} · {ZONE_LABEL[result.zone] ?? result.zone} · gửi: {STATE_LABEL[result.publishState] ?? result.publishState}
          </p>
          {result.expired && result.missing.length > 0 && (
            <div className="banner"><Icon name="alert" />
              <div><strong>Lệnh đã hết hạn</strong>Các bãi chưa phản hồi chưa có bằng chứng đã áp dụng. Kiểm tra lại ở từng bãi hoặc gửi lệnh mới.</div>
            </div>
          )}
          <div className="scroll">
            <table>
              <thead><tr><th>Bãi</th><th>Kết quả</th></tr></thead>
              <tbody>
                {result.targets.map((id) => {
                  const rej = result.rejected.find((r) => r.parkingId === id);
                  return (
                    <tr key={id}>
                      <td><b className="mono">{id}</b></td>
                      <td>
                        {result.applied.includes(id) ? <span className="st ok"><Icon name="check" />Đã áp dụng</span>
                          : rej ? <span className="st bad"><Icon name="x" />Từ chối: {message({ error: rej.error })}</span>
                          : <span className="st warn"><Icon name="clock" />Chưa phản hồi</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ margin: 0, overflowWrap: "anywhere" }}>Mã lệnh: {result.broadcastId}</p>
          <div className="bc-row">
            <button type="button" onClick={() => api(`/api/admin/broadcast/${encodeURIComponent(result.broadcastId)}`).then((r) => { if (r.ok) setResult(r.data); })}>
              <Icon name="retry" /> Cập nhật kết quả
            </button>
            {(!result.missing.length || result.expired) && (
              <button type="button" className="primary" onClick={() => {
                request.current.clear();
                setResult(null);
                setTouched(false);
                try { sessionStorage.removeItem(storageKey); } catch { /* storage disabled */ }
              }}>
                Soạn lệnh mới
              </button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
