#!/usr/bin/env node
'use strict';
/**
 * Generates icon16.png, icon48.png, icon128.png
 * Pure Node.js — no external dependencies, only zlib (built-in).
 * Renders a magnifying-glass lens in indigo (#6366f1) on dark background.
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf  = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf  = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Distance from point to segment ────────────────────────────────────────
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ── Render one icon to RGB pixels ──────────────────────────────────────────
function renderPixels(size) {
  const cx = size * 0.41, cy = size * 0.41;   // lens centre
  const r  = size * 0.31;                       // lens radius
  const sw = Math.max(1.2, size * 0.075);       // stroke width

  // Handle: from lower-right of circle toward corner
  const hx1 = cx + r * 0.69, hy1 = cy + r * 0.69;
  const hx2 = size * 0.87,   hy2 = size * 0.87;

  // Indigo colour components
  const IR = 99, IG = 102, IB = 241;
  // Fill (dark indigo tint)
  const FR = 14, FG = 14, FB = 40;
  // Background
  const BR = 10, BG = 10, BB = 15;

  const buf = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist  = Math.hypot(x - cx, y - cy);
      const hDist = distToSeg(x, y, hx1, hy1, hx2, hy2);

      let r_ = BR, g_ = BG, b_ = BB;

      if (dist < r - sw)                              { r_ = FR; g_ = FG; b_ = FB; } // fill
      if (dist >= r - sw && dist <= r + sw)           { r_ = IR; g_ = IG; b_ = IB; } // ring
      if (hDist <= sw && dist >= r - sw * 0.5)        { r_ = IR; g_ = IG; b_ = IB; } // handle

      buf.push(r_, g_, b_);
    }
  }
  return buf;
}

// ── Build PNG bytes ────────────────────────────────────────────────────────
function makePNG(size) {
  const pixels = renderPixels(size);

  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB

  // Raw scanlines: 1 filter byte + width*3 RGB bytes per row
  const raw = Buffer.alloc(size * (1 + size * 3));
  let pi = 0;
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 3)] = 0;            // filter: None
    for (let x = 0; x < size; x++) {
      const off = y * (1 + size * 3) + 1 + x * 3;
      raw[off]     = pixels[pi++];
      raw[off + 1] = pixels[pi++];
      raw[off + 2] = pixels[pi++];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write icons ────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const buf     = makePNG(size);
  const outPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`  icon${size}.png  (${buf.length} bytes)`);
}

console.log('Icons ready in ./icons/');
