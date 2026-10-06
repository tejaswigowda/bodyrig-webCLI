// verify.mjs -- (1) glTF validator, (2) re-import the GLB and compare limb directions against the BVH source.
// Works for any rig: bones are matched through the same canonical-name table the engine uses.
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import validator from 'gltf-validator';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder as GTDecoder } from 'meshoptimizer';
import { canonical } from '../docs/js/mocap-bake.mjs';

globalThis.self ??= globalThis;

export const SEGMENTS = [['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
  ['Hips', 'Spine'], ['Spine', 'Spine1'], ['Spine1', 'Neck'], ['Neck', 'Head']];
export const KEY_JOINTS = ['Hips', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'];

// Node has no DOM, so textures cannot decode; drop them (and the meshopt wrapper) before three's GLTFLoader reads the file.
async function loadableGLB(buf) {
  await GTDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': GTDecoder });
  const doc = await io.readBinary(new Uint8Array(buf));
  for (const t of doc.getRoot().listTextures()) t.dispose();
  for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName === 'EXT_meshopt_compression') e.dispose(); // data is already decoded
  const bytes = await io.writeBinary(doc);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const byCanon = root => { const m = new Map(); root.traverse(o => { if (o.isBone || o.type === 'Bone') m.set(canonical(o.name), o); }); return m; };
const dir = (a, b) => b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3())).normalize();
const pct = (arr, p) => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

export async function loadGLB(buf) {
  const ab = await loadableGLB(buf);
  return new Promise((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(ab, '', res, rej));
}

export async function verifyGLB(glb, bvhText, { step = 0.5, offset = 0, clipIndex = 0 } = {}) {
  const u8 = new Uint8Array(glb);
  const jsonLen = new DataView(u8.buffer, u8.byteOffset).getUint32(12, true);
  const meshopt = (JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen))).extensionsUsed ?? []).includes('EXT_meshopt_compression');
  const report = await validator.validateBytes(u8);
  const gltf = await loadGLB(glb);
  const bvh = new BVHLoader().parse(bvhText);
  bvh.skeleton.bones.forEach(b => { b.name = b.name.replace(/^.*:/, ''); });
  bvh.clip.tracks.forEach(t => { t.name = t.name.replace(/^.*:/, ''); });
  const srcRoot = new THREE.Group(); srcRoot.add(bvh.skeleton.bones[0]);
  const clip = gltf.animations[clipIndex];
  const srcMixer = new THREE.AnimationMixer(srcRoot); srcMixer.clipAction(bvh.clip).play();
  const tgtMixer = new THREE.AnimationMixer(gltf.scene); tgtMixer.clipAction(clip).play();
  const S = byCanon(srcRoot), T = byCanon(gltf.scene);

  const errs = {}, usable = SEGMENTS.filter(([a, b]) => S.has(a) && S.has(b) && T.has(a) && T.has(b));
  for (const [a, b] of usable) errs[`${a}>${b}`] = [];
  const dur = Math.min(clip.duration, bvh.clip.duration - offset); // GLB time 0 is BVH time `offset` when trimmed
  for (let t = 0; t <= dur - 1e-6; t += step) {
    srcMixer.setTime(t + offset); tgtMixer.setTime(t);
    srcRoot.updateMatrixWorld(true); gltf.scene.updateMatrixWorld(true);
    for (const [a, b] of usable) errs[`${a}>${b}`].push(THREE.MathUtils.radToDeg(dir(S.get(a), S.get(b)).angleTo(dir(T.get(a), T.get(b)))));
  }
  const limb = Object.fromEntries(Object.entries(errs).map(([k, a]) => [k, { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p95: +pct(a, 0.95).toFixed(2) }]));
  const allMean = Object.values(limb).reduce((s, v) => s + v.mean, 0) / Math.max(1, Object.keys(limb).length);

  // Golden joint positions, normalised by the character's height so the check is unit-free.
  gltf.scene.updateMatrixWorld(true); tgtMixer.setTime(0); gltf.scene.updateMatrixWorld(true);
  const ys = []; gltf.scene.traverse(o => { if (o.isBone) ys.push(o.getWorldPosition(new THREE.Vector3()).y); });
  const height = Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
  const golden = {};
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    tgtMixer.setTime(clip.duration * frac); gltf.scene.updateMatrixWorld(true);
    golden[frac] = Object.fromEntries(KEY_JOINTS.filter(j => T.has(j)).map(j => [j, T.get(j).getWorldPosition(new THREE.Vector3()).divideScalar(height).toArray().map(x => +x.toFixed(3))]));
  }
  return {
    validator: { errors: report.issues.numErrors, warnings: report.issues.numWarnings, top: report.issues.messages.filter(m => m.severity <= 1).slice(0, 5).map(m => `${m.code}: ${m.message}`) },
    animation: { name: clip.name, duration: +clip.duration.toFixed(3), tracks: clip.tracks.length },
    animations: gltf.animations.map(a => ({ name: a.name, duration: +a.duration.toFixed(3), tracks: a.tracks.length })),
    skins: gltf.parser.json.skins?.length ?? 0, limb, meanLimbErrorDeg: +allMean.toFixed(2), golden,
    meshopt,
  };
}

export function compareGolden(actual, expected, tol = 0.02) {
  const diffs = [];
  for (const [frac, joints] of Object.entries(expected)) for (const [j, p] of Object.entries(joints)) {
    const a = actual[frac]?.[j]; if (!a) { diffs.push(`${frac}/${j} missing`); continue; }
    const d = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
    if (d > tol) diffs.push(`${frac}/${j} moved ${d.toFixed(3)} (> ${tol})`);
  }
  return diffs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [glbPath, bvhPath] = process.argv.slice(2);
  if (!glbPath || !bvhPath) { console.error('usage: node tests/verify.mjs out.glb motion.bvh'); process.exit(2); }
  const r = await verifyGLB(fs.readFileSync(glbPath), fs.readFileSync(bvhPath, 'utf8'));
  delete r.golden;
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.validator.errors ? 1 : 0);
}
