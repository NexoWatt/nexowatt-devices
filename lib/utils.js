'use strict';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pow10(exp) {
  // exp can be negative
  return Math.pow(10, exp);
}

function applyScale(value, scaleFactor) {
  if (value === null || value === undefined) return value;
  const n = Number(scaleFactor || 0);
  if (!n) return value;
  return value * pow10(n);
}

function removeScale(value, scaleFactor) {
  if (value === null || value === undefined) return value;
  const n = Number(scaleFactor || 0);
  if (!n) return value;
  return value / pow10(n);
}

function bigIntToNumberOrString(bi) {
  // Convert BigInt safely; if it exceeds Number safe range, return string
  if (typeof bi !== 'bigint') return bi;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  if (bi <= maxSafe && bi >= minSafe) return Number(bi);
  return bi.toString();
}

module.exports = {
  sleep,
  applyScale,
  removeScale,
  bigIntToNumberOrString,
};