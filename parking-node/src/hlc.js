'use strict';

const HLC_PATTERN = /^(\d{13})-(\d{4})$/;
const MAX_LOGICAL = 9_999_999_999_999;
const MAX_COUNTER = 9_999;

function parseSkew(value) {
  const skew = Number(value ?? 0);

  if (!Number.isSafeInteger(skew)) {
    throw new Error('CLOCK_SKEW_MS phải là số nguyên mili giây');
  }

  return skew;
}

const DEFAULT_SKEW_MS = parseSkew(process.env.CLOCK_SKEW_MS ?? 0);

function parseHlc(value) {
  const match = typeof value === 'string'
    ? HLC_PATTERN.exec(value)
    : null;

  if (!match) {
    throw new TypeError('HLC không đúng định dạng 13 chữ số-4 chữ số');
  }

  return {
    l: Number(match[1]),
    c: Number(match[2]),
  };
}

function createHlc({ clock = Date.now, skewMs = DEFAULT_SKEW_MS } = {}) {
  const skew = parseSkew(skewMs);

  // Mỗi tiến trình giữ đồng hồ logic riêng trong bộ nhớ.
  let l = -1;
  let c = 0;

  function physicalTime() {
    const p = Math.trunc(Number(clock())) + skew;

    if (!Number.isSafeInteger(p) || p < 0 || p > MAX_LOGICAL) {
      throw new RangeError('Thời gian vật lý nằm ngoài phạm vi HLC');
    }

    return p;
  }

  function format() {
    // Tràn bộ đếm thì tiến thành phần thời gian logic thêm 1 ms.
    if (c > MAX_COUNTER) {
      l += 1;
      c = 0;
    }

    if (!Number.isSafeInteger(l) || l < 0 || l > MAX_LOGICAL) {
      throw new RangeError('Thành phần thời gian logic nằm ngoài phạm vi HLC');
    }

    return `${String(l).padStart(13, '0')}-${String(c).padStart(4, '0')}`;
  }

  // Gửi hoặc phát sinh một sự kiện mới.
  function now() {
    const p = physicalTime();

    if (p > l) {
      l = p;
      c = 0;
    } else {
      c += 1;
    }

    return format();
  }

  // Nhận timestamp từ tiến trình khác, bảo toàn quan hệ nhân quả.
  function update(remote) {
    const r = parseHlc(remote);
    const p = physicalTime();
    const nextL = Math.max(p, l, r.l);

    let nextC;

    if (nextL === l && nextL === r.l) {
      nextC = Math.max(c, r.c) + 1;
    } else if (nextL === l) {
      nextC = c + 1;
    } else if (nextL === r.l) {
      nextC = r.c + 1;
    } else {
      nextC = 0;
    }

    l = nextL;
    c = nextC;

    return format();
  }

  return { now, update };
}

function compareHlc(a, b) {
  const left = parseHlc(a);
  const right = parseHlc(b);

  return left.l - right.l || left.c - right.c;
}

// Đồng hồ mặc định của tiến trình hiện tại.
const instance = createHlc();

module.exports = {
  now: () => instance.now(),
  update: (remote) => instance.update(remote),
  createHlc,
  parseHlc,
  compareHlc,
};