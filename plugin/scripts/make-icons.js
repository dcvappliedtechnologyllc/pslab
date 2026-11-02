// Writes the panel icons (solid circles) with no dependencies: node scripts/make-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function circlePng(size, [r, g, b]) {
  const rows = [];
  const c = (size - 1) / 2;
  const radius = size * 0.42;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, radius + 0.5 - d));
      row.set([r, g, b, Math.round(a * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, "..", "icons");
fs.mkdirSync(out, { recursive: true });
const themes = { dark: [220, 220, 220], light: [60, 60, 60] };
for (const [name, color] of Object.entries(themes)) {
  fs.writeFileSync(path.join(out, `${name}.png`), circlePng(23, color));
  fs.writeFileSync(path.join(out, `${name}@2x.png`), circlePng(46, color));
}
