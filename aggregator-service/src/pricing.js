// Validation snapshot only; parity is tested against parking-node.
function invalidRule(r) {
  if (!['CAR', 'MOTO'].includes(r?.vehicleType)) return 'vehicleType must be CAR or MOTO';
  for (const k of ['firstBlockMin', 'firstBlockFee', 'nextHourFee', 'overnightFee']) {
    if (!Number.isInteger(r[k]) || r[k] < 0 || r[k] > 10_000_000) return `${k} must be an integer 0..10000000`;
  }
  if (r.firstBlockMin < 1) return 'firstBlockMin must be >= 1';
  if (r.maxDayFee != null && (!Number.isInteger(r.maxDayFee) || r.maxDayFee < 0)) return 'maxDayFee must be null or an integer >= 0';
  return null;
}

module.exports={invalidRule};
