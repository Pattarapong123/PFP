// src/utils/decode-qr.js
import * as JimpNS from 'jimp';
import qrReaderPkg from 'qrcode-reader';

// รองรับทั้งกรณี default export / named export / namespace
const Jimp = JimpNS.Jimp || JimpNS.default || JimpNS;
const QrCode = qrReaderPkg.default || qrReaderPkg;

/**
 * อ่าน QR code จากไฟล์ภาพ
 * @param {string} filePath path ไปยังไฟล์ภาพ
 * @returns {Promise<string>} ข้อความที่ถอดจาก QR
 */
export async function decodeQR(filePath) {
  const image = await Jimp.read(filePath);
  return new Promise((resolve, reject) => {
    const qr = new QrCode();
    qr.callback = (err, value) => {
      if (err) return reject(err);
      resolve(value?.result || '');
    };
    qr.decode(image.bitmap);
  });
}
