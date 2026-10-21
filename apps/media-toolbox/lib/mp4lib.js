// mp4lib.js — minimal ISO-BMFF (MP4/MOV) helpers shared by the Yunshuling media tools.
// Parsing works on a DataView (small buffers) or on File slices (streaming) for big files.

const HEADER = 8;

/** Read one box header at `off` (returns null when incomplete/invalid). */
export function readBox(view, off, limit) {
  if (off + HEADER > limit) return null;
  let size = view.getUint32(off);
  const type = String.fromCharCode(
    view.getUint8(off + 4), view.getUint8(off + 5), view.getUint8(off + 6), view.getUint8(off + 7),
  );
  let headerSize = HEADER;
  if (size === 1) {
    if (off + 16 > limit) return null;
    size = Number(view.getBigUint64(off + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = limit - off;
  }
  if (size < headerSize || off + size > limit) return null;
  return { type, start: off, headerSize, size, end: off + size };
}

/** Walk direct children of a container box. */
export function* childBoxes(view, parent) {
  let off = parent.start + parent.headerSize;
  while (off < parent.end) {
    const b = readBox(view, off, parent.end);
    if (!b) return;
    yield b;
    off = b.end;
  }
}

export function findChild(view, parent, type) {
  for (const b of childBoxes(view, parent)) if (b.type === type) return b;
  return undefined;
}

export function children(view, parent, type) {
  const out = [];
  for (const b of childBoxes(view, parent)) if (!type || b.type === type) out.push(b);
  return out;
}

/** handler type of a trak ('vide' / 'soun' / null). */
export function handlerOf(view, trak) {
  const mdia = findChild(view, trak, 'mdia');
  const hdlr = mdia && findChild(view, mdia, 'hdlr');
  if (!hdlr) return null;
  const p = hdlr.start + hdlr.headerSize + 8;
  return String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
}

/** All traks of a moov box, with their handler type. */
export function traksOf(view, moov) {
  return children(view, moov, 'trak').map((t) => ({ box: t, handler: handlerOf(view, t) }));
}

// ---------------------------------------------------------------- writers

export function u16(n) { return new Uint8Array([(n >> 8) & 255, n & 255]); }
export function u32(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
export function i32(n) { return u32(n >>> 0); }
export function u64(n) {
  const hi = Math.floor(n / 0x100000000), lo = n >>> 0;
  return concat(u32(hi), u32(lo));
}
export function fourcc(s) { return new Uint8Array([...s].map((c) => c.charCodeAt(0))); }
export function concat(...parts) {
  const flat = [];
  const push = (p) => { if (p instanceof Uint8Array) flat.push(p); else if (Array.isArray(p)) p.forEach(push); };
  parts.forEach(push);
  const len = flat.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
}

/** Build a box: length + type + payload. */
export function box(type, ...payload) {
  const body = concat(...payload);
  return concat(u32(body.length + 8), fourcc(type), body);
}

/** Build a full box (version + flags first). */
export function fullBox(type, version, flags, ...payload) {
  return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...payload);
}

export const IDENTITY_MATRIX = (() => {
  const m = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  return concat(...m.map(i32));
})();

// ---------------------------------------------------------------- sample tables

export function readStsc(view, stbl) {
  const b = findChild(view, stbl, 'stsc');
  if (!b) return [];
  const p = b.start + b.headerSize + 4;
  const n = view.getUint32(p);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p + 4 + i * 12;
    out.push({
      firstChunk: view.getUint32(o),
      samplesPerChunk: view.getUint32(o + 4),
      sdi: view.getUint32(o + 8),
    });
  }
  return out;
}

export function readStco(view, stbl) {
  const b64 = findChild(view, stbl, 'co64');
  if (b64) {
    const p = b64.start + b64.headerSize + 4;
    const n = view.getUint32(p);
    const out = [];
    for (let i = 0; i < n; i++) out.push(Number(view.getBigUint64(p + 4 + i * 8)));
    return out;
  }
  const b = findChild(view, stbl, 'stco');
  if (!b) return [];
  const p = b.start + b.headerSize + 4;
  const n = view.getUint32(p);
  const out = [];
  for (let i = 0; i < n; i++) out.push(view.getUint32(p + 4 + i * 4));
  return out;
}

export function readStsz(view, stbl) {
  const b = findChild(view, stbl, 'stsz');
  if (!b) return { uniform: 0, sizes: [] };
  const p = b.start + b.headerSize + 4;
  const uniform = view.getUint32(p);
  const count = view.getUint32(p + 4);
  if (uniform) return { uniform, sizes: new Array(count).fill(uniform) };
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(view.getUint32(p + 8 + i * 4));
  return { uniform: 0, sizes };
}

export function readMdhd(view, trak) {
  const mdia = findChild(view, trak, 'mdia');
  const b = mdia && findChild(view, mdia, 'mdhd');
  if (!b) return null;
  const p = b.start + b.headerSize;
  const version = view.getUint8(p);
  const q = p + 4;
  const timescale = version === 1 ? view.getUint32(q + 16) : view.getUint32(q + 8);
  const duration = version === 1 ? Number(view.getBigUint64(q + 20)) : view.getUint32(q + 12);
  const langOffset = version === 1 ? q + 28 : q + 16;
  const language = view.getUint16(langOffset);
  return { timescale, duration, language };
}

export function readTkhd(view, trak) {
  const b = findChild(view, trak, 'tkhd');
  if (!b) return null;
  const p = b.start + b.headerSize;
  const version = view.getUint8(p);
  const q = p + 4;
  const trackId = view.getUint32(version === 1 ? q + 16 : q + 8);
  const duration = version === 1 ? Number(view.getBigUint64(q + 24)) : view.getUint32(q + 16);
  return { trackId, duration };
}

/** Movie header fields (timescale is needed to interpret durations/edit lists). */
export function readMvhd(view, moov) {
  const b = findChild(view, moov, 'mvhd');
  if (!b) return null;
  const p = b.start + b.headerSize;
  const version = view.getUint8(p);
  const q = p + 4;
  const timescale = version === 1 ? view.getUint32(q + 16) : view.getUint32(q + 8);
  const duration = version === 1 ? Number(view.getBigUint64(q + 20)) : view.getUint32(q + 12);
  return { timescale, duration };
}

/** Sum of the edit-list segment durations (movie timescale), or null when no edts. */
export function readElstDuration(view, trak) {
  const edts = findChild(view, trak, 'edts');
  if (!edts) return null;
  const elst = findChild(view, edts, 'elst');
  if (!elst) return null;
  const p = elst.start + elst.headerSize;
  const version = view.getUint8(p);
  const n = view.getUint32(p + 4);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const o = p + 8 + i * (version === 1 ? 20 : 12);
    total += version === 1 ? Number(view.getBigUint64(o)) : view.getUint32(o);
  }
  return total;
}

/**
 * Rebuild a container box from its children, replacing/dropping some of them.
 * opts: { replace: { type: [Uint8Array,...] }, drop: ['type', ...] }
 * Returns the new box bytes (children keep their original size header style).
 */
export function rebuildBoxBytes(view, boxInfo, opts = {}) {
  const { replace = {}, drop = [] } = opts;
  const parts = [];
  for (const child of childBoxes(view, boxInfo)) {
    if (drop.includes(child.type)) continue;
    if (replace[child.type]) {
      for (const p of replace[child.type]) parts.push(p);
      continue;
    }
    parts.push(new Uint8Array(view.buffer, view.byteOffset + child.start, child.size).slice());
  }
  return box(boxInfo.type, ...parts);
}

/** Expand the sample table into [{offset, size}] in sample order. */
export function sampleList(view, stbl) {
  const stsc = readStsc(view, stbl);
  const offsets = readStco(view, stbl);
  const { uniform, sizes } = readStsz(view, stbl);
  const samples = [];
  let sampleIndex = 0;
  for (let ci = 0; ci < offsets.length; ci++) {
    const chunkNo = ci + 1;
    let entry = stsc[0];
    for (const e of stsc) if (e.firstChunk <= chunkNo) entry = e;
    const perChunk = entry ? entry.samplesPerChunk : 0;
    let pos = offsets[ci];
    for (let j = 0; j < perChunk && sampleIndex < sizes.length; j++) {
      const size = sizes[sampleIndex];
      samples.push({ offset: pos, size });
      pos += size;
      sampleIndex++;
    }
  }
  return samples;
}
