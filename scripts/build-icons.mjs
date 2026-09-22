/**
 * Generates the PNG app icons used by the web manifest and Apple home screen.
 * Runs during the build so the required icon sizes are available in public/.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
const glyph = [
  "01110011110",
  "11000110000",
  "10000110000",
  "10000011100",
  "10000000110",
  "11000000110",
  "01110111100",
];
for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const scale = Math.floor(size / 19);
  const left = Math.floor((size - 11 * scale) / 2);
  const top = Math.floor((size - 7 * scale) / 2);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - left) / scale),
        gy = Math.floor((y - top) / scale);
      const white =
        gx >= 0 && gx < 11 && gy >= 0 && gy < 7 && glyph[gy][gx] === "1";
      const at = y * (size * 4 + 1) + 1 + x * 4;
      pixels.set(white ? [255, 255, 255, 255] : [36, 75, 215, 255], at);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    "public/" + name,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
console.log("Generated 192px, 512px, maskable and Apple icons.");
