// matrix.mjs -- Playwright drives the REAL page (dev/CI only, never part of the product).
// characters x BVH x option variants -> run the page -> GLB -> glTF-validator + limb-error threshold + golden frames,
// plus zero-egress, offline (service worker) and live-stream checks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createServer } from '../server.js';
import { ensureFixtures } from './fetch-fixtures.mjs';
import { SAMPLE_CHARACTERS } from '../docs/js/samples.js';
import { verifyGLB, compareGolden } from './verify.mjs';
import { buildSyntheticRig } from './synthetic-rig.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures'), localFixtures = path.join(root, 'tests', 'fixtures-local');
const outDir = path.join(root, 'tests', 'out'), goldenDir = path.join(root, 'tests', 'golden');
const UPDATE = process.argv.includes('--update-golden');
const MAX_MEAN_DEG = 3, MAX_P95_DEG = 8;
fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(goldenDir, { recursive: true });
await ensureFixtures(); // X Bot / Y Bot are fetched from the CDN, not stored in the repo

const server = createServer(path.join(root, 'docs'), { '/fixtures/': fixtures, '/local/': localFixtures, '/out/': outDir });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const BVH = 'mocap-33s.bvh';
const bvhText = fs.readFileSync(path.join(fixtures, BVH), 'utf8');
const characters = [
  { id: 'xbot', url: '/fixtures/xbot.fbx' },
  { id: 'ybot', url: '/fixtures/ybot.fbx' },
  { id: 'synthetic-blender', synthetic: true },
  ...(fs.existsSync(localFixtures) ? fs.readdirSync(localFixtures).filter(f => /\.(glb|fbx|vrm)$/i.test(f)).map(f => ({ id: `local-${f}`, url: `/local/${f}` })) : []),
];
const variants = [
  { id: 'default', line: 'bake', offset: 0, optimize: true, golden: true },
  { id: 'trim-inplace-24fps', line: 'bake --trim 2:10 --fps 24 --in-place', offset: 2, optimize: true, golden: true, expectDuration: 8 },
  { id: 'raw', line: 'bake --no-optimize', offset: 0, optimize: false },
  { id: 'foot-lock', line: 'bake --no-optimize --foot-lock', offset: 0, optimize: false, lock: true },
];

const failures = [], rows = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); return ok; };

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const requests = [];
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
ctx.on('request', r => requests.push({ url: r.url(), method: r.method(), body: r.postData() }));
await page.goto(`${origin}/index.html?nosw`);
await page.waitForFunction('window.bodyrigWebCLI?.ready === true');

for (const ch of characters) for (const v of variants) {
  const job = `${ch.id}/${v.id}`;
  try {
    const r = await page.evaluate(async ({ ch, v, bvh, src }) => {
      if (ch.synthetic) {
        const build = (0, eval)(`(${src})`);
        return window.bodyrigWebCLI.bakeObject(await build(), await (await fetch(bvh)).text(), v.line);
      }
      return window.bodyrigWebCLI.bakeUrls(ch.url, bvh, v.line);
    }, { ch, v, bvh: `/fixtures/${BVH}`, src: buildSyntheticRig.toString() });
    const glb = Buffer.from(r.b64, 'base64');
    fs.writeFileSync(path.join(outDir, `${ch.id}.${v.id}.glb`), glb);
    const ver = await verifyGLB(glb, bvhText, { offset: v.offset });
    const worst = Math.max(0, ...Object.values(ver.limb).map(x => x.p95));
    rows.push({ job, kb: Math.round(glb.length / 1024), frames: r.report.frames, mapped: `${r.report.mapped}/${r.report.bones}`, validatorErrors: ver.validator.errors, warnings: ver.validator.warnings, meanDeg: ver.meanLimbErrorDeg, worstP95: worst, ms: r.report.stages.reduce((s, x) => s + x.ms, 0) });

    check(ver.validator.errors === 0, `${job}: glTF-validator errors: ${ver.validator.top.join(' | ')}`);
    check(Object.keys(ver.limb).length >= 6, `${job}: only ${Object.keys(ver.limb).length} limb segments comparable (mapping failed?)`);
    check(ver.meanLimbErrorDeg <= MAX_MEAN_DEG, `${job}: mean limb error ${ver.meanLimbErrorDeg} deg > ${MAX_MEAN_DEG}`);
    check(worst <= MAX_P95_DEG, `${job}: worst p95 limb error ${worst} deg > ${MAX_P95_DEG}`);
    check(ver.meshopt === v.optimize, `${job}: expected meshopt=${v.optimize}, got ${ver.meshopt}`);
    if (v.optimize) check(r.glbBytes < (r.rawBytes ?? Infinity), `${job}: optimized GLB (${r.glbBytes}) not smaller than raw (${r.rawBytes})`);
    if (v.expectDuration) check(Math.abs(ver.animation.duration - v.expectDuration) < 0.1, `${job}: duration ${ver.animation.duration} != ${v.expectDuration}`);
    if (v.lock) {
      const fl = r.report.footLock;
      check(fl?.applied, `${job}: foot lock not applied (${fl?.reason})`);
      if (fl?.applied) {
        check(fl.slideAfter < fl.slideBefore * 0.2, `${job}: planted feet still slide (${fl.slideBefore} -> ${fl.slideAfter})`);
        check(fl.unreachableFrames < fl.correctedFrames * 0.2, `${job}: too many unreachable IK frames (${fl.unreachableFrames}/${fl.correctedFrames})`);
        check(fl.hipShiftMax < 15, `${job}: hips moved ${fl.hipShiftMax} units to meet the floor`);
      }
    }

    if (v.golden && !ch.id.startsWith('local-')) {
      const gp = path.join(goldenDir, `${ch.id}.${v.id}.json`);
      if (UPDATE) fs.writeFileSync(gp, JSON.stringify(ver.golden));
      else if (!check(fs.existsSync(gp), `${job}: no golden frames; run npm run test:update-golden`)) continue;
      else for (const d of compareGolden(ver.golden, JSON.parse(fs.readFileSync(gp, 'utf8')))) check(false, `${job}: golden ${d}`);
    }
  } catch (e) { failures.push(`${job}: ${e.message}`); }
}
console.table(rows);

// ---- GUI smoke: drop the real files through the file input, auto-bake, mapping table, scrubber ----
try {
  const ui = await ctx.newPage();
  const uiErrors = []; ui.on('pageerror', e => uiErrors.push(e.message));
  await ui.setViewportSize({ width: 1400, height: 1000 });
  await ui.goto(`${origin}/index.html?nosw`);
  const sawBar = ui.waitForSelector('#busyBar:not([hidden])', { timeout: 20000 }).then(() => true, () => false);
  await ui.setInputFiles('#modelInput', [path.join(fixtures, 'ybot.fbx')]);
  check(await sawBar, 'ui: no progress bar while the character loaded');
  await ui.waitForFunction(() => window.bodyrigWebCLI.state.model);
  check(!(await ui.locator('#resultCard').isVisible()), 'ui: baked before any animation track was added');
  await ui.setInputFiles('#motionInput', [path.join(fixtures, BVH)]);
  await ui.waitForSelector('#resultCard:not([hidden])', { timeout: 60000 });
  check((await ui.locator('#mapBody tr').count()) > 10, 'ui: mapping table did not render');
  check((await ui.locator('#btnDownloadRaw, #btnDownloadUsdz').count()) === 0, 'ui: universal GLB / USDZ buttons should be gone');
  check(await ui.locator('#trackSelect').isHidden(), 'ui: track selector shown for a single track');
  check((await ui.locator('.stage:not(.skipped)').count()) === 7, 'ui: not all seven stages reported');
  // playback: the pose must change with the scrubber and advance on its own
  const pose = () => ui.evaluate(() => { let q; window.bodyrigWebCLI.state.model.traverse(o => { if (o.isBone && /LeftUpLeg$/.test(o.name)) q = o.quaternion.toArray().map(x => +x.toFixed(4)).join(); }); return q; });
  await ui.evaluate(() => { const s = document.getElementById('scrub'); s.value = 0; s.dispatchEvent(new Event('input')); });
  const p0 = await pose();
  await ui.evaluate(() => { const s = document.getElementById('scrub'); s.value = 500; s.dispatchEvent(new Event('input')); });
  check(p0 !== await pose(), 'ui: scrubbing did not change the pose (animation stuck on frame 0)');
  const t0 = await ui.evaluate(() => document.getElementById('time').textContent);
  await ui.waitForTimeout(700);
  check(t0 !== await ui.evaluate(() => document.getElementById('time').textContent), 'ui: playback time did not advance');
  await ui.fill('#cmd', 'bake --trim 1:3 --fps 15 --loop'); await ui.click('#btnRun');
  await ui.waitForFunction(() => /15 fps/.test(document.getElementById('resultInfo').textContent), null, { timeout: 60000 });
  check((await ui.inputValue('#fps')) === '15', 'ui: command did not sync back to the fps control');
  await ui.fill('#cmd', 'bake --bogus'); await ui.click('#btnRun');
  check(/Unknown flag/.test(await ui.locator('#log').innerText()), 'ui: bad flag was not reported');
  await ui.check('#footLock');
  check((await ui.inputValue('#cmd')).includes('--foot-lock'), 'ui: the foot lock checkbox did not reach the command');
  await ui.uncheck('#footLock');
  check(!(await ui.inputValue('#cmd')).includes('--foot-lock'), 'ui: unchecking foot lock left the flag in the command');
  // mapping panel: pin Spine2 to the BVH Spine1 manually, save the map, and reuse it from the raw command
  await ui.selectOption('#mapBody tr:has-text("mixamorigSpine2") select', 'Spine1');
  check(await ui.locator('#mapBody tr.manual').count() === 1, 'ui: manual mapping row not flagged');
  await ui.click('#btnSaveMap');
  check((await ui.inputValue('#cmd')).includes('--map ybot.map.json'), 'ui: saving the map did not update the command');
  await ui.click('#btnRun');
  await ui.waitForFunction(() => (document.getElementById('log').textContent.match(/baked ybot_mocap-33s\.glb/g) || []).length >= 3, null, { timeout: 60000 }); // auto-bake, the 15 fps run, then this one
  const savedMap = await ui.evaluate(() => window.bodyrigWebCLI.state.files.get('ybot.map.json').map);
  check(savedMap.Spine2 === 'Spine1' && savedMap.Hips === 'Hips', 'ui: saved map content wrong');
  await ui.fill('#cmd', 'map'); await ui.click('#btnRun');
  check(/\[manual\]/.test(await ui.locator('#log').innerText()), 'ui: map command did not list the manual override');
  await ui.screenshot({ path: path.join(outDir, 'ui.png') });
  const [dl] = await Promise.all([ui.waitForEvent('download', { timeout: 15000 }).catch(() => null), ui.click('#btnDownload')]);
  if (dl) check(fs.statSync(await dl.path()).size > 1000, 'ui: downloaded GLB is empty');
  // a second animation track (a GLB baked earlier in this run) is embedded next to the BVH track
  await ui.setInputFiles('#motionInput', [path.join(outDir, 'xbot.trim-inplace-24fps.glb')]);
  await ui.waitForSelector('#trackSelect:not([hidden])', { timeout: 60000 });
  check((await ui.locator('#trackSelect option').count()) === 2, 'ui: track selector should list both tracks');
  check((await ui.locator('.chip:has(.kind:text("track"))').count()) === 2, 'ui: expected two track chips');
  check(await ui.locator('#mapTrackField').isVisible(), 'ui: mapping track selector missing with two tracks');
  check(/2 tracks/.test(await ui.locator('#resultInfo').innerText()), 'ui: result does not report two tracks');
  await ui.selectOption('#trackSelect', '1');
  check(await ui.evaluate(() => document.getElementById('time').textContent.includes('/ 8.00')), 'ui: switching track did not load the 8 s clip');
  await ui.locator('.chip:has-text("xbot.trim-inplace-24fps") .rm').click();
  await ui.waitForSelector('#busyBar:not([hidden])', { timeout: 5000 }).catch(() => failures.push('ui: no progress bar while removing a track'));
  await ui.waitForFunction(() => window.bodyrigWebCLI.state.motions.length === 1 && document.getElementById('busyBar').hidden, null, { timeout: 60000 });
  check((await ui.locator('.chip:has(.kind:text("track"))').count()) === 1, 'ui: removing a track chip did not remove the track');
  check(await ui.locator('#trackSelect').isHidden() && !/tracks/.test(await ui.locator('#resultInfo').innerText()), 'ui: removing a track did not re-bake a single-track result');
  // removing the character clears the preview and result
  await ui.locator('.chip:has(.kind:text("character")) .rm').click();
  await ui.waitForFunction(() => !window.bodyrigWebCLI.state.model && document.getElementById('busyBar').hidden, null, { timeout: 30000 });
  check(await ui.locator('#resultCard').isHidden() && await ui.locator('#viewerEmpty').isVisible(), 'ui: removing the character left the result or preview behind');
  check((await ui.locator('.chip:has(.kind:text("character"))').count()) === 0 && await ui.locator('#btnBake').isDisabled(), 'ui: character chip or Bake button not reset');
  check(!uiErrors.length, `ui: page errors: ${uiErrors.slice(0, 2).join(' | ')}`);
  await ui.close();
} catch (e) { failures.push(`ui: ${e.message}`); }

// ---- several animation tracks (BVH + a GLB animation) embedded as separate animations in one GLB ----
try {
  const r = await page.evaluate(() => window.bodyrigWebCLI.bakeUrls('/fixtures/ybot.fbx', ['/fixtures/mocap-33s.bvh', '/out/xbot.trim-inplace-24fps.glb'], 'bake --no-optimize --trim 0:4 --fps 15'));
  const glb = Buffer.from(r.b64, 'base64'); fs.writeFileSync(path.join(outDir, 'ybot.multitrack.glb'), glb);
  check(JSON.stringify(r.tracks) === JSON.stringify(['mocap-33s', 'xbot.trim-inplace-24fps']), `tracks: unexpected names ${r.tracks}`);
  const v0 = await verifyGLB(glb, bvhText, { clipIndex: 0 });
  const v1 = await verifyGLB(glb, bvhText, { clipIndex: 1, offset: 2 }); // the GLB track is BVH seconds 2..10, retargeted twice
  check(v0.validator.errors === 0, `tracks: validator errors: ${v0.validator.top.join(' | ')}`);
  check(v0.animations.length === 2 && v0.animations[0].name === 'mocap-33s' && v0.animations[1].name === 'xbot.trim-inplace-24fps', `tracks: GLB animations ${JSON.stringify(v0.animations)}`);
  check(v0.animations.every(a => a.duration > 3.9 && a.tracks > 40), 'tracks: an embedded animation is short or nearly empty');
  check(v0.meanLimbErrorDeg <= MAX_MEAN_DEG, `tracks: BVH track limb error ${v0.meanLimbErrorDeg}`);
  check(Object.keys(v1.limb).length >= 6 && v1.meanLimbErrorDeg <= MAX_MEAN_DEG, `tracks: GLB-source track limb error ${v1.meanLimbErrorDeg} (${Object.keys(v1.limb).length} segments)`);
  // asking for one file by name embeds only that file's track(s)
  const one = await page.evaluate(() => window.bodyrigWebCLI.execute('bake ybot.fbx xbot.trim-inplace-24fps.glb --no-optimize').then(x => x.clips.map(c => c.name)));
  check(JSON.stringify(one) === JSON.stringify(['xbot.trim-inplace-24fps']), `tracks: named motion selected ${one}`);
  console.log(`tracks: ${r.tracks.join(' + ')} -> ${v0.animations.length} animations, limb error ${v0.meanLimbErrorDeg} / ${v1.meanLimbErrorDeg} deg`);
} catch (e) { failures.push(`tracks: ${e.message}`); }

// ---- facing: a model that looks along -Z (VRM 0.x) must walk forwards, not backwards; a +Z model is the control ----
try {
  // Y-up rigs with identity parents (three's Skeleton.pose() mishandles a transformed Armature node), facing +Z or -Z
  const variant = remap => { const out = buildSyntheticRig.toString().replace('new THREE.Vector3(...p)', remap).replace('armature.rotation.x = -Math.PI / 2;', '').replace('mesh.rotation.x = -Math.PI / 2;', ''); if (out === buildSyntheticRig.toString()) throw new Error('synthetic rig source changed'); return out; };
  const rigs = { plusZ: variant('new THREE.Vector3(p[0], p[2], -p[1])'), minusZ: variant('new THREE.Vector3(-p[0], p[2], p[1])') };
  for (const [id, src] of Object.entries(rigs)) {
    const r = await page.evaluate(async ({ src, bvh }) => {
      const THREE = await import('/vendor/three/three.module.js');
      const rig = await (0, eval)(`(${src})`)();
      const out = await window.bodyrigWebCLI.bakeObject(rig, await (await fetch(bvh)).text(), 'bake --no-optimize --trim 0:8 --fps 15');
      const st = window.bodyrigWebCLI.state, clip = st.last.clips[0], source = st.motions[0].source;
      let hipT; rig.traverse(o => { if (o.name === 'pelvis') hipT = o; });
      const mt = new THREE.AnimationMixer(rig); mt.clipAction(clip).play();
      const ms = new THREE.AnimationMixer(source.root); ms.clipAction(source.clip).play();
      const at = t => { mt.setTime(t); ms.setTime(t); rig.updateMatrixWorld(true); source.root.updateMatrixWorld(true); return [hipT.getWorldPosition(new THREE.Vector3()), source.bones[0].getWorldPosition(new THREE.Vector3())]; };
      const [t0, s0] = at(0), [t1, s1] = at(7.5);
      const dT = t1.clone().sub(t0).setY(0), dS = s1.clone().sub(s0).setY(0), deg = THREE.MathUtils.radToDeg;
      const info = out.report.stages.find(s => s.n === 4).info;
      return { yaw: info.facingYawDeg, travel: dS.length(), vsSame: deg(dT.angleTo(dS)), vsFlipped: deg(dT.angleTo(dS.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI))), swingMax: Math.max(...Object.values(info.swingDeg)) };
    }, { src, bvh: `/fixtures/${BVH}` });
    const want = id === 'minusZ' ? 180 : 0;
    check(Math.abs(Math.abs(r.yaw) - want) < 5, `facing ${id}: expected a ${want} deg facing correction, got ${r.yaw}`);
    check(r.travel > 20 && (id === 'minusZ' ? r.vsFlipped : r.vsSame) < 15, `facing ${id}: root travel off by ${(id === 'minusZ' ? r.vsFlipped : r.vsSame).toFixed(0)} deg from where the model's own forward points (${r.vsSame.toFixed(0)} from the raw source path)`);
    check(r.swingMax < 60, `facing ${id}: alignment swings up to ${r.swingMax} deg, so a flipped side was not corrected`);
  }
} catch (e) { failures.push(`facing: ${e.message}`); }

// ---- export fidelity: FBX-style "transparent at opacity 1" materials must not export as BLEND ----
try {
  const r = await page.evaluate(async () => {
    const THREE = await import('/vendor/three/three.module.js');
    const { settleAlphaModes, jpegOpaqueTextures } = await import('/js/pipeline.js');
    const cv = fn => { const c = document.createElement('canvas'); c.width = c.height = 64; fn(c.getContext('2d')); return new THREE.CanvasTexture(c); };
    const white = () => cv(g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); });
    const half = () => cv(g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#000'; g.fillRect(0, 0, 32, 64); });
    const mk = o => new THREE.MeshStandardMaterial({ transparent: true, ...o });
    const mats = { opaque: mk({ map: white(), alphaMap: white() }), cutout: mk({ map: white(), alphaMap: half() }), glass: mk({ opacity: 0.5 }), plain: mk({}) };
    const g = new THREE.Group(); for (const m of Object.values(mats)) g.add(new THREE.Mesh(new THREE.BufferGeometry(), m));
    const snap = () => Object.fromEntries(Object.entries(mats).map(([k, m]) => [k, { t: m.transparent, a: m.alphaTest, am: !!m.alphaMap }]));
    const s = settleAlphaModes(g), during = snap(); s.restore();
    const solid = white(), cut = half(); const jm = new THREE.Group();
    jm.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: solid })), new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: cv(g => { g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(0, 0, 64, 64); }) })));
    const j = jpegOpaqueTextures(jm); const jpegMimes = jm.children.map(c => c.material.map.userData.mimeType ?? null); j.restore();
    return { during, after: snap(), jpegMimes, jpegAfter: jm.children.map(c => c.material.map.userData.mimeType ?? null), jpegCount: j.count };
  });
  check(!r.during.opaque.t && r.during.opaque.a === 0, `alpha: an opaque alpha map should export OPAQUE, got ${JSON.stringify(r.during.opaque)}`);
  check(!r.during.cutout.t && r.during.cutout.a === 0.5 && !r.during.cutout.am, `alpha: a cutout alpha map should export MASK with the map folded in, got ${JSON.stringify(r.during.cutout)}`);
  check(r.during.glass.t, 'alpha: real translucency (opacity 0.5) must stay BLEND');
  check(!r.during.plain.t, 'alpha: a textureless opacity-1 material should export OPAQUE');
  check(r.after.opaque.t && r.after.cutout.t && r.after.cutout.am && r.after.cutout.a === 0, 'alpha: live materials were not restored after export');
  check(r.jpegMimes[0] === 'image/jpeg' && r.jpegMimes[1] === null && r.jpegCount === 1, `jpeg: opaque textures should go out as JPEG and translucent ones stay PNG, got ${JSON.stringify(r.jpegMimes)}`);
  check(r.jpegAfter.every(m => m === null), 'jpeg: texture mime types were not restored after export');
} catch (e) { failures.push(`alpha: ${e.message}`); }

// ---- live stream: mock device -> record -> resample -> bake -> verify ----
try {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const [head, motion] = bvhText.split('MOTION');
  const frames = motion.split('\n').slice(3).filter(l => l.trim());
  wss.on('connection', ws => {
    ws.send(head + 'MOTION\nFrames: 0\nFrame Time: 0.033333\n');
    let i = 0;
    const tick = () => { if (i >= 90 || ws.readyState !== 1) return; ws.send(frames[i++]); setTimeout(tick, 20 + Math.random() * 25); };
    tick();
  });
  await new Promise(r => wss.on('listening', r));
  const live = await ctx.newPage();
  await live.goto(`${origin}/index.html?nosw`);
  await live.waitForFunction('window.bodyrigWebCLI?.ready === true');
  await live.setInputFiles('#modelInput', [path.join(fixtures, 'xbot.fbx')]);
  await live.waitForFunction(() => window.bodyrigWebCLI.state.model);
  await live.locator('details:has(#liveUrl) > summary').click();
  await live.fill('#liveUrl', `ws://127.0.0.1:${wss.address().port}`);
  await live.click('#btnLiveConnect');
  await live.waitForFunction(() => /Recording: (\d+) frames/.test(document.getElementById('liveStatus').textContent) && +document.getElementById('liveStatus').textContent.match(/(\d+) frames/)[1] >= 80, null, { timeout: 20000 });
  await live.click('#btnLiveStop'); await live.click('#btnLiveUse');
  const r = await live.evaluate(async () => { const x = await window.bodyrigWebCLI.execute('bake --no-optimize'); const s = window.bodyrigWebCLI.state; return { b64: window.bodyrigWebCLI.b64(x.glb), bvh: s.motions[0].text, frames: x.report.frames }; });
  const ver = await verifyGLB(Buffer.from(r.b64, 'base64'), r.bvh);
  check(ver.validator.errors === 0, 'live: validator errors');
  check(r.frames > 40, `live: only ${r.frames} frames baked`);
  check(Object.keys(ver.limb).length >= 6 && ver.meanLimbErrorDeg <= MAX_MEAN_DEG, `live: limb error ${ver.meanLimbErrorDeg}`);
  console.log(`live: ${r.frames} frames, mean limb error ${ver.meanLimbErrorDeg} deg`);
  await live.close(); wss.close();
} catch (e) { failures.push(`live: ${e.message}`); }

// ---- sample button: X Bot comes from the CDN (stubbed with the verified local copy), the BVH from this origin ----
try {
  const sc = await browser.newContext({ serviceWorkers: 'block' }), seen = [];
  await sc.route('https://cdn.jsdelivr.net/**', route => { seen.push(route.request().url()); route.fulfill({ status: 200, body: fs.readFileSync(path.join(fixtures, 'xbot.fbx')), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' } }); });
  const sp = await sc.newPage(); await sp.goto(`${origin}/index.html?nosw`);
  await sp.click('#btnSample');
  await sp.waitForSelector('#resultCard:not([hidden])', { timeout: 60000 });
  check(seen.length === 1 && seen[0] === SAMPLE_CHARACTERS.xbot.url, `sample: expected exactly one request, to the pinned X Bot URL; got ${JSON.stringify(seen)}`);
  check(await sp.evaluate(() => window.bodyrigWebCLI.state.modelName) === 'xbot.fbx', 'sample: X Bot did not load');
  await sc.close();
} catch (e) { failures.push(`sample: ${e.message}`); }

// ---- agent contract: run=bake from URLs, result handle, status attribute, determinism, error path ----
try {
  const drive = async (params, { timeout = 60000, hash = false } = {}) => {
    const p = await ctx.newPage();
    p.on('pageerror', e => pageErrors.push(`agent: ${e.message}`));
    await p.goto(`${origin}/index.html?nosw${hash ? '#' : '&'}${new URLSearchParams(params)}`, { waitUntil: 'commit' });
    await p.waitForSelector('body[data-webcli-status=done], body[data-webcli-status=error]', { timeout });
    const res = await p.evaluate(() => window.__webcli_result);
    const status = await p.getAttribute('body', 'data-webcli-status');
    const dl = await p.isVisible('[data-testid=download]');
    await p.close();
    return { res, status, dl };
  };
  const q = { character: '/fixtures/ybot.fbx', motion: '/fixtures/mocap-33s.bvh', run: 'bake', args: '--trim 0:4 --fps 15' };
  const a = await drive(q), b = await drive(q);
  const bytesOf = r => Buffer.from(r.res.artifact.dataUrl.split(',')[1], 'base64');
  check(a.status === 'done' && a.res.ok === true && a.res.op === 'bake' && a.res.error === null, `agent: bake did not finish ok: ${JSON.stringify(a.res).slice(0, 200)}`);
  check(a.res.artifact.mime === 'model/gltf-binary' && /\.glb$/.test(a.res.artifact.name), 'agent: artifact mime or name wrong');
  check(a.dl, 'agent: no Download button next to the handle');
  const ab = bytesOf(a);
  check(ab.subarray(0, 4).toString() === 'glTF' && ab.length === a.res.artifact.size, 'agent: artifact is not a GLB of the declared size');
  check(ab.equals(bytesOf(b)), 'agent: identical inputs gave different bytes (not deterministic)');
  console.log(`agent: run=bake from URLs -> ${Math.round(ab.length / 1024)} KB GLB, byte-identical on a second run`);

  // data: URLs (a previous stage's output, no server needed) go in the #fragment: they are too long for a request line
  const [bvhHead, bvhMotion] = bvhText.split('MOTION'), bvhRows = bvhMotion.split('\n').slice(3).filter(l => l.trim()).slice(0, 30);
  const shortBvh = `${bvhHead}MOTION\nFrames: ${bvhRows.length}\nFrame Time: 0.033333\n${bvhRows.join('\n')}\n`;
  const d = await drive({ character: '/fixtures/ybot.fbx', motion: `data:text/plain;base64,${Buffer.from(shortBvh).toString('base64')}`, run: 'bake', args: '--fps 15 --no-optimize' }, { hash: true });
  check(d.status === 'done' && d.res.ok && d.res.artifact.dataUrl.startsWith('data:model/gltf-binary;base64,'), `agent: data: URL inputs failed: ${d.res?.error}`);

  // a previous stage's output is a valid input: feed the baked GLB back as a motion source
  const chain = await drive({ character: '/fixtures/ybot.fbx', motion: a.res.artifact.dataUrl, run: 'bake', args: '--fps 15 --no-optimize' }, { hash: true });
  check(chain.status === 'done' && chain.res.ok, `agent: chaining a stage output as input failed: ${chain.res?.error}`);

  const bad = await drive({ character: '/fixtures/ybot.fbx', motion: '/fixtures/does-not-exist.bvh', run: 'bake' });
  check(bad.status === 'error' && bad.res.ok === false && bad.res.artifact === null && /404/.test(bad.res.error), `agent: bad input did not report an error: ${JSON.stringify(bad.res)}`);
  const op = await drive({ run: 'push' });
  check(op.status === 'error' && /Unknown run/.test(op.res.error), 'agent: unknown run= did not report an error');
} catch (e) { failures.push(`agent: ${e.message}`); }

// ---- zero egress: every request so far stayed on this origin, nothing carried a body ----
const foreign = requests.filter(r => !r.url.startsWith(origin) && !/^(data|blob):/.test(r.url));
check(!foreign.length, `egress: requests left the origin: ${foreign.slice(0, 3).map(r => r.url).join(', ')}`);
check(!requests.some(r => r.method !== 'GET' || r.body), 'egress: a non-GET request or request body was sent');
console.log(`egress: ${requests.length} requests, all same-origin GET with no body`);

// ---- offline: install the service worker, go offline, reload, bake again ----
try {
  const sw = await browser.newContext({ serviceWorkers: 'allow' });
  const off = await sw.newPage();
  off.on('pageerror', e => pageErrors.push(`offline: ${e.message}`));
  await off.goto(`${origin}/index.html`);
  await off.evaluate(async () => { await navigator.serviceWorker.ready; });
  await off.reload(); // now controlled by the worker
  await off.waitForFunction('window.bodyrigWebCLI?.ready === true');
  await off.evaluate(() => window.bodyrigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake')); // warms the runtime cache for the fixtures
  await sw.setOffline(true);
  await off.reload(); await off.waitForFunction('window.bodyrigWebCLI?.ready === true');
  const o = await off.evaluate(() => window.bodyrigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake').then(r => ({ kb: r.glbBytes / 1024, frames: r.report.frames })));
  check(o.frames > 900 && o.kb > 50, 'offline: bake failed or produced a tiny GLB');
  console.log(`offline: baked ${o.frames} frames to ${Math.round(o.kb)} KB with the network disabled`);
  await sw.close();
} catch (e) { failures.push(`offline: ${e.message}`); }

check(!pageErrors.length, `page errors: ${[...new Set(pageErrors)].slice(0, 3).join(' | ')}`);
await browser.close(); server.close();

if (failures.length) { console.error(`\nFAILED (${failures.length}):\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log(UPDATE ? '\ngolden frames updated' : '\nall checks passed');
