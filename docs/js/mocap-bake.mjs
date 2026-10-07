// mocap-bake.mjs -- skinned model (already loaded by three.js) + BVH -> AnimationClip baked onto the model's own skeleton.
// Browser-first, no server, no model weights. Dependency-light: only three.js.
// Stages (each reported in `report.stages`): 2 normalize rig, 3 map bones, 4 align reference pose, 5 transfer rotations, 6 root motion.
// Stages 1 (load) and 7 (export + optimize) live in pipeline.js so this module stays reusable.
import * as THREE from 'three';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';

// Deterministic synonym table (Mixamo / Mesquite "mm" / CMU-Daz / VRoid / Rigify / UE / common game rigs). Extend as rigs appear.
export const SYNONYMS = {
  Hips: ['hips', 'hip', 'pelvis', 'root', 'j_bip_c_hips'],
  Spine: ['spine', 'abdomen', 'spine01', 'spine_01', 'spine001', 'j_bip_c_spine'],
  Spine1: ['spine1', 'spine02', 'spine_02', 'spine002', 'chest', 'j_bip_c_chest'],
  Spine2: ['spine2', 'spine03', 'spine_03', 'spine003', 'upperchest', 'j_bip_c_upperchest'],
  Neck: ['neck', 'neck01', 'neck_01', 'j_bip_c_neck'], Head: ['head', 'j_bip_c_head'],
  LeftShoulder: ['leftshoulder', 'lcollar', 'clavicle_l', 'l_clavicle', 'leftcollar', 'shoulderl', 'j_bip_l_shoulder'],
  RightShoulder: ['rightshoulder', 'rcollar', 'clavicle_r', 'r_clavicle', 'rightcollar', 'shoulderr', 'j_bip_r_shoulder'],
  LeftArm: ['leftarm', 'lshldr', 'upperarm_l', 'l_upperarm', 'leftupperarm', 'upper_arml', 'j_bip_l_upperarm'],
  RightArm: ['rightarm', 'rshldr', 'upperarm_r', 'r_upperarm', 'rightupperarm', 'upper_armr', 'j_bip_r_upperarm'],
  LeftForeArm: ['leftforearm', 'lforearm', 'lowerarm_l', 'l_forearm', 'leftlowerarm', 'forearml', 'j_bip_l_lowerarm'],
  RightForeArm: ['rightforearm', 'rforearm', 'lowerarm_r', 'r_forearm', 'rightlowerarm', 'forearmr', 'j_bip_r_lowerarm'],
  LeftHand: ['lefthand', 'lhand', 'hand_l', 'l_hand', 'handl', 'j_bip_l_hand'],
  RightHand: ['righthand', 'rhand', 'hand_r', 'r_hand', 'handr', 'j_bip_r_hand'],
  LeftUpLeg: ['leftupleg', 'lthigh', 'thigh_l', 'l_thigh', 'leftupperleg', 'thighl', 'j_bip_l_upperleg'],
  RightUpLeg: ['rightupleg', 'rthigh', 'thigh_r', 'r_thigh', 'rightupperleg', 'thighr', 'j_bip_r_upperleg'],
  LeftLeg: ['leftleg', 'lshin', 'calf_l', 'l_calf', 'leftlowerleg', 'shinl', 'j_bip_l_lowerleg'],
  RightLeg: ['rightleg', 'rshin', 'calf_r', 'r_calf', 'rightlowerleg', 'shinr', 'j_bip_r_lowerleg'],
  LeftFoot: ['leftfoot', 'lfoot', 'foot_l', 'l_foot', 'footl', 'j_bip_l_foot'],
  RightFoot: ['rightfoot', 'rfoot', 'foot_r', 'r_foot', 'footr', 'j_bip_r_foot'],
  LeftToeBase: ['lefttoebase', 'ball_l', 'l_toe', 'lefttoes', 'toel', 'j_bip_l_toebase'],
  RightToeBase: ['righttoebase', 'ball_r', 'r_toe', 'righttoes', 'toer', 'j_bip_r_toebase'],
};
export const CORE_BONES = Object.keys(SYNONYMS);

const key = n => n.replace(/^.*[:|]/, '').replace(/^(mixamorig\d*|mm(?=[A-Z])|bip\d*_?|def-)/i, '').replace(/[\s.]/g, '').toLowerCase();
const LOOKUP = new Map(Object.entries(SYNONYMS).flatMap(([canon, list]) => list.map(s => [s, canon])));
export const canonical = n => LOOKUP.get(key(n)) || key(n); // unknown names fall through (fingers etc. still match 1:1)

// three's PropertyBinding reserves ':' -- namespaced rigs ("Actor:Hips") silently fail to animate.
const stripNs = n => n.replace(/^.*:/, '');

export function parseBVH(text) {
  const bvh = new BVHLoader().parse(text);
  bvh.skeleton.bones.forEach(b => { b.name = stripNs(b.name); });
  bvh.clip.tracks.forEach(t => { t.name = stripNs(t.name); });
  // BVHLoader adds the root OFFSET to the position channels. Some exporters (Mesquite, Motive) write absolute positions
  // that already equal the OFFSET on frame 0, which doubles the root height and flings the character off the floor.
  const root = bvh.skeleton.bones[0], track = bvh.clip.tracks.find(t => t.name === `${root.name}.position`);
  if (track) {
    const o = root.position, v = track.values;
    if (o.length() > 1e-3 && Math.hypot(v[0] - 2 * o.x, v[1] - 2 * o.y, v[2] - 2 * o.z) < 0.1 * o.length()) {
      for (let i = 0; i < v.length; i += 3) { v[i] -= o.x; v[i + 1] -= o.y; v[i + 2] -= o.z; }
      bvh.absoluteRootPosition = true;
    }
  }
  return bvh;
}

// A motion source is { bones, root, clip }: `root` is added to a scratch group and animated by `clip`; `bones` are the
// joints the clip drives. A BVH is one; so is every clip of an FBX / GLB animation file.
export const motionFromBVH = bvh => ({ bones: bvh.skeleton.bones, root: bvh.skeleton.bones[0], clip: bvh.clip });

export function motionsFromObject(object, animations) {
  if (!animations?.length) throw new Error('The file has no animation clips.');
  let bones = []; object.traverse(o => { if (o.isBone) bones.push(o); });
  if (!bones.length) { // animation-only glTF: joints are plain nodes, found through the clips' track targets
    const seen = new Set();
    for (const clip of animations) for (const t of clip.tracks) {
      const n = t.name.slice(0, t.name.lastIndexOf('.')), o = object.getObjectByName(n);
      if (o && !seen.has(o)) { seen.add(o); bones.push(o); }
    }
  }
  if (bones.length < 2) throw new Error('No skeleton found in the animation file.');
  object.updateMatrixWorld(true);
  return animations.map(clip => ({ bones, root: object, clip }));
}

// Rig normalization. FBXLoader (and rigs saved from it, e.g. Mesquite's rig.json) can nest a same-named
// "twin" bone under each real bone, one set per skin. Collapse twins onto their parent, rebind every skin
// to the shared bones, and treat the union of all skins' bones as one skeleton (multi-mesh characters).
export function normalizeRig(model) {
  const skinned = []; model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) throw new Error('No SkinnedMesh found -- the model is not rigged.');
  model.updateMatrixWorld(true);
  const real = b => { while (b.parent?.isBone && b.parent.name === b.name) b = b.parent; return b; };
  let removed = 0;
  for (const sm of skinned) {
    const mapped = sm.skeleton.bones.map(real);
    if (mapped.some((b, i) => b !== sm.skeleton.bones[i])) sm.bind(new THREE.Skeleton(mapped), sm.bindMatrix);
  }
  // glTF requires skin.skeleton (exported as bones[0]) to be a common root of all joints. Partial skins
  // (e.g. a "Body" mesh weighted from Spine2 up) violate that: move/insert the top root at index 0.
  for (const sm of skinned) {
    const bs = sm.skeleton.bones; let top = real(bs[0]); while (top.parent?.isBone) top = top.parent;
    if (bs[0] === top) continue;
    const k = bs.indexOf(top), order = k >= 0 ? [top, ...bs.filter(b => b !== top)] : [top, ...bs];
    const remap = bs.map(b => order.indexOf(b)), si = sm.geometry.attributes.skinIndex;
    for (let i = 0; i < si.array.length; i++) si.array[i] = remap[si.array[i]];
    si.needsUpdate = true;
    const inv = order.map(b => { const i = bs.indexOf(b); return i >= 0 ? sm.skeleton.boneInverses[i] : b.matrixWorld.clone().invert(); });
    sm.bind(new THREE.Skeleton(order, inv), sm.bindMatrix);
  }
  const twins = []; model.traverse(o => { if (o.isBone && o.parent?.isBone && o.parent.name === o.name) twins.push(o); });
  for (const t of twins) { const p = t.parent; for (const c of [...t.children]) p.attach(c); p.remove(t); removed++; }
  const bones = new Set(); for (const sm of skinned) sm.skeleton.bones.forEach(b => bones.add(b));
  // include unskinned bones on the chain between skinned ones (e.g. a Spine1 no mesh weights to)
  for (const b of [...bones]) for (let p = b.parent; p?.isBone; p = p.parent) bones.add(p);
  const poseAll = () => { for (const sm of skinned) sm.skeleton.pose(); model.updateMatrixWorld(true); };
  return { bones: [...bones], skinned, poseAll, skins: skinned.length, removedTwinBones: removed };
}

// `override` maps a target bone's canonical name -> source bone name; an empty string pins the bone to rest pose.
// An override naming a bone this source does not have is ignored, so one map can serve tracks with different skeletons.
export function mapBones(targetBones, sourceBones, override = {}) {
  const src = new Map(sourceBones.map(b => [canonical(b.name), b.name]));
  const have = new Set(sourceBones.map(b => b.name));
  const names = {}, rows = [];
  for (const b of targetBones) {
    const c = canonical(b.name), forced = Object.hasOwn(override, c) && (override[c] === '' || have.has(override[c]));
    const s = forced ? override[c] : src.get(c);
    if (s) names[b.name] = s;
    rows.push({ target: b.name, canonical: c, source: s || null, manual: forced });
  }
  return { names, rows, unmapped: targetBones.filter(b => !names[b.name]).map(b => b.name) };
}

export const sourceBoneNames = bvh => bvh.skeleton.bones.map(b => b.name);

// Mapping plus the bookkeeping the GUI and the bake both need.
export function analyzeMapping(tgt, sourceBones, override = {}) {
  const m = mapBones(tgt, sourceBones, override);
  const findCore = c => tgt.find(b => canonical(b.name) === c) ?? tgt.find(b => m.names[b.name] && canonical(m.names[b.name]) === c);
  const claimed = new Set(m.rows.filter(r => r.source).map(r => canonical(r.source)));
  const missingCore = CORE_BONES.filter(c => !claimed.has(c) && !findCore(c));
  const hips = findCore('Hips');
  return { ...m, findCore, missingCore, hips: hips && m.names[hips.name] ? hips : null };
}

// Foot lock + IK correction. Contacts are detected on the SOURCE feet (low and slow), then on the target:
//  1. the hips are lifted or lowered so planted ankles sit at their rest height (no floating, no sinking),
//  2. each contact's ankle is pinned to one spot, with a short blend in and out,
//  3. a two-bone IK solve bends the leg to reach it, keeping the knee's bend side and the foot's world rotation.
// The pelvis is not moved to help a leg reach, so a leg that is out of reach stays straight and the foot slips.
function footLockPass({ n, fps, order, qv, pv, hipT, hipParentInv, hipParentScale, legs, srcFeet, srcLegLen, footRestY }) {
  const sides = Object.keys(legs);
  if (!sides.length) return { applied: false, reason: 'leg or foot bones are not mapped' };
  const wq = o => o.getWorldQuaternion(new THREE.Quaternion()), wp = o => o.getWorldPosition(new THREE.Vector3());

  const floor = (() => { const ys = sides.flatMap(s => srcFeet[s].map(p => p[1])).sort((a, b) => a - b); return ys[Math.floor(ys.length * 0.02)]; })();
  const minRun = Math.max(2, Math.round(0.12 * fps)), ramp = Math.max(2, Math.round(0.1 * fps));
  const contact = {}, segs = {};
  for (const s of sides) {
    const P = srcFeet[s], c = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], span = (Math.min(n - 1, i + 1) - Math.max(0, i - 1)) / fps;
      c[i] = P[i][1] - floor < 0.06 * srcLegLen && Math.hypot(b[0] - a[0], b[2] - a[2]) / span < 0.25 * srcLegLen ? 1 : 0;
    }
    const runs = v => { const r = []; for (let i = 0; i < n;) { let j = i; while (j < n && c[j] === v) j++; if (j > i) r.push([i, j - 1]); i = Math.max(j, i + 1); } return r; };
    for (const [a, b] of runs(0)) if (a > 0 && b < n - 1 && b - a < 2) c.fill(1, a, b + 1); // close one-frame dropouts
    for (const [a, b] of runs(1)) if (b - a + 1 < minRun) c.fill(0, a, b + 1);
    contact[s] = c; segs[s] = runs(1);
  }
  const contactFrames = Object.fromEntries(sides.map(s => [s, contact[s].reduce((x, y) => x + y, 0)]));
  if (!sides.some(s => segs[s].length)) return { applied: false, reason: 'no foot contacts detected', contactFrames };

  const setFrame = i => { for (const b of order) b.quaternion.fromArray(qv.get(b), i * 4); hipT.position.fromArray(pv, i * 3); hipT.updateMatrixWorld(true); };
  const ankleAt = i => { setFrame(i); return Object.fromEntries(sides.map(s => [s, wp(legs[s].foot)])); };

  // 1. vertical: shift the hips so planted ankles stand at their rest height
  const fk = Array.from({ length: n }, (_, i) => ankleAt(i));
  const dy = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const on = sides.filter(s => contact[s][i]);
    if (on.length) dy[i] = on.reduce((t, s) => t + footRestY[s] - fk[i][s].y, 0) / on.length;
  }
  const known = []; for (let i = 0; i < n; i++) if (!Number.isNaN(dy[i])) known.push(i);
  for (let i = 0, k = 0; i < n; i++) {
    if (!Number.isNaN(dy[i])) continue;
    while (k < known.length && known[k] < i) k++;
    const lo = known[k - 1], hi = known[k];
    dy[i] = lo === undefined ? dy[hi] : hi === undefined ? dy[lo] : dy[lo] + (dy[hi] - dy[lo]) * (i - lo) / (hi - lo);
  }
  const sigma = Math.max(1, 0.1 * fps), half = Math.ceil(sigma * 3), smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, wsum = 0;
    for (let k = -half; k <= half; k++) { const j = i + k; if (j < 0 || j >= n) continue; const w = Math.exp(-0.5 * (k / sigma) ** 2); sum += w * dy[j]; wsum += w; }
    smooth[i] = sum / wsum;
  }
  const off = new THREE.Vector3(); let hipShiftMax = 0;
  for (let i = 0; i < n; i++) {
    off.set(0, smooth[i], 0).applyQuaternion(hipParentInv).divide(hipParentScale);
    pv[i * 3] += off.x; pv[i * 3 + 1] += off.y; pv[i * 3 + 2] += off.z;
    hipShiftMax = Math.max(hipShiftMax, Math.abs(smooth[i]));
    for (const s of sides) fk[i][s].y += smooth[i];
  }

  // 2. anchors and blend weights
  const anchor = {}, weight = {}, which = {};
  for (const s of sides) {
    anchor[s] = segs[s].map(([a, b]) => { let x = 0, z = 0; for (let i = a; i <= b; i++) { x += fk[i][s].x; z += fk[i][s].z; } return new THREE.Vector3(x / (b - a + 1), footRestY[s], z / (b - a + 1)); });
    weight[s] = new Float32Array(n); which[s] = new Int32Array(n).fill(-1);
    segs[s].forEach(([a, b], k) => {
      for (let i = Math.max(0, a - ramp); i <= Math.min(n - 1, b + ramp); i++) {
        const w = 1 - (i < a ? a - i : i > b ? i - b : 0) / (ramp + 1);
        if (w > weight[s][i]) { weight[s][i] = w; which[s][i] = k; }
      }
    });
  }

  // 3. two-bone IK per frame
  const solve = ({ up, knee, foot }, T) => {
    const A = wp(up), B = wp(knee), C = wp(foot), qUp = wq(up), qKnee = wq(knee), qFoot = wq(foot);
    const l1 = A.distanceTo(B), l2 = B.distanceTo(C), reach = l1 + l2 - 1e-4;
    const dir = T.clone().sub(A), d = dir.length(); dir.divideScalar(d || 1);
    const dc = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-4), reach);
    const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc), h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
    const pole = B.clone().sub(A); pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-10) pole.set(0, 0, 1).addScaledVector(dir, -dir.z);
    pole.normalize();
    const K = A.clone().addScaledVector(dir, a).addScaledVector(pole, h), E = A.clone().addScaledVector(dir, dc);
    const q1 = new THREE.Quaternion().setFromUnitVectors(B.clone().sub(A).normalize(), K.clone().sub(A).normalize());
    const shin = C.clone().sub(B).applyQuaternion(q1).normalize();
    const q2 = new THREE.Quaternion().setFromUnitVectors(shin, E.clone().sub(K).normalize());
    const newUp = q1.clone().multiply(qUp), newKnee = q2.clone().multiply(q1).multiply(qKnee);
    return { up: wq(up.parent).invert().multiply(newUp), knee: newUp.clone().invert().multiply(newKnee), foot: newKnee.clone().invert().multiply(qFoot), clamped: d > reach };
  };
  let unreachable = 0, corrected = 0, slideBefore = 0, slideAfter = 0, slideN = 0, slideMaxBefore = 0, slideMaxAfter = 0;
  const T = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (!sides.some(s => weight[s][i] > 0)) continue;
    setFrame(i);
    for (const s of sides) {
      const w = weight[s][i]; if (w <= 0) continue;
      const A = anchor[s][which[s][i]], cur = fk[i][s];
      T.copy(cur).lerp(A, w);
      if (contact[s][i]) { const d = Math.hypot(cur.x - A.x, cur.z - A.z); slideBefore += d; slideMaxBefore = Math.max(slideMaxBefore, d); slideN++; }
      const r = solve(legs[s], T);
      if (r.clamped) unreachable++;
      r.up.toArray(qv.get(legs[s].up), i * 4); r.knee.toArray(qv.get(legs[s].knee), i * 4); r.foot.toArray(qv.get(legs[s].foot), i * 4);
      corrected++;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!sides.some(s => contact[s][i])) continue;
    const now = ankleAt(i);
    for (const s of sides) if (contact[s][i]) { const A = anchor[s][which[s][i]], d = Math.hypot(now[s].x - A.x, now[s].z - A.z); slideAfter += d; slideMaxAfter = Math.max(slideMaxAfter, d); }
  }
  const r2 = v => +v.toFixed(2);
  return { applied: true, contactFrames, correctedFrames: corrected, unreachableFrames: unreachable, hipShiftMax: r2(hipShiftMax), slideBefore: r2(slideBefore / Math.max(1, slideN)), slideAfter: r2(slideAfter / Math.max(1, slideN)), slideMaxBefore: r2(slideMaxBefore), slideMaxAfter: r2(slideMaxAfter) };
}

export function bakeMocap(model, source, { fps = 30, map = {}, align = true, trim = null, inPlace = false, loop = false, footLock = false, name = 'mocap' } = {}) {
  const motion = source.skeleton ? motionFromBVH(source) : source;
  const stages = [];
  const stage = (n, name, info, t) => stages.push({ n, name, ms: +(performance.now() - t).toFixed(1), info });
  let t = performance.now();

  const rig = normalizeRig(model);
  const tgt = rig.bones;
  stage(2, 'normalize rig', { bones: tgt.length, skins: rig.skins, removedTwinBones: rig.removedTwinBones }, t);

  t = performance.now();
  const { names, rows, unmapped, findCore, missingCore, hips: hipT } = analyzeMapping(tgt, motion.bones, map);
  if (!hipT) throw new Error('Could not map the hips bone; supply map.Hips (BVH bone name) in the mapping panel or --map file.');
  stage(3, 'map bones', { mapped: Object.keys(names).length, unmapped: unmapped.length, missingCore }, t);

  t = performance.now();
  const srcRoot = new THREE.Group(); srcRoot.add(motion.root);
  const srcMap = new Map(motion.bones.map(b => [b.name, b]));
  const depth = b => { let d = 0; for (let p = b.parent; p?.isBone; p = p.parent) d++; return d; };
  const order = [...tgt].sort((a, b) => depth(a) - depth(b));
  const wq = o => o.getWorldQuaternion(new THREE.Quaternion());
  const wp = o => o.getWorldPosition(new THREE.Vector3());
  // nearest mapped descendant: lets a chain keep its direction across unmapped bones (e.g. Mixamo Spine2 vs a BVH without it)
  const firstMapped = b => {
    const q = [...b.children];
    while (q.length) { const k = q.shift(); if (k.isBone && srcMap.get(names[k.name])) return k; q.push(...k.children); }
    return null;
  };

  rig.poseAll(); srcRoot.updateMatrixWorld(true);
  const lockLegs = {}, srcFeetBones = {}, srcFeet = {}, footRestY = {}; // foot lock needs a full, mapped leg chain on both skeletons
  if (footLock && !inPlace) for (const [s, pre] of [['L', 'Left'], ['R', 'Right']]) {
    const up = findCore(`${pre}UpLeg`), knee = findCore(`${pre}Leg`), foot = findCore(`${pre}Foot`), sf = foot && srcMap.get(names[foot.name]);
    if (up && knee && foot && sf && knee.parent === up && foot.parent === knee) { lockLegs[s] = { up, knee, foot }; srcFeetBones[s] = sf; srcFeet[s] = []; footRestY[s] = wp(foot).y; }
  }
  const restL = new Map(order.map(b => [b, b.quaternion.clone()]));
  const swingDeg = {};
  if (align) { // swing each mapped bone so its direction matches the BVH rest direction (fixes A-pose/axis mismatch)
    for (const b of order) {
      const s = srcMap.get(names[b.name]); if (!s) continue;
      const c = firstMapped(b); if (!c) continue;
      const dT = wp(c).sub(wp(b)).normalize(), dS = wp(srcMap.get(names[c.name])).sub(wp(s)).normalize();
      const swing = new THREE.Quaternion().setFromUnitVectors(dT, dS);
      swingDeg[b.name] = +THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(swing.w)))).toFixed(1);
      const w = swing.multiply(wq(b));
      b.quaternion.copy(wq(b.parent).invert().multiply(w)); b.updateMatrixWorld(true);
    }
  }
  const refW = new Map(order.map(b => [b, wq(b)]));
  const srcRestInv = new Map([...srcMap].map(([n, b]) => [n, wq(b).invert()]));
  stage(4, 'align reference pose', { enabled: align, swingDeg }, t);

  t = performance.now();
  const hipS = srcMap.get(names[hipT.name]);
  const footT = findCore('LeftFoot'), footS = footT && srcMap.get(names[footT.name]);
  const scale = footS ? wp(hipT).distanceTo(wp(footT)) / Math.max(1e-6, wp(hipS).distanceTo(wp(footS))) : 1;
  const hipParentInv = wq(hipT.parent).invert();
  const hipParentScale = hipT.parent.getWorldScale(new THREE.Vector3());

  const D = motion.clip.duration;
  const t0 = Math.min(Math.max(trim?.[0] ?? 0, 0), D), t1 = Math.min(Math.max(trim?.[1] ?? D, t0), D);
  const n = Math.floor((t1 - t0) * fps + 1e-9) + 1;
  if (n < 2) throw new Error(`Trim window ${t0.toFixed(2)}-${t1.toFixed(2)} s is too short at ${fps} fps.`);
  const times = new Float32Array(n);
  const qv = new Map(order.map(b => [b, new Float32Array(n * 4)])), pv = new Float32Array(n * 3);
  const mixer = new THREE.AnimationMixer(srcRoot); mixer.clipAction(motion.clip).play();
  const curW = new Map(), p0 = new THREE.Vector3(), hp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    times[i] = i / fps; mixer.setTime(t0 + times[i]); srcRoot.updateMatrixWorld(true);
    for (const s in srcFeet) srcFeet[s].push(wp(srcFeetBones[s]).toArray());
    for (const b of order) {
      const s = srcMap.get(names[b.name]);
      const pW = curW.get(b.parent) ?? wq(b.parent);
      const local = s ? pW.clone().invert().multiply(wq(s).multiply(srcRestInv.get(s.name)).multiply(refW.get(b))) : restL.get(b).clone();
      curW.set(b, pW.clone().multiply(local));
      local.toArray(qv.get(b), i * 4);
    }
    hipS.getWorldPosition(hp);
    if (i === 0) p0.copy(hp);
    if (inPlace) { hp.x = p0.x; hp.z = p0.z; } // BVH is Y-up: drop horizontal travel, keep hip height
    hp.multiplyScalar(scale).applyQuaternion(hipParentInv).divide(hipParentScale).toArray(pv, i * 3);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(srcRoot); // put the source back in its rest pose for the next bake
  stage(5, 'transfer rotations', { frames: n, window: [+t0.toFixed(3), +t1.toFixed(3)] }, t);
  t = performance.now();

  let lock = null;
  if (footLock) {
    const srcLegLen = Object.keys(srcFeetBones).length ? wp(hipS).distanceTo(wp(Object.values(srcFeetBones)[0])) : 0;
    lock = inPlace ? { applied: false, reason: 'in-place bakes keep the feet moving under a fixed body' }
      : footLockPass({ n, fps, order, qv, pv, hipT, hipParentInv, hipParentScale, legs: lockLegs, srcFeet, srcLegLen, footRestY });
  }

  if (loop) { // close the cycle: last pose == first pose
    for (const a of qv.values()) for (let k = 0; k < 4; k++) a[(n - 1) * 4 + k] = a[k];
    for (let k = 0; k < 3; k++) pv[(n - 1) * 3 + k] = pv[k];
  }
  for (const a of qv.values()) for (let i = 4; i < a.length; i += 4) // sign-continuity: no slerp flips
    if (a[i] * a[i - 4] + a[i + 1] * a[i - 3] + a[i + 2] * a[i - 2] + a[i + 3] * a[i - 1] < 0) for (let k = 0; k < 4; k++) a[i + k] = -a[i + k];
  const tracks = [...qv].map(([b, a]) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, a));
  tracks.push(new THREE.VectorKeyframeTrack(`${hipT.name}.position`, times, pv));
  rig.poseAll(); // leave the model in bind pose for export
  const clip = new THREE.AnimationClip(name, times[n - 1], tracks);
  stage(6, 'root motion', { rootScale: +scale.toFixed(3), inPlace, loop, hip: hipT.name, ...(lock && { footLock: lock }) }, t);

  return {
    clip,
    report: { bones: tgt.length, skins: rig.skins, removedTwinBones: rig.removedTwinBones, mapped: Object.keys(names).length, unmapped, missingCore, mapping: rows, rootScale: +scale.toFixed(3), fps, frames: n, duration: +clip.duration.toFixed(3), footLock: lock, stages },
  };
}
