export function createRandom(seed) {
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function choose(random, values) {
  if (!values.length) throw new RangeError('cannot choose from an empty list');
  return values[Math.floor(random() * values.length)];
}

export function makeOperationId(seed, worker, sequence, runTag = '') {
  return `j${(seed >>> 0).toString(36)}${runTag ? `-${runTag}` : ''}-${worker}-${sequence}`;
}
