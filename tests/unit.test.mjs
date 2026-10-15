import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, formatCommand, parseTrim, parseUnit, DEFAULTS, PRESETS, EXAMPLES } from '../docs/js/command.js';
import { ARKIT_52, isFaceRecord, parseFaceRecord, parseMorphMap, matchBlendshapes, blendshapeStatus, windowTimes, findFaceMesh, faceTracks, scaleFaceSamples } from '../docs/js/face.mjs';
import { parseChannels, parseFrameMessage, resample, buildBVH, LiveRecorder } from '../docs/js/live.js';
import { canonical, CORE_BONES, parseBVH, mapBones, normalizeRig } from '../docs/js/mocap-bake.mjs';
import * as THREE from 'three';
import { validateLabels, describeBones } from '../docs/js/ai.js';
import { explainReport } from '../docs/js/advice.js';
import { isMapJSON, classify } from '../docs/js/loaders.js';
import { buildSyntheticRig } from './synthetic-rig.mjs';
import { runBake } from '../docs/js/pipeline.js';
import { loadMotion } from '../docs/js/loaders.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFaceRecord as parseRec } from '../docs/js/face.mjs';

test('command: defaults and flags', () => {
  const p = parseCommand('bake --fps 60 --trim 2:10 --in-place --loop --map "my map.json" --no-optimize --max-tex 1024 --out a.glb');
  assert.deepEqual(p.opts, { ...DEFAULTS, fps: 60, trim: [2, 10], inPlace: true, loop: true, mapFile: 'my map.json', optimize: false, maxTex: 1024, out: 'a.glb' });
  assert.deepEqual(parseCommand('bake').opts, DEFAULTS);
  assert.equal(parseCommand('bake --no-jpeg').opts.jpeg, false);
  assert.equal(DEFAULTS.jpeg, true);
  assert.equal(formatCommand({ jpeg: false }), 'bake --no-jpeg');
});

test('command: format round-trips through parse', () => {
  for (const line of [...PRESETS.map(p => p.cmd), ...EXAMPLES.filter(e => e.cmd.startsWith('bake')).map(e => e.cmd)]) {
    const opts = parseCommand(line).opts;
    assert.deepEqual(parseCommand(formatCommand(opts)).opts, opts, line);
  }
  assert.equal(formatCommand({ trim: [0, 10] }), 'bake --trim :10');
  assert.equal(formatCommand({ trim: [2, null] }), 'bake --trim 2:');
});

test('command: positional files and errors', () => {
  assert.deepEqual(parseCommand('bake a.fbx b.bvh').positional, ['a.fbx', 'b.bvh']);
  assert.deepEqual(parseCommand('bake a.glb walk.bvh "run fast.fbx" idle.glb --fps 24').positional, ['a.glb', 'walk.bvh', 'run fast.fbx', 'idle.glb']);
  assert.equal(formatCommand({}, { model: 'a.glb', motions: ['walk.bvh', 'run fast.fbx'] }), 'bake a.glb walk.bvh "run fast.fbx"');
  assert.throws(() => parseCommand('usdz'), /Unknown command/);
  assert.throws(() => parseCommand('bake --fps'), /needs a value/);
  assert.throws(() => parseCommand('bake --fps 0'), /between 1 and 240/);
  assert.throws(() => parseCommand('bake --trim 10:2'), /greater than start/);
  assert.throws(() => parseCommand('bake --trim abc'), /START:END/);
  assert.throws(() => parseCommand('bake --nope'), /Unknown flag/);
  assert.throws(() => parseCommand('rm -rf'), /Unknown command/);
  assert.equal(parseCommand('   '), null);
  assert.deepEqual(parseTrim(':5'), [0, 5]);
});

test('canonical names: Mixamo, Mesquite, UE, VRoid, Rigify', () => {
  const cases = { 'mixamorig:LeftUpLeg': 'LeftUpLeg', mixamorig9Hips: 'Hips', mmLeftArm: 'LeftArm', 'Micaiah:Spine1': 'Spine1', thigh_l: 'LeftUpLeg', J_Bip_R_LowerArm: 'RightForeArm', 'DEF-upper_arm.L': 'LeftArm', pelvis: 'Hips' };
  for (const [n, c] of Object.entries(cases)) assert.equal(canonical(n), c, n);
  assert.equal(canonical('mixamorig:LeftHandThumb1'), 'lefthandthumb1');
});

test('live: resample is exact on a linear ramp and unwraps angles', () => {
  const kinds = ['pos', 'rot'];
  const frames = [{ t: 0, values: [0, 170] }, { t: 0.1, values: [1, -170] }, { t: 0.31, values: [3.1, -150] }];
  const rows = resample(frames, kinds, 10);
  assert.equal(rows.length, 4);
  assert.ok(Math.abs(rows[1][0] - 1) < 1e-9);
  assert.ok(Math.abs(rows[0][1] - 170) < 1e-9);
  assert.ok(Math.abs(rows[1][1] - -170) < 1e-9);
  const mid = resample([{ t: 0, values: [0, 170] }, { t: 1, values: [0, -170] }], kinds, 2)[1][1];
  assert.ok(Math.abs(Math.abs(mid) - 180) < 1e-9, `unwrapped midpoint was ${mid}`);
});

test('live: recorder validates frames and builds a BVH', () => {
  const header = 'HIERARCHY\nROOT Hips\n{\n OFFSET 0 0 0\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n End Site\n {\n  OFFSET 0 1 0\n }\n}\nMOTION\nFrames: 3\nFrame Time: 0.1\n0 0 0 0 0 0\n';
  assert.deepEqual(parseChannels(header), ['pos', 'pos', 'pos', 'rot', 'rot', 'rot']);
  const rec = new LiveRecorder(); rec.setHeader(header);
  assert.ok(rec.push('0 0 0 0 0 0', 0));
  assert.ok(!rec.push('1 2 3', 0.1), 'wrong width rejected');
  assert.ok(!rec.push('a b c d e f', 0.1), 'non-numeric rejected');
  assert.ok(rec.push(JSON.stringify({ t: 0.5, values: [1, 1, 1, 0, 0, 90] }), 0.2));
  assert.ok(!rec.push('0 0 0 0 0 0', 0.3 - 1), 'time going backwards rejected');
  const bvh = rec.toBVH(10);
  assert.match(bvh, /Frames: 6\nFrame Time: 0\.1/);
  assert.ok(!bvh.includes('Frames: 3'));
  assert.equal(parseFrameMessage('', 0), null);
  assert.equal(buildBVH(header, [[0, 0, 0, 0, 0, 0]], 30).split('\n').at(-2), '0 0 0 0 0 0');
});

test('bvh: root OFFSET is added to the channels unless they are already absolute', () => {
  const bvh = (offset, frame) => `HIERARCHY\nROOT Hips\n{\n OFFSET ${offset}\n CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n JOINT Spine\n {\n  OFFSET 0 10 0\n  CHANNELS 3 Zrotation Xrotation Yrotation\n  End Site\n  {\n   OFFSET 0 5 0\n  }\n }\n}\nMOTION\nFrames: 2\nFrame Time: 0.1\n${frame} 0 0 0 0 0 0\n${frame} 0 0 0 0 0 0\n`;
  const y0 = b => parseBVH(b).clip.tracks.find(t => t.name === 'Hips.position').values[1];
  assert.equal(y0(bvh('0 99 0', '0 99 0')), 99, 'Mesquite style: channels equal the offset, so do not add it twice');
  assert.equal(parseBVH(bvh('0 99 0', '0 99 0')).absoluteRootPosition, true);
  assert.equal(y0(bvh('0 0 0', '0 99 0')), 99, 'zero offset');
  assert.equal(y0(bvh('0 10 0', '0 0 0')), 10, 'channels relative to the offset keep the standard additive meaning');
  assert.equal(parseBVH(bvh('0 10 0', '0 0 0')).absoluteRootPosition, undefined);
});

test('mapping: of two bones sharing a canonical name only the deepest is mapped (VRM Root + Hips)', () => {
  const bone = n => Object.assign(new THREE.Bone(), { name: n });
  const root = bone('Root'), hips = bone('J_Bip_C_Hips'), spine = bone('J_Bip_C_Spine');
  root.add(hips); hips.add(spine);
  const m = mapBones([root, hips, spine], [{ name: 'Hips' }, { name: 'Spine' }]);
  assert.equal(m.names.J_Bip_C_Hips, 'Hips');
  assert.equal(m.names.Root, undefined, 'the root must not also take the Hips motion');
  assert.equal(m.names.J_Bip_C_Spine, 'Spine');
  assert.equal(m.best.get('Hips'), hips);
});

test('upload roles: FBX / GLB are a character or an animation depending on the zone', () => {
  assert.equal(classify('x.glb'), 'model');
  assert.equal(classify('x.glb', 'model'), 'model');
  assert.equal(classify('x.glb', 'motion'), 'motion');
  assert.equal(classify('x.fbx', 'motion'), 'motion');
  assert.equal(classify('x.bvh'), 'motion');
  assert.equal(classify('x.bvh', 'model'), 'motion');
  assert.equal(classify('x.json', 'motion'), 'json');
  assert.equal(classify('x.obj'), null);
});

test('map json detection', () => {
  assert.ok(isMapJSON({ Hips: 'Hips', LeftArm: 'lShldr', _note: 'x' }));
  assert.ok(!isMapJSON({ scene: {} }));
  assert.ok(!isMapJSON({ metadata: { type: 'Object' }, object: {} }));
  assert.ok(!isMapJSON([]));
});

test('advice: groups unmapped bones and flags missing core', () => {
  const adv = explainReport({ bones: 60, mapped: 22, unmapped: ['LeftHandThumb1', 'LeftHandIndex2', 'Jaw', 'foo_ik', 'Weird'], missingCore: ['Spine2'] });
  const text = adv.map(a => a.text).join('\n');
  assert.match(text, /22 of 60/); assert.match(text, /Spine2/); assert.match(text, /2 finger/); assert.match(text, /Weird/);
});

// ---- host-side geometric validation of model-produced labels (the AI is never trusted) ----
const rig = await buildSyntheticRig();
const bones = rig.getObjectByName('Body').skeleton.bones;
const known = Object.fromEntries(bones.map(b => [b.name, canonical(b.name)]).filter(([, c]) => CORE_BONES.includes(c)));
const without = (...names) => Object.fromEntries(Object.entries(known).filter(([n]) => !names.includes(n)));

test('ai validator: accepts correct labels', () => {
  const k = without('upperarm_l', 'upperarm_r', 'spine_02');
  const { accepted, rejected } = validateLabels(bones, k, { upperarm_l: 'LeftArm', upperarm_r: 'RightArm', spine_02: 'Spine1' });
  assert.deepEqual(rejected, []);
  assert.deepEqual(accepted, { upperarm_l: 'LeftArm', upperarm_r: 'RightArm', spine_02: 'Spine1' });
});

test('ai validator: rejects wrong side, duplicates, chain order, non-canonical names', () => {
  const k = without('upperarm_l', 'upperarm_r', 'hand_l');
  const { accepted, rejected } = validateLabels(bones, k, {
    upperarm_l: 'RightArm', upperarm_r: 'LeftArm',   // swapped sides
    clavicle_l: 'Hips',                               // already claimed
    head: 'Banana',                                   // not in the enum
  });
  assert.deepEqual(accepted, {});
  const why = Object.fromEntries(rejected.map(r => [r.bone, r.reason]));
  assert.match(why.upperarm_l, /right side/); assert.match(why.upperarm_r, /left side/);
  assert.match(why.clavicle_l, /already used/); assert.match(why.head, /canonical/);
  // chain order: upperarm_l above an already-labelled LeftForeArm cannot be the hand
  const chain = validateLabels(bones, k, { upperarm_l: 'LeftHand' });
  assert.match(chain.rejected[0].reason, /chain order/);
});

test('ai validator: height and midline checks', () => {
  const k = without('calf_l', 'head');
  const { rejected } = validateLabels(bones, k, { head: 'LeftFoot', calf_l: 'Neck' });
  const why = Object.fromEntries(rejected.map(r => [r.bone, r.reason]));
  assert.ok(why.head && why.calf_l, JSON.stringify(rejected));
});

test('ai: bone descriptions carry side and height but no raw geometry', () => {
  const [d] = describeBones(bones, without('upperarm_l'), ['upperarm_l']);
  assert.equal(d.side, 'left'); assert.ok(d.height > 0.3); assert.match(d.parents, /clavicle|LeftShoulder/i);
  assert.deepEqual(Object.keys(d).sort(), ['bone', 'children', 'height', 'parents', 'side']);
});

test('webcli: URL is the primitive, owner/repo@ref:path is sugar', async () => {
  const { expandSource, rawFallback, parseRunParams, sniffExt, fetchInput } = await import('../docs/js/webcli.js');
  assert.equal(expandSource('https://example.com/a@b:c.glb'), 'https://example.com/a@b:c.glb');
  assert.equal(expandSource('/fixtures/x.fbx'), '/fixtures/x.fbx');
  assert.equal(expandSource('data:text/plain;base64,AAAA'), 'data:text/plain;base64,AAAA');
  assert.equal(expandSource('me/rigs@abc123:chars/hero.glb'), 'https://cdn.jsdelivr.net/gh/me/rigs@abc123/chars/hero.glb');
  assert.equal(rawFallback('https://raw.githubusercontent.com/me/rigs/main/a/b.glb'), 'https://cdn.jsdelivr.net/gh/me/rigs@main/a/b.glb');
  assert.equal(rawFallback('https://example.com/a.glb'), null);
  const p = parseRunParams('?character=a.glb&motion=b.bvh&motion=c.bvh&run=bake&args=--fps%2024');
  assert.deepEqual([p.character, p.motion, p.run, p.args, p.requested], ['a.glb', ['b.bvh', 'c.bvh'], 'bake', '--fps 24', true]);
  assert.equal(parseRunParams('').requested, false);
  assert.throws(() => parseRunParams('?run=push'), /Unknown run/);
  assert.throws(() => parseRunParams('?run=bake&character=a.glb'), /needs character/);
  const bytes = s => new TextEncoder().encode(s).buffer;
  assert.equal(sniffExt(bytes('glTF....')), '.glb');
  assert.equal(sniffExt(bytes('HIERARCHY\nROOT')), '.bvh');
  assert.equal(sniffExt(bytes('Kaydara FBX Binary  ')), '.fbx');
  const calls = [];
  const fake = async (u, init) => { calls.push({ u, init }); return u.includes('raw.') ? { ok: false, status: 429 } : { ok: true, arrayBuffer: async () => bytes('HIERARCHY') }; };
  const r = await fetchInput('https://raw.githubusercontent.com/me/rigs/main/walk', 'motion-1', fake);
  assert.equal(r.name, 'walk.bvh');
  assert.ok(calls.every(c => c.init.method === 'GET' && !c.init.body && c.init.credentials === 'omit'));
  assert.equal(calls.length, 2);
  assert.equal((await fetchInput('data:application/octet-stream;base64,AAAA', 'motion-2', fake)).name, 'motion-2.bvh');
});

test('normalizeRig: per-mesh armature copies fold into one skeleton, loose hair follows a bone', () => {
  const scene = new THREE.Group();
  const armature = (group, sfx, extra) => { // extra: names of bones only this copy has
    const root = new THREE.Bone(), hips = new THREE.Bone(), spine = new THREE.Bone();
    root.name = `root${sfx}`; hips.name = `pelvis${sfx}`; spine.name = `spine_01${sfx}`;
    hips.position.set(0, 1, 0); spine.position.set(0, 0.5, 0); root.add(hips); hips.add(spine);
    const bones = [root, hips, spine];
    for (const n of extra) { const hand = new THREE.Bone(); hand.name = n; hand.position.set(0.5, 0, 0); spine.add(hand); bones.push(hand); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0.1, 1.5, 0, 0.2, 1.5, 0, 0.1, 1.6, 0], 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0).map((_, i) => (i % 4 ? 0 : 2)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(12).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); mesh.name = `mesh${sfx}`;
    group.add(mesh, root); scene.add(group); scene.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));
    return { mesh, bones };
  };
  const a = armature(new THREE.Group(), '', ['hand_r']), b = armature(new THREE.Group(), '_1', ['hand_l_1', 'hand_x_1']); // b is larger, so it becomes the shared skeleton
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
  hair.position.set(0.1, 1.55, 0); b.mesh.parent.add(hair); scene.updateMatrixWorld(true);
  const restB = b.mesh.getVertexPosition(0, new THREE.Vector3()).clone();
  const rig = normalizeRig(scene);
  assert.equal(rig.mergedSkeletons, 1);
  assert.equal(rig.attachedMeshes, 1);
  assert.equal(hair.parent.name, 'spine_01');
  for (const m of [a.mesh, b.mesh]) assert.equal(m.skeleton.bones[0].name, 'root');
  assert.ok(a.mesh.skeleton.bones.some(x => x.name === 'hand_r' && x.parent.name === 'spine_01'), 'a bone only the copy has joins the shared skeleton');
  scene.updateMatrixWorld(true);
  assert.ok(b.mesh.getVertexPosition(0, new THREE.Vector3()).distanceTo(restB) < 1e-5, 'rest pose is kept');
  b.bones[2].rotation.z = 1; scene.updateMatrixWorld(true);
  const pa = a.mesh.getVertexPosition(0, new THREE.Vector3()), pb = b.mesh.getVertexPosition(0, new THREE.Vector3());
  assert.ok(pa.distanceTo(pb) < 1e-5 && pa.distanceTo(restB) > 0.05, 'both meshes now follow the same bones');
  assert.ok(hair.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(0.1, 1.55, 0)) > 0.05, 'hair moved with the spine');
});

test('normalizeRig: seam copies with different weights are averaged so the mesh cannot tear', () => {
  const root = new THREE.Bone(), a = new THREE.Bone(), b = new THREE.Bone();
  root.name = 'root'; a.name = 'pelvis'; b.name = 'spine_01'; a.position.y = 1; b.position.y = 0.5; root.add(a); a.add(b);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 1, 1, 0], 3)); // vertices 0 and 1 share a position
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()), scene = new THREE.Group();
  scene.add(mesh, root); scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([root, a, b]));
  const rig = normalizeRig(scene), si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  assert.equal(rig.weldedSeamVertices, 2);
  for (let k = 0; k < 4; k++) { assert.equal(si.getX(0) === si.getX(1), true); assert.ok(Math.abs(sw.getComponent(0, k) - sw.getComponent(1, k)) < 1e-6); }
  assert.ok(Math.abs(sw.getX(0) - 0.5) < 1e-6 && Math.abs(sw.getY(0) - 0.5) < 1e-6);
});

test('command: --hide parses, formats and round-trips', () => {
  assert.equal(parseCommand('bake --hide Outfits,Hair').opts.hide, 'Outfits,Hair');
  assert.equal(parseCommand('bake').opts.hide, null);
  assert.equal(formatCommand({ hide: 'Outfits' }), 'bake --hide Outfits');
  assert.deepEqual(parseCommand(formatCommand({ hide: 'a b' })).opts.hide, 'a b');
  assert.throws(() => parseCommand('bake --hide'), /needs a value/);
});

test('pipeline: --hide matches mesh or parent group names, case-insensitively', async () => {
  const { meshesMatching, setMeshesHidden } = await import('../docs/js/pipeline.js');
  const root = new THREE.Group(), grp = new THREE.Group(), a = new THREE.Mesh(), b = new THREE.Mesh(), c = new THREE.Mesh();
  grp.name = 'bo_Outfits'; a.name = 'Shirt'; b.name = 'my_outfit_pants'; c.name = 'Body';
  grp.add(a); root.add(grp, b, c);
  assert.deepEqual(meshesMatching(root, 'outfits').map(m => m.name), ['Shirt']);
  assert.deepEqual(meshesMatching(root, 'Outfits, pants').map(m => m.name), ['Shirt', 'my_outfit_pants']);
  assert.deepEqual(meshesMatching(root, null), []);
  assert.equal(setMeshesHidden(root, 'Outfits'), 1);
  assert.equal(a.visible, false); assert.equal(c.visible, true);
  setMeshesHidden(root, null);
  assert.equal(a.visible, true);
});

test('normalizeRig: copies that both carry loader suffixes merge and get the plain names back', () => {
  const scene = new THREE.Group(), skins = [];
  for (const [sfx, extra] of [['_1', 0], ['_3', 1]]) {
    const hips = new THREE.Bone(), spine = new THREE.Bone(), bones = [hips, spine];
    hips.name = `pelvis${sfx}`; spine.name = `spine_01${sfx}`; spine.position.y = 0.5; hips.add(spine);
    if (extra) { const h = new THREE.Bone(); h.name = `head${sfx}`; h.position.y = 0.5; spine.add(h); bones.push(h); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.2, 0, 0.1, 0.2, 0, 0, 0.3, 0], 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(12).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()), grp = new THREE.Group(); grp.add(mesh, hips); scene.add(grp);
    scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones)); skins.push(mesh);
  }
  const rig = normalizeRig(scene);
  assert.equal(rig.mergedSkeletons, 1);
  assert.deepEqual(rig.bones.map(b => b.name).sort(), ['head', 'pelvis', 'spine_01']);
  assert.equal(skins[0].skeleton.bones[0], skins[1].skeleton.bones[0]);
});

test('units: each file is its own unit; body and face are separate, and + is rejected', () => {
  assert.deepEqual(parseUnit('walk.bvh'), { token: 'walk.bvh', body: 'walk.bvh', face: null });
  assert.deepEqual(parseUnit('smile.json'), { token: 'smile.json', body: null, face: 'smile.json' });
  for (const bad of ['walk.bvh+smile.json', 'a.bvh+b.fbx', 'a+b', 'x.bvh+', '+x.json']) assert.throws(() => parseUnit(bad), /separate|\+/, bad);
  assert.throws(() => parseCommand('bake walk.bvh+smile.json'), /separate|\+/);
});

test('units: separate positional units survive format round trip', () => {
  const p = parseCommand('bake walk.bvh smile.json idle.bvh --face-head --morph-map map.json');
  assert.deepEqual(p.positional, ['walk.bvh', 'smile.json', 'idle.bvh']);
  assert.equal(p.opts.faceHead, true);
  assert.equal(p.opts.morphMapFile, 'map.json');
  const again = parseCommand(formatCommand(p.opts, { motions: p.positional }));
  assert.deepEqual(again.positional, p.positional);
  assert.deepEqual(again.opts, p.opts);
  assert.equal(parseCommand('bake').opts.faceHead, false);
});

const record = (over = {}) => ({
  type: 'face-record', schema: 'arkit-52', fps: 30, t0: 0,
  channels: ['jawOpen', 'eyeBlinkLeft', 'madeUpChannel'],
  frames: [[0.2, 1.7, 0.5], [0.4, -0.3, 0.5]],
  ...over,
});

test('face: record detection and parsing', () => {
  assert.equal(isFaceRecord(record()), true);
  assert.equal(isFaceRecord({ channels: [], frames: [] }), false);
  const r = parseFaceRecord(record());
  assert.deepEqual(r.channels, ['jawOpen', 'eyeBlinkLeft']);
  assert.deepEqual(r.ignored, ['madeUpChannel']);
  assert.deepEqual(r.frames[0], { jawOpen: 0.2, eyeBlinkLeft: 1 });
  assert.deepEqual(r.frames[1], { jawOpen: 0.4, eyeBlinkLeft: 0 });
  assert.throws(() => parseFaceRecord(record({ channels: ['madeUpChannel'], frames: [[0.1]] })));
  assert.throws(() => parseFaceRecord(record({ frames: [[0.1, 0.2]] })));
});

test('face: name matching and morph maps', () => {
  const direct = matchBlendshapes(['eyeBlink_Left', 'jawOpen', 'Blink_Right']);
  assert.equal(direct.get('eyeBlinkLeft'), 'eyeBlink_Left');
  assert.equal(direct.get('jawOpen'), 'jawOpen');
  assert.equal(direct.has('eyeBlinkRight'), false);
  const mapped = matchBlendshapes(['Blink_Right'], { eyeBlinkRight: 'Blink_Right' });
  assert.equal(mapped.get('eyeBlinkRight'), 'Blink_Right');
  assert.deepEqual(parseMorphMap({ eyeBlinkRight: 'Blink_Right' }), { eyeBlinkRight: 'Blink_Right' });
  assert.throws(() => parseMorphMap({ notARKit: 'x' }));
  assert.equal(ARKIT_52.length, 52);
});

test('face: blendshape status levels', () => {
  const none = blendshapeStatus(new Map(), { meshName: null });
  assert.equal(none.level, 'none');
  assert.equal(none.matched, 0);
  assert.equal(none.total, 52);
  const all = blendshapeStatus(new Map(ARKIT_52.map(n => [n, n])), { meshName: 'Head' });
  assert.equal(all.level, 'ok');
  assert.equal(all.missing.length, 0);
  const some = blendshapeStatus(new Map([['jawOpen', 'jawOpen']]), { meshName: 'Head' });
  assert.equal(some.level, 'partial');
  assert.equal(some.missing.length, 51);
});

test('face: window length mirrors body sampling', () => {
  assert.equal(windowTimes(10, [2, 4], 30).n, 61);
  assert.equal(windowTimes(10, null, 30).n, 301);
  assert.throws(() => windowTimes(10, [2, 2.001], 30));
});

// GLTFExporter reads its binary output through FileReader, which Node does not provide.
globalThis.self ??= globalThis;
if (!globalThis.FileReader) globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(buf => { this.result = buf; this.onloadend?.(); }); }
};

const glbJson = buf => {
  const dv = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf.buffer ?? buf, (buf.byteOffset ?? 0) + 20, dv.getUint32(12, true))));
};

const faceRecord = () => parseRec({
  type: 'face-record', schema: 'arkit-52', fps: 30, t0: 0,
  channels: ['jawOpen', 'eyeBlinkLeft'],
  frames: Array.from({ length: 31 }, (_, i) => [i / 30, 1 - i / 30]),
});

// Give the synthetic Body mesh two ARKit morph targets, the way a blendshape export would.
function addArkitMorphs(rig, names = ['jawOpen', 'eyeBlinkLeft']) {
  let body = null; rig.traverse(o => { if (o.isMesh && o.name === 'Body') body = o; });
  const pos = body.geometry.attributes.position;
  body.geometry.morphAttributes.position = names.map(() => pos.clone());
  body.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
  body.morphTargetInfluences = names.map(() => 0);
  return body;
}

const bakeOpts = { fps: 30, trim: null, inPlace: false, loop: false, align: true, footLock: false, optimize: false, jpeg: false, maxTex: 0, level: 'medium', hide: null, faceHead: false };

test('bake: face-only unit becomes a clip with morph weight channels', async () => {
  const rig = await buildSyntheticRig();
  addArkitMorphs(rig);
  const res = await runBake({ model: rig, units: [{ body: null, face: { name: 'smile.json', record: faceRecord() } }], opts: bakeOpts });
  assert.equal(res.clips.length, 1);
  assert.equal(res.clip.name, 'smile.json');
  assert.equal(res.report.units[0].face.status, 'baked');
  assert.equal(res.report.units[0].face.channels, 2);
  assert.equal(res.report.blendshapes.level, 'partial');
  const gj = glbJson(res.glb), anim = gj.animations[0];
  const weights = anim.channels.filter(c => c.target.path === 'weights');
  assert.equal(weights.length, 1, 'GLTFExporter packs all morph tracks of a node into one weights channel');
  const out = gj.accessors[anim.samplers[weights[0].sampler].output];
  assert.equal(out.count, 31 * 2, 'one weight per frame per morph target');
  assert.equal(res.report.frames, 31);
  assert.equal(res.report.duration, 1);
});

test('bake: face-only unit with no matching morphs is rejected', async () => {
  const rig = await buildSyntheticRig();
  await assert.rejects(runBake({ model: rig, units: [{ body: null, face: { name: 'smile.json', record: faceRecord() } }], opts: bakeOpts }), /ARKit|morph/i);
});

const BVH_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mocap-33s.bvh');
test('bake: body and face units bake as separate clips', { skip: !fs.existsSync(BVH_FIXTURE) && 'mocap-33s.bvh fixture not present' }, async () => {
  const rig = await buildSyntheticRig();
  addArkitMorphs(rig);
  const source = loadMotion(fs.readFileSync(BVH_FIXTURE, 'utf8')).source;
  const rec = parseRec({ type: 'face-record', schema: 'arkit-52', fps: 30, t0: 0, channels: ['jawOpen', 'eyeBlinkLeft'], frames: Array.from({ length: 61 }, (_, i) => [i / 60, 0.5]) });
  const res = await runBake({ model: rig, units: [
    { label: 'walk', body: { name: 'mocap-33s.bvh', source }, face: null },
    { label: 'smile', body: null, face: { name: 'smile.json', record: rec } },
  ], opts: bakeOpts });
  assert.equal(res.clips.length, 2);
  assert.deepEqual(res.clips.map(c => c.name), ['walk', 'smile']);
  const [body, face] = res.clips;
  assert.ok(body.tracks.every(t => !t.name.includes('morphTargetInfluences')), 'body clip has no morph tracks');
  assert.ok(face.tracks.every(t => t.name.includes('morphTargetInfluences')), 'face clip has only morph tracks');
  assert.equal(res.report.units[0].face, null);
  assert.equal(res.report.units[1].body, false);
  assert.equal(res.report.units[1].face.status, 'baked');
});

test('bake: face-only clip follows the recording, not a frozen first frame (epoch t0)', async () => {
  const rig = await buildSyntheticRig();
  addArkitMorphs(rig);
  // Capture timestamps are epoch milliseconds, as in mocap-webCLI output.
  const rec = parseRec({ type: 'face-record', schema: 'arkit-52', fps: 30, t0: 1791868839666, channels: ['jawOpen'], frames: Array.from({ length: 61 }, (_, i) => [i / 60]) });
  const res = await runBake({ model: rig, units: [{ label: 'smile', body: null, face: { name: 'smile.json', record: rec } }], opts: bakeOpts });
  const weightTracks = res.clip.tracks.filter(t => t.name.includes('morphTargetInfluences'));
  assert.ok(weightTracks.length > 0, 'face weight tracks present');
  const vals = weightTracks.flatMap(t => Array.from(t.values));
  assert.ok(Math.max(...vals) - Math.min(...vals) > 0.5, 'jawOpen ramps from 0 to 1 over the first 2 s');
});

test('face: weights bind to every mesh that shares the morph set (split VRM face)', () => {
  const targets = ['jawOpen', 'eyeBlinkLeft', 'mouthSmileLeft'];
  const root = new THREE.Group();
  const mesh = name => {
    const m = new THREE.Mesh(new THREE.BufferGeometry());
    m.name = name;
    m.morphTargetDictionary = Object.fromEntries(targets.map((t, i) => [t, i]));
    m.morphTargetInfluences = [0, 0, 0];
    return m;
  };
  for (const n of ['Face_skin', 'Eye_iris', 'Mouth']) root.add(mesh(n));
  const best = findFaceMesh(root);
  assert.equal(best.meshes.length, 3, 'all three face parts are driven');
  const times = new Float32Array([0, 1]);
  const samples = new Map([['jawOpen', new Float32Array([0, 1])], ['eyeBlinkLeft', new Float32Array([0, 1])], ['mouthSmileLeft', new Float32Array([0, 1])]]);
  const tracks = faceTracks(best.meshes, best.matched, times, samples);
  assert.equal(tracks.length, 9);
  for (const n of ['Face_skin', 'Eye_iris', 'Mouth']) assert.ok(tracks.some(t => t.name.startsWith(`${n}.morphTargetInfluences[`)), `track for ${n}`);
});

test('face strength: default, flag, round trip and range', () => {
  assert.equal(DEFAULTS.faceStrength, 1.5);
  assert.equal(parseCommand('bake').opts.faceStrength, 1.5);
  assert.equal(parseCommand('bake --face-strength 2.5').opts.faceStrength, 2.5);
  assert.equal(parseCommand('bake --face-strength 0').opts.faceStrength, 0);
  assert.equal(formatCommand({ faceStrength: 1.5 }), 'bake');
  assert.equal(formatCommand({ faceStrength: 2 }), 'bake --face-strength 2');
  assert.equal(parseCommand(formatCommand({ faceStrength: 0.5 })).opts.faceStrength, 0.5);
  assert.throws(() => parseCommand('bake --face-strength 4'), /between 0 and 3/);
  assert.throws(() => parseCommand('bake --face-strength -1'), /between 0 and 3/);
  assert.throws(() => parseCommand('bake --face-strength abc'), /between 0 and 3/);
});

test('face strength: scales weights and clamps to 0-1', () => {
  const samples = new Map([['jawOpen', new Float32Array([0, 0.2, 0.8])]]);
  scaleFaceSamples(samples, 2);
  const got = Array.from(samples.get('jawOpen'));
  [0, 0.4, 1].forEach((v, i) => assert.ok(Math.abs(got[i] - v) < 1e-6, `sample ${i}`));
  const zero = new Map([['a', new Float32Array([0.5])]]);
  scaleFaceSamples(zero, 0);
  assert.equal(zero.get('a')[0], 0);
});

test('bake: face strength scales the baked morph weights', async () => {
  const rig = await buildSyntheticRig();
  addArkitMorphs(rig);
  const bake = strength => runBake({ model: rig, units: [{ body: null, face: { name: 'smile.json', record: faceRecord() } }], opts: { ...bakeOpts, faceStrength: strength } });
  const raw = (await bake(1)).clip.tracks, boosted = (await bake(1.5)).clip.tracks, off = (await bake(0)).clip.tracks;
  const weightsOf = tracks => tracks.filter(t => t.name.includes('morphTargetInfluences'));
  const rawW = weightsOf(raw), boostW = weightsOf(boosted), offW = weightsOf(off);
  assert.ok(rawW.length > 0);
  rawW.forEach((t, k) => {
    for (let i = 0; i < t.values.length; i++) {
      assert.ok(Math.abs(boostW[k].values[i] - Math.min(1, t.values[i] * 1.5)) < 1e-6, 'weight = min(1, raw * strength)');
      assert.equal(offW[k].values[i], 0);
    }
  });
});
