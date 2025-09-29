// src/utils/emvco.js
// ตัวช่วยแยก TLV และตรวจ CRC ของ EMVCo/Thai QR
export function parseEMV(s = '') {
  const out = {};
  let i = 0;
  while (i < s.length) {
    const tag = s.slice(i, i + 2); i += 2;
    const len = parseInt(s.slice(i, i + 2), 10); i += 2;
    const val = s.slice(i, i + len); i += len;
    out[tag] = val;
    // Subfields: 26, 29 (PromptPay ใช้ 29 บ่อย), และอื่น ๆ
    if (['26','27','28','29','30','31','32'].includes(tag)) {
      out[tag] = { raw: val, sub: parseEMV(val) };
    }
  }
  return out;
}

export function verifyCRC(payload) {
  const idx = payload.indexOf('6304');
  if (idx < 0) return { ok:false, expected:null, actual:null };
  const dataNoCRC = payload.slice(0, idx + 4);
  const actual = payload.slice(idx + 4, idx + 8).toUpperCase();
  const expected = crc16ccitt(dataNoCRC).toUpperCase();
  return { ok: expected === actual, expected, actual };
}

function crc16ccitt(hex) {
  let crc = 0xFFFF;
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substr(i, 2), 16);
    crc ^= (byte << 8);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc <<= 1;
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).padStart(4, '0');
}
