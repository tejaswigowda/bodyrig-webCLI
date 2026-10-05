// live.js -- record a timestamped BVH-style stream (e.g. Mesquite / index_ws) and resample it to a fixed-fps BVH for the same bake.
// Protocol (WebSocket text messages, client never sends anything):
//   1. a BVH hierarchy header (text starting with "HIERARCHY", optionally followed by a MOTION block that is ignored), or one supplied locally
//   2. one frame per message: whitespace-separated channel values in BVH order, a JSON array of numbers, or {"t": seconds, "values": [...]}
// Frames without "t" are stamped with their arrival time.

export function parseChannels(header) {
  const kinds = [];
  for (const m of header.matchAll(/CHANNELS\s+(\d+)\s+([^\n\r]+)/g)) {
    const names = m[2].trim().split(/\s+/).slice(0, +m[1]);
    for (const n of names) kinds.push(/rotation/i.test(n) ? 'rot' : 'pos');
  }
  return kinds;
}

export function headerOnly(text) {
  const i = text.search(/\bMOTION\b/);
  return (i >= 0 ? text.slice(0, i) : text).trimEnd() + '\n';
}

export function parseFrameMessage(data, nowSec) {
  const s = String(data).trim();
  if (!s) return null;
  if (s[0] === '{' || s[0] === '[') {
    const j = JSON.parse(s);
    const values = Array.isArray(j) ? j : j.values;
    if (!Array.isArray(values) || !values.every(Number.isFinite)) return null;
    return { t: Array.isArray(j) || typeof j.t !== 'number' ? nowSec : j.t, values };
  }
  const values = s.split(/\s+/).map(Number);
  return values.every(Number.isFinite) ? { t: nowSec, values } : null;
}

const lerpAngle = (a, b, k) => {
  let d = b - a; d -= 360 * Math.round(d / 360);
  return a + d * k;
};

// frames: [{t, values}] sorted by t. Returns rows at exact 1/fps spacing starting at frames[0].t.
export function resample(frames, kinds, fps) {
  if (frames.length < 2) throw new Error('Need at least two frames to resample.');
  const t0 = frames[0].t, tEnd = frames[frames.length - 1].t;
  const n = Math.floor((tEnd - t0) * fps + 1e-9) + 1, rows = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fps;
    while (j < frames.length - 2 && frames[j + 1].t <= t) j++;
    const a = frames[j], b = frames[j + 1], span = b.t - a.t, k = span > 0 ? Math.min(Math.max((t - a.t) / span, 0), 1) : 0;
    rows.push(a.values.map((v, c) => (kinds[c] === 'rot' ? lerpAngle(v, b.values[c], k) : v + (b.values[c] - v) * k)));
  }
  return rows;
}

export function buildBVH(header, rows, fps) {
  const f = x => +x.toFixed(6);
  return `${headerOnly(header)}MOTION\nFrames: ${rows.length}\nFrame Time: ${(1 / fps).toFixed(8)}\n${rows.map(r => r.map(f).join(' ')).join('\n')}\n`;
}

export class LiveRecorder {
  constructor() { this.header = null; this.kinds = []; this.frames = []; this.bad = 0; }
  setHeader(text) { this.header = headerOnly(text); this.kinds = parseChannels(this.header); this.frames = []; this.bad = 0; }
  push(data, nowSec) {
    let f; try { f = parseFrameMessage(data, nowSec); } catch { f = null; }
    if (!f || f.values.length !== this.kinds.length) { this.bad++; return false; }
    if (this.frames.length && f.t <= this.frames[this.frames.length - 1].t) { this.bad++; return false; }
    this.frames.push(f); return true;
  }
  get seconds() { return this.frames.length > 1 ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0; }
  toBVH(fps) {
    if (!this.header) throw new Error('No hierarchy header received yet.');
    return buildBVH(this.header, resample(this.frames, this.kinds, fps), fps);
  }
}

// Returns a handle; the page only ever reads from the socket.
export function connectLive(url, { header, onHeader, onFrame, onState }) {
  const rec = new LiveRecorder();
  if (header) rec.setHeader(header);
  const ws = new WebSocket(url);
  ws.onopen = () => onState?.('open');
  ws.onclose = () => onState?.('closed');
  ws.onerror = () => onState?.('error');
  ws.onmessage = e => {
    if (typeof e.data !== 'string') return;
    if (/^\s*HIERARCHY/.test(e.data)) { rec.setHeader(e.data); onHeader?.(rec); return; }
    if (rec.header && rec.push(e.data, performance.now() / 1000)) onFrame?.(rec);
  };
  return { rec, close: () => ws.close(), ws };
}
