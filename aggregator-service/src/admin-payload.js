const { invalidRule } = require('./pricing');
const { normalizePlate, isPlate } = require('./plate');

function validateAdmin(type, body) {
  const object = body && typeof body === 'object' && !Array.isArray(body);
  if (!object) return 'INVALID_PAYLOAD';
  const keys = Object.keys(body).sort().join(',');
  if (type === 'setPricing') {
    if (keys !== 'rules' || !Array.isArray(body.rules) || body.rules.length < 1 || body.rules.length > 2 ||
      new Set(body.rules.map(r => r?.vehicleType)).size !== body.rules.length || body.rules.some(invalidRule)) return 'INVALID_PRICING';
    if (body.rules.some(r => r.maxDayFee != null && r.maxDayFee > 10000000)) return 'INVALID_PRICING';
    if (body.rules.some(r => Object.keys(r).some(k => !['vehicleType','firstBlockMin','firstBlockFee','nextHourFee','overnightFee','maxDayFee'].includes(k)))) return 'INVALID_PRICING';
  } else if (type === 'lockFloor') {
    if (keys !== 'floor,locked' || !Number.isInteger(body.floor) || body.floor < 1 || body.floor > 100 || typeof body.locked !== 'boolean') return 'INVALID_FLOOR';
  } else if (type === 'banPlates') {
    if (keys !== 'banned,plates' || typeof body.banned !== 'boolean' || !Array.isArray(body.plates) || body.plates.length < 1 || body.plates.length > 100 ||
      body.plates.some(p => typeof p !== 'string' || !isPlate(normalizePlate(p))) || new Set(body.plates.map(normalizePlate)).size !== body.plates.length) return 'INVALID_PLATES';
  } else return 'INVALID_COMMAND_TYPE';
  return null;
}
module.exports = { validateAdmin };
