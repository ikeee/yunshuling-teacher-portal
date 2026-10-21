// mp4rotate.mjs — lossless MP4/MOV rotation by patching the track-header matrix.
// No re-encoding: only the 36-byte transform matrix in the video track's `tkhd` box is rewritten.
// Works in Node (test) and in the browser (via <script type="module">).

const HEADER = 8;

function u32(v) { return v >>> 0; }

/** Read one box header at `off`; returns {type, start, headerSize, size, end} or null. */
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
    size = limit - off; // box extends to the end
  }
  if (size < headerSize || off + size > limit) return null;
  return { type, start: off, headerSize, size, end: off + size };
}

/** Walk direct children inside [start+headerSize, end) of a container box. */
export function* childBoxes(view, parent) {
  let off = parent.start + parent.headerSize;
  while (off < parent.end) {
    const box = readBox(view, off, parent.end);
    if (!box) return;
    yield box;
    off = box.end;
  }
}

/** Find a direct child with the given type (or undefined). */
export function findChild(view, parent, type) {
  for (const box of childBoxes(view, parent)) if (box.type === type) return box;
  return undefined;
}

const IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/** Read the 9 matrix values of a tkhd box (int32, 16.16 / 2.30 fixed point). */
export function readTkhdMatrix(view, tkhd) {
  const version = view.getUint8(tkhd.start + HEADER);
  // payload after version+flags, then (time/trackID/duration), reserved[2], layer/alt/volume/reserved
  const matrixOffset = tkhd.start + HEADER + 4 + (version === 1 ? 32 : 20) + 8 + 8;
  const out = [];
  for (let i = 0; i < 9; i++) out.push(view.getInt32(matrixOffset + i * 4));
  return { matrix: out, offset: matrixOffset };
}

/** Multiply two 3x3 matrices given as [a,b,u, c,d,v, x,y,w] (16.16 / 2.30). */
export function multiply(m1, m2) {
  const r = new Array(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (m1[row * 3 + k] * m2[k * 3 + col]) / 0x10000;
      r[row * 3 + col] = Math.round(sum);
    }
  }
  return r;
}

/** Rotation matrix by `deg` (0/90/180/270), same convention as the tkhd matrix. */
export function rotationMatrix(deg) {
  const d = ((deg % 360) + 360) % 360;
  const one = 0x00010000;
  switch (d) {
    case 0: return IDENTITY.slice();
    case 90: return [0, one, 0, -one, 0, 0, 0, 0, 0x40000000];
    case 180: return [-one, 0, 0, 0, -one, 0, 0, 0, 0x40000000];
    case 270: return [0, -one, 0, one, 0, 0, 0, 0, 0x40000000];
    default: throw new Error('rotation must be 0/90/180/270');
  }
}

/** Guess the current rotation (0/90/180/270, clockwise) from a tkhd matrix. */
export function rotationDegrees(matrix) {
  const [a, b, , c] = matrix; // a,b,c,d (2x2 part)
  const near0 = (v) => Math.abs(v) < 3000;
  const near1 = (v) => Math.abs(v - 0x10000) < 3000;
  const nearM1 = (v) => Math.abs(v + 0x10000) < 3000;
  if (near1(a) && near0(b)) return 0;
  if (near0(a) && b > 0) return 90;        // [0,1,-1,0]
  if (nearM1(a) && near0(b)) return 180;
  if (near0(a) && b < 0) return 270;
  return 0;
}

/**
 * Patch the video track matrices inside a `moov` buffer (Uint8Array).
 * `deltaDeg` is applied on top of whatever rotation the file already has.
 * Returns { count } — number of video tracks patched.
 */
export function patchMoovBytes(bytes, deltaDeg) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = readBox(view, 0, bytes.byteLength);
  if (!moov || moov.type !== 'moov') throw new Error('not a moov box');
  const rot = rotationMatrix(deltaDeg);
  let count = 0;
  for (const trak of childBoxes(view, moov)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(view, trak, 'mdia');
    const hdlr = mdia && findChild(view, mdia, 'hdlr');
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      view.getUint8(hdlr.start + HEADER + 8), view.getUint8(hdlr.start + HEADER + 9),
      view.getUint8(hdlr.start + HEADER + 10), view.getUint8(hdlr.start + HEADER + 11),
    );
    if (handler !== 'vide') continue;
    const tkhd = findChild(view, trak, 'tkhd');
    if (!tkhd) continue;
    const { matrix, offset } = readTkhdMatrix(view, tkhd);
    const next = multiply(rot, matrix);
    for (let i = 0; i < 9; i++) view.setInt32(offset + i * 4, next[i] | 0);
    count++;
  }
  return { count };
}

/**
 * Browser/Node convenience: locate `moov` in the top-level box list of a DataView.
 * Returns { start, end } (end exclusive) or undefined.
 */
export function findMoovRange(view, limit = view.byteLength) {
  let off = 0;
  while (off < limit) {
    const box = readBox(view, off, limit);
    if (!box) return undefined;
    if (box.type === 'moov') return { start: box.start, end: box.end };
    off = box.end;
  }
  return undefined;
}
