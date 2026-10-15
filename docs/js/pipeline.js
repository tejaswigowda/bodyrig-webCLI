// pipeline.js -- stages 2-7 end to end, shared by the GUI, the command box and the Playwright harness.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { bakeMocap, canonical } from './mocap-bake.mjs';
import { findFaceMesh, blendshapeStatus, windowTimes, sampleFace, scaleFaceSamples, sampleHead, faceTracks, headTrack } from './face.mjs';
import { DEFAULTS } from './command.js';

export function downscaleTextures(model, max) {
  const seen = new Set(); let n = 0;
  model.traverse(o => {
    for (const m of [].concat(o.material || [])) for (const k in m) {
      const tex = m[k];
      if (!tex?.isTexture || seen.has(tex)) continue;
      seen.add(tex);
      const img = tex.image, w = img?.width, h = img?.height;
      if (!w || !h || Math.max(w, h) <= max) continue;
      const s = max / Math.max(w, h);
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      tex.image = c; tex.needsUpdate = true; n++;
    }
  });
  return n;
}

// --hide NAME[,NAME]: meshes whose own name or any parent group's name contains a NAME (case-insensitive).
export function meshesMatching(model, hide) {
  const names = String(hide ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) return [];
  const out = [];
  model.traverse(o => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== model; p = p.parent) if (names.some(n => p.name.toLowerCase().includes(n))) { out.push(o); return; }
  });
  return out;
}

// Preview: hide the matching meshes and show the ones a previous --hide hid. Returns how many match.
export function setMeshesHidden(model, hide) {
  const hit = new Set(meshesMatching(model, hide));
  model.traverse(o => {
    if (!o.isMesh) return;
    if (hit.has(o)) { if (o.visible) { o.visible = false; o.userData.hiddenByCommand = true; } }
    else if (o.userData.hiddenByCommand) { o.visible = true; delete o.userData.hiddenByCommand; }
  });
  return hit.size;
}

async function optimizeOffThread(glb, level) {
  try {
    const worker = new Worker(new URL('./optimize-worker.js', import.meta.url), { type: 'module' });
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => { worker.terminate(); data.ok ? resolve(data.glb) : reject(new Error(data.error)); };
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'optimizer worker failed')); };
      worker.postMessage({ glb: glb.slice(0), level }, []);
    });
  } catch {
    const { optimizeGLB } = await import('../vendor/gltf-optimize.js'); // module workers unavailable: fall back to the main thread
    return optimizeGLB(glb, { level });
  }
}

// FBXLoader marks every material transparent even at opacity 1, and keeps opacity in a separate alphaMap. glTF has
// neither: it exports BLEND (no depth write in Blender and most engines, so eyes, teeth and the body under clothes
// show through the skin) and drops the alphaMap (hair and lashes lose their cutouts). So each material is settled to
// OPAQUE, MASK (cutout) or BLEND, with any alphaMap folded into the base-colour texture's alpha.
function pixels(img, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  return { c, g, data: g.getImageData(0, 0, w, h) };
}

function alphaProfile(m) { // alpha comes from the alphaMap's green channel, else from the colour texture's own alpha
  const img = m.alphaMap?.image ?? m.map?.image, ch = m.alphaMap ? 1 : 3;
  const w = img?.width, h = img?.height; if (!w || !h) return img ? null : { lo: 0, mid: 0, pixels: 1 }; // no texture: nothing translucent
  try {
    const s = Math.min(1, 256 / Math.max(w, h)), d = pixels(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))).data.data;
    let lo = 0, mid = 0;
    for (let i = ch; i < d.length; i += 4) if (d[i] < 250) { lo++; if (d[i] > 20 && d[i] < 235) mid++; }
    return { lo, mid, pixels: d.length / 4 };
  } catch { return null; }
}

function foldAlphaMap(m) { // new texture = colour map with the alphaMap in its alpha channel; the original is untouched
  const mi = m.map?.image, ai = m.alphaMap.image;
  const w = mi?.width ?? ai.width, h = mi?.height ?? ai.height;
  const a = pixels(ai, w, h).data.data;
  let col; if (mi) col = pixels(mi, w, h); else { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); col = { c, g, data: g.getImageData(0, 0, w, h) }; }
  for (let i = 3; i < col.data.data.length; i += 4) col.data.data[i] = a[i - 2];
  col.g.putImageData(col.data, 0, 0);
  const src = m.map ?? m.alphaMap, t = new src.constructor(col.c);
  for (const k of ['colorSpace', 'flipY', 'wrapS', 'wrapT', 'minFilter', 'magFilter', 'anisotropy', 'channel', 'rotation', 'name']) t[k] = src[k];
  t.offset.copy(src.offset); t.repeat.copy(src.repeat); t.center.copy(src.center);
  if (!m.map) t.colorSpace = 'srgb';
  t.needsUpdate = true;
  return t;
}

export function settleAlphaModes(model) {
  const seen = new Set(), saved = [], modes = { opaque: 0, mask: 0, blend: 0 };
  model.traverse(o => {
    for (const m of [].concat(o.material || [])) {
      if (seen.has(m)) continue; seen.add(m);
      if (!m.transparent || m.opacity < 0.999) { if (m.transparent) modes.blend++; continue; }
      const p = alphaProfile(m);
      if (!p) { modes.blend++; continue; }
      saved.push([m, m.transparent, m.alphaTest, m.map, m.alphaMap]);
      if (p.lo < p.pixels * 0.001) { m.transparent = false; m.alphaMap = null; modes.opaque++; continue; }
      if (m.alphaMap) { m.map = foldAlphaMap(m); m.alphaMap = null; }
      // BLEND only for alpha that is soft over much of the texture (glass, smoke); hair and clothing atlases are cutouts
      if (p.mid < p.pixels * 0.4) { m.transparent = false; m.alphaTest = 0.5; modes.mask++; } else modes.blend++;
    }
  });
  return { modes, restore: () => { for (const [m, t, a, map, am] of saved) { if (m.map && m.map !== map) m.map.dispose(); m.transparent = t; m.alphaTest = a; m.map = map; m.alphaMap = am; m.needsUpdate = true; } } };
}

// GLTFExporter writes every texture as lossless PNG, which is most of the file for a typical character (50 of 60 MB
// for a 3 texture Mixamo character) and untouched by meshopt. Textures with no real alpha go out as JPEG instead.
export function jpegOpaqueTextures(model) {
  const seen = new Set(), done = [];
  model.traverse(o => {
    for (const m of [].concat(o.material || [])) for (const k in m) {
      const tex = m[k];
      if (!tex?.isTexture || seen.has(tex) || k === 'alphaMap' || tex.userData.mimeType) continue;
      seen.add(tex);
      const img = tex.image, w = img?.width, h = img?.height; if (!w || !h) continue;
      try {
        const s = Math.min(1, 256 / Math.max(w, h)), d = pixels(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))).data.data;
        let lo = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) lo++;
        if (lo < d.length / 4 * 0.001) { tex.userData.mimeType = 'image/jpeg'; done.push(tex); }
      } catch { /* tainted or undecodable: keep PNG */ }
    }
  });
  return { count: done.length, restore: () => { for (const t of done) delete t.userData.mimeType; } };
}

export async function exportGLB(model, clips, { optimize = true, level = 'medium', maxTex = 0, jpeg = true, hide = null, onOptimize } = {}) {
  const stages = [];
  let t = performance.now();
  const left = meshesMatching(model, hide).map(m => [m, m.parent]);
  for (const [m, p] of left) p.remove(m);
  const downscaled = maxTex ? downscaleTextures(model, maxTex) : 0;
  const alpha = settleAlphaModes(model);
  const jpegs = jpeg ? jpegOpaqueTextures(model) : { count: 0, restore() {} };
  let raw;
  try { raw = await new GLTFExporter().parseAsync(model, { binary: true, animations: [].concat(clips), onlyVisible: false }); }
  finally { jpegs.restore(); alpha.restore(); for (const [m, p] of left) p.add(m); }
  stages.push({ n: 7, name: 'export GLB', ms: Math.round(performance.now() - t), info: { kb: Math.round(raw.byteLength / 1024), animations: [].concat(clips).length, downscaledTextures: downscaled, jpegTextures: jpegs.count, hiddenMeshes: left.length, alphaModes: alpha.modes } });
  if (!optimize) return { glb: raw, raw, rawBytes: raw.byteLength, stages };
  await onOptimize?.();
  t = performance.now();
  const glb = await optimizeOffThread(raw, level);
  stages.push({ n: 7, name: 'optimize (meshopt)', ms: Math.round(performance.now() - t), info: { kb: Math.round(glb.byteLength / 1024), level } });
  return { glb, raw, rawBytes: raw.byteLength, stages };
}

// A unit is one body motion or one face record. Every unit becomes one animation clip in the GLB, named by its label.
//   units: [{ label?, body: { name, source } | null, face: { name, record } | null }]
//   morphMap: ARKit-52 name -> morph target name (--morph-map). Callers that still pass `motions` get one body unit each.
export async function runBake({ model, units, motions, opts = {}, map = {}, morphMap = {}, onProgress = () => {} }) {
  units ??= motions.map(m => ({ label: m.name, body: { name: m.name, source: m.source }, face: null }));
  if (!units.length) throw new Error('Nothing to bake.');
  const used = new Set();
  const unique = n => { let u = n, i = 2; while (used.has(u)) u = `${n}_${i++}`; used.add(u); return u; };
  const steps = units.length + 1 + (opts.optimize === false ? 0 : 1);
  let done = 0;
  const step = async label => { onProgress(done++ / steps, label); await new Promise(r => setTimeout(r)); }; // yield so the bar repaints
  const hidden = new Set(meshesMatching(model, opts.hide));
  const faceBest = units.some(u => u.face) ? findFaceMesh(model, { skip: o => hidden.has(o), morphMap }) : null;
  const headBone = findHead(model);
  const ctx = { model, opts, map, faceBest, headBone, restHead: headBone?.quaternion.clone() ?? null, unique };
  const baked = [];
  for (const [i, u] of units.entries()) {
    const label = unitLabel(u);
    await step(units.length > 1 ? `Retargeting ${label} (${i + 1}/${units.length})...` : `Retargeting ${label}...`);
    try { baked.push(bakeUnit(u, ctx)); }
    catch (e) { throw units.length > 1 ? new Error(`${label}: ${e.message}`) : e; }
  }
  const clips = baked.map(b => b.clip);
  const bodies = baked.filter(b => b.body);
  const report = { ...(bodies[0]?.body.report ?? emptyReport(model, opts)) };
  report.tracks = baked.map(b => ({ name: b.clip.name, frames: b.frames, duration: b.duration, mapped: b.mapped, bones: b.bones }));
  report.units = baked.map(b => b.info);
  if (!bodies.length) Object.assign(report, { frames: Math.max(...baked.map(b => b.frames)), duration: Math.max(...baked.map(b => b.duration)), fps: opts.fps });
  report.blendshapes = faceBest || units.some(u => u.face) ? blendshapeStatus(faceBest?.matched, { meshName: faceBest?.mesh.name }) : null;
  if (bodies.length > 1) report.stages = bodies.flatMap(b => b.body.report.stages.map(s => ({ ...s, name: `${s.name} [${b.clip.name}]` }))).sort((a, b) => a.n - b.n);
  await step('Exporting GLB...');
  const exp = await exportGLB(model, clips, { ...opts, onOptimize: () => step('Compressing meshes and textures (meshopt)...') });
  report.stages.push(...exp.stages);
  return { clips, clip: clips[0], glb: exp.glb, raw: exp.raw, report, rawBytes: exp.rawBytes };
}

const unitLabel = u => u.label ?? u.body?.name ?? u.face.name;

function bakeUnit(u, { model, opts, map, faceBest, headBone, restHead, unique }) {
  const { fps } = opts;
  const name = unique(unitLabel(u));
  let body = null, w;
  if (u.body) {
    w = windowTimes(u.body.source.clip.duration, opts.trim, fps);
    body = bakeMocap(model, u.body.source, { fps, trim: opts.trim, inPlace: opts.inPlace, loop: opts.loop, align: opts.align, footLock: opts.footLock, map, name });
  } else {
    const rec = u.face.record;
    w = windowTimes(rec.duration, opts.trim, fps);
  }
  const info = { name, body: !!u.body, face: null, head: null };
  let faceTr = [], headTr = null;
  if (u.face) {
    const rec = u.face.record;
    const usable = new Map([...(faceBest?.matched ?? [])].filter(([a]) => rec.channels.includes(a)));
    if (!usable.size) {
      const reason = !faceBest ? 'this model has no morph targets whose names match ARKit-52 (try --morph-map)'
        : `none of the ${rec.channels.length} channels in ${u.face.name} match a morph target on this model (try --morph-map)`;
      throw new Error(`${reason}.`);
    } else {
      // Window times are relative to the recording's start; the record's t0 is an epoch, so it is added here once.
      const faceT0 = rec.t0 + w.t0;
      const s = sampleFace(rec, faceT0, w.times);
      scaleFaceSamples(s.samples, opts.faceStrength ?? DEFAULTS.faceStrength);
      faceTr = faceTracks(faceBest.meshes, usable, w.times, s.samples);
      info.face = { status: 'baked', channels: usable.size, outOfRange: s.outOfRange, strength: opts.faceStrength ?? DEFAULTS.faceStrength, reason: null };
    }
    if (opts.faceHead) {
      if (!headBone) info.head = 'skipped: no head bone on this model';
      else if (!rec.head) info.head = 'skipped: the face record has no head rotation';
      else { headTr = headTrack(headBone.name, w.times, sampleHead(rec, rec.t0 + w.t0, w.times, restHead)); info.head = 'face'; }
    }
  }
  const duration = w.times[w.times.length - 1];
  const clip = new THREE.AnimationClip(name, duration, [...(body?.clip.tracks ?? []), ...faceTr, ...(headTr ? [headTr] : [])]);
  return { clip, body, info, frames: w.n, duration, mapped: body?.report.mapped ?? 0, bones: body?.report.bones ?? 0 };
}

// The head bone is the first bone canonical-named Head, the same rule bakeMocap uses for the body.
const findHead = model => { let h = null; model.traverse(o => { if (!h && o.isBone && canonical(o.name) === 'Head') h = o; }); return h; };

function emptyReport(model, opts) {
  const bones = new Set(); model.traverse(o => { if (o.isSkinnedMesh) o.skeleton.bones.forEach(b => bones.add(b)); });
  return { frames: 0, fps: opts.fps, duration: 0, mapped: 0, bones: bones.size, missingCore: [], unmapped: [], stages: [] };
}

export function bytesToBase64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
