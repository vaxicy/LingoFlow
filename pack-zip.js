const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Use [\\\/] to safely match both / and \ separators.
// JS regex literals: \s is whitespace, \b is word boundary — be careful!
const EXCLUDE_PATTERNS = [
  /[\\\/]\.codebuddy([\\\/]|$)/,           // .codebuddy/ or .codebuddy (no path part)
  /[\\\/]\.git([\\\/]|$)/,                 // .git/ or .git
  /[\\\/]assets([\\\/]|$)/,               // assets/ or assets (donation QR — not part of extension)
  /[\\\/]store-assets([\\\/]|$)/,          // store-assets/ (Chrome store listing assets)
  /[\\\/]scripts([\\\/]|$)/,              // scripts/ (PIL generation scripts)
  /lingoflow-[\d.]+\.zip$/,               // previous zip builds
  /[\\\/]create-icons\.html$/,            // one-off generator HTML
  /[\\\/]I18N_COMPLETE\.md$/,             // dev-only doc
  /[\\\/]INSTALL\.md$/,                   // install doc (not needed in extension)
  /[\\\/]pack-zip\.js$/,                  // this build script
  /[\\\/]find-dup-messages\.js$/,
  /[\\\/]hash-zip-messages\.js$/,
  /[\\\/]list-zip-entries\.js$/,
  /[\\\/]check-dup-keys\.js$/,
  /[\\\/]check-locale-struct\.js$/,
  /[\\\/]check-parse-strict\.js$/,
  /[\\\/]debug-exclude[\d]*\.js$/,
  /[\\\/]debug-regex\.js$/,
];

function shouldExclude(filePath) {
  const norm = filePath.replace(/\//g, '\\');
  return EXCLUDE_PATTERNS.some(rx => rx.test(norm));
}

const base = path.resolve('d:\\迅雷下载\\vibe coding\\Chrome Extensions\\LingoFlow');
const outZip = path.join(base, 'lingoflow-1.1.2.zip');

function collectFiles(dir, list = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (shouldExclude(full)) continue;
    if (e.isDirectory()) collectFiles(full, list);
    else list.push(full);
  }
  return list;
}

const files = collectFiles(base);
console.log('Files to include:', files.length);

const entries = [];
const centralDir = [];
let offset = 0;

for (const file of files) {
  const rel = path.relative(base, file).replace(/\\/g, '/');
  const data = fs.readFileSync(file);
  const compressed = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(rel);

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  entries.push(local, compressed);

  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc32(data), 16);
  cd.writeUInt32LE(compressed.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt32LE(0, 36);
  cd.writeUInt32LE(offset, 42);
  nameBuf.copy(cd, 46);
  centralDir.push(cd);
  offset += local.length + compressed.length;
}

const cdStart = offset;
const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdSize, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...entries, ...centralDir, eocd]);
fs.writeFileSync(outZip, zip);
console.log('Wrote', outZip, 'size', zip.length, 'entries', files.length);

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}