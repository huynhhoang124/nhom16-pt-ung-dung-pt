// Biển số xe Việt Nam, lưu ở dạng chuẩn: chữ hoa, bỏ dấu cách/chấm/gạch. "30a-123.45" -> "30A12345".
// Dạng chuẩn: 2 số mã tỉnh + 1–2 chữ cái seri (+1 số với xe máy) + 4–5 số. Vd 30A12345, 29B112345, 51LD1234.
const PLATE = /^\d{2}[A-Z]{1,2}\d?\d{4,5}$/;

const normalizePlate = (p) => String(p ?? '').toUpperCase().replace(/[\s.\-]/g, '');
const isPlate = (p) => PLATE.test(p);

module.exports = { normalizePlate, isPlate };
