import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, formatCommand, parseTrim, DEFAULTS, PRESETS, EXAMPLES } from '../docs/js/command.js';
import { parseChannels, parseFrameMessage, resample, buildBVH, LiveRecorder } from '../docs/js/live.js';
import { canonical, CORE_BONES, parseBVH } from '../docs/js/mocap-bake.mjs';
import { validateLabels, describeBones } from '../docs/js/ai.js';
import { explainReport } from '../docs/js/advice.js';
import { isMapJSON, classify } from '../docs/js/loaders.js';
import { buildSyntheticRig } from './synthetic-rig.mjs';

test('command: defaults and flags', () => {
  const p = parseCommand('bake --fps 60 --trim 2:10 --in-place --loop --map "my map.json" --no-optimize --max-tex 1024 --out a.glb');
  assert.deepEqual(p.opts, { ...DEFAULTS, fps: 60, trim: [2, 10], inPlace: true, loop: true, mapFile: 'my map.json', optimize: false, maxTex: 1024, out: 'a.glb' });
  assert.deepEqual(parseCommand('bake').opts, DEFAULTS);
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
