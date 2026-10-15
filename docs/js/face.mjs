// face.mjs -- face (ARKit-52 blendshape) animation: parse capture JSON, match names to morph targets,
// report blendshape status, and build morph-weight and head-rotation tracks on the shared timeline.
// Pure functions (no DOM) so the same code runs in the browser and in Node tests.
import * as THREE from 'three';

export const ARKIT_52 = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
  'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthPressLeft', 'mouthPressRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];
const ARKIT_SET = new Set(ARKIT_52);

// True for the face-record JSON written by mocap-webCLI (type "face-record") or any {fps, channels, frames} capture.
export function isFaceRecord(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && (obj.type === 'face-record' || obj.schema === 'arkit-52')
    && Array.isArray(obj.channels) && Array.isArray(obj.frames) && +obj.fps > 0;
}

// Validates a face record and returns clean arrays. Unknown channel names are dropped and listed in `ignored`.
export function parseFaceRecord(obj) {
  if (!isFaceRecord(obj)) throw new Error('Not a face record: expected {type:"face-record", fps, channels, frames}.');
  const keep = [], ignored = [];
  obj.channels.forEach((name, i) => (ARKIT_SET.has(name) ? keep.push(i) : ignored.push(String(name))));
  if (!keep.length) throw new Error('Face record has no ARKit-52 channel names.');
  const frames = obj.frames.map((row, f) => {
    if (!Array.isArray(row) || row.length !== obj.channels.length) {
      throw new Error(`Face frame ${f} has ${Array.isArray(row) ? row.length : 'no'} values; expected ${obj.channels.length}.`);
    }
    const out = {};
    for (const i of keep) { const v = +row[i]; out[obj.channels[i]] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }
    return out;
  });
  const head = Array.isArray(obj.head) && obj.head.length ? obj.head.map(q => q.map(Number)) : null;
  if (head && head.some(q => q.length !== 4 || q.some(v => !Number.isFinite(v)))) throw new Error('Face record "head" must be [qx,qy,qz,qw] per frame.');
  const fps = +obj.fps, t0 = Number.isFinite(+obj.t0) ? +obj.t0 : 0;
  return { fps, t0, channels: keep.map(i => obj.channels[i]), frames, head, ignored, duration: (frames.length - 1) / fps };
}

// A morph map is {ARKitName: targetName}. Every key must be an ARKit-52 name and every value a string.
export function isMorphMap(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every(k => ARKIT_SET.has(k) && typeof obj[k] === 'string');
}

export function parseMorphMap(obj) {
  if (!isMorphMap(obj)) throw new Error('Morph map must be a JSON object of {ARKitName: targetName}, e.g. {"jawOpen": "Mouth_Open"}.');
  return { ...obj };
}

export const normalizeName = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Maps each ARKit name to the morph target name it drives. Explicit morph-map entries win; otherwise names are matched
// after lowercasing and removing punctuation, so "eyeBlink_Left", "EyeBlinkLeft" and "eye blink left" all match.
export function matchBlendshapes(targetNames, morphMap = {}) {
  const byNorm = new Map();
  for (const t of targetNames) { const k = normalizeName(t); if (!byNorm.has(k)) byNorm.set(k, t); }
  const out = new Map();
  for (const a of ARKIT_52) {
    if (morphMap[a] && targetNames.includes(morphMap[a])) out.set(a, morphMap[a]);
    else if (!morphMap[a] && byNorm.has(normalizeName(a))) out.set(a, byNorm.get(normalizeName(a)));
  }
  return out;
}

// Human-readable blendshape status for the UI, the log, and the result metadata.
export function blendshapeStatus(matched, { meshName = null } = {}) {
  const n = matched ? matched.size : 0;
  const missing = ARKIT_52.filter(a => !matched || !matched.has(a));
  const level = n === 0 ? 'none' : n === ARKIT_52.length ? 'ok' : 'partial';
  const text = n === 0
    ? 'Blendshapes: none. The model has no morph targets that match ARKit-52 names. Face JSON will be skipped unless you add a --morph-map.'
    : `Blendshapes: ${n}/${ARKIT_52.length} ARKit names found${meshName ? ` on "${meshName}"` : ''}.`
      + (missing.length ? ` Missing ${missing.length}${missing.length <= 6 ? `: ${missing.join(', ')}` : ` (e.g. ${missing.slice(0, 4).join(', ')}, ...)`}.` : '');
  return { level, matched: n, total: ARKIT_52.length, missing, text };
}

// Finds the mesh whose morph targets match the most ARKit names, plus every other usable mesh with the same morph set.
// A VRM face is usually split into several meshes (skin, eyes, brows, mouth) that all carry the same 52 targets, so
// the weights must drive all of them or only one part of the face moves. Skips meshes the caller excludes (e.g.
// --hide), and skips names that three.js cannot bind as a track target (sanitized name differs, or a duplicate name).
export function findFaceMesh(root, { skip = () => false, morphMap = {} } = {}) {
  const meshes = [];
  root.traverse(o => { if (o.isMesh && o.morphTargetDictionary && !skip(o)) meshes.push(o); });
  const counts = new Map();
  for (const m of meshes) counts.set(m.name, (counts.get(m.name) || 0) + 1);
  const usable = meshes.filter(m => m.name && THREE.PropertyBinding.sanitizeNodeName(m.name) === m.name && counts.get(m.name) === 1);
  let best = null;
  for (const m of usable) {
    const matched = matchBlendshapes(Object.keys(m.morphTargetDictionary), morphMap);
    if (!best || matched.size > best.matched.size) best = { mesh: m, matched };
  }
  if (!best) return null;
  const key = m => Object.keys(m.morphTargetDictionary).join('\n');
  const bestKey = key(best.mesh);
  best.meshes = usable.filter(m => key(m) === bestKey);
  return best;
}

// Times for a window, using the same rule as bakeMocap so body and face frames line up sample for sample.
export function windowTimes(duration, trim, fps) {
  const D = duration;
  const t0 = Math.min(Math.max(trim?.[0] ?? 0, 0), D), t1 = Math.min(Math.max(trim?.[1] ?? D, t0), D);
  const n = Math.floor((t1 - t0) * fps + 1e-9) + 1;
  if (n < 2) throw new Error(`Trim window ${t0.toFixed(2)}-${t1.toFixed(2)} s is too short at ${fps} fps.`);
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i / fps;
  return { t0, times, n };
}

// Samples the face record on the window's timeline (absolute time = t0 + times[i]) with linear interpolation.
// Times outside the recording hold the nearest frame; `outOfRange` counts those samples so the report can say so.
export function sampleFace(record, t0, times) {
  const last = record.frames.length - 1;
  const samples = new Map(record.channels.map(c => [c, new Float32Array(times.length)]));
  let outOfRange = 0;
  for (let i = 0; i < times.length; i++) {
    const s = (t0 + times[i] - record.t0) * record.fps;
    if (s < 0 || s > last) outOfRange++;
    const c = Math.min(last, Math.max(0, s)), i0 = Math.floor(c), i1 = Math.min(i0 + 1, last), f = c - i0;
    const a = record.frames[i0], b = record.frames[i1];
    for (const ch of record.channels) samples.get(ch)[i] = a[ch] + (b[ch] - a[ch]) * f;
  }
  return { samples, outOfRange };
}

// Scales every morph weight by `strength` and clamps to 0-1, the range an authored morph target is defined over.
// Values above 1 can only lift the mid-range; they cannot push a morph past its full authored shape.
export function scaleFaceSamples(samples, strength) {
  for (const values of samples.values())
    for (let i = 0; i < values.length; i++) values[i] = Math.min(1, Math.max(0, values[i] * strength));
  return samples;
}

// Head rotation samples (flat quaternions, xyzw), slerped on the same timeline. Each capture quaternion is converted
// by a 180 degree turn about x, then applied to the rest pose: local = rest * convert(q). This axis convention is
// unverified against a real capture, which is why --face-head is opt-in.
export function sampleHead(record, t0, times, restQuat = new THREE.Quaternion()) {
  const last = record.head.length - 1;
  const out = new Float32Array(times.length * 4);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), q = new THREE.Quaternion();
  const convert = ([x, y, z, w]) => [x, -y, -z, w];
  for (let i = 0; i < times.length; i++) {
    const s = Math.min(last, Math.max(0, (t0 + times[i] - record.t0) * record.fps));
    const i0 = Math.floor(s), i1 = Math.min(i0 + 1, last), f = s - i0;
    qa.fromArray(convert(record.head[i0])); qb.fromArray(convert(record.head[i1]));
    q.slerpQuaternions(qa, qb, f).premultiply(restQuat).normalize();
    q.toArray(out, i * 4);
  }
  return out;
}

// One NumberKeyframeTrack per matched target per mesh, each bound to that mesh's node name.
export function faceTracks(meshes, matched, times, samples) {
  const tracks = [];
  for (const mesh of meshes) {
    for (const [arkit, target] of matched) {
      const values = samples.get(arkit);
      if (!values || !(target in mesh.morphTargetDictionary)) continue;
      tracks.push(new THREE.NumberKeyframeTrack(`${mesh.name}.morphTargetInfluences[${target}]`, times, values));
    }
  }
  return tracks;
}

export const headTrack = (headName, times, quats) => new THREE.QuaternionKeyframeTrack(`${headName}.quaternion`, times, quats);
