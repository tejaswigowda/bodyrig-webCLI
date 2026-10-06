// matrix.mjs -- Playwright drives the REAL page (dev/CI only, never part of the product).
// characters x BVH x option variants -> run the page -> GLB -> glTF-validator + limb-error threshold + golden frames,
// plus zero-egress, offline (service worker) and live-stream checks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createServer } from '../server.js';
import { verifyGLB, compareGolden } from './verify.mjs';
import { buildSyntheticRig } from './synthetic-rig.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures'), localFixtures = path.join(root, 'tests', 'fixtures-local');
const outDir = path.join(root, 'tests', 'out'), goldenDir = path.join(root, 'tests', 'golden');
const UPDATE = process.argv.includes('--update-golden');
const MAX_MEAN_DEG = 3, MAX_P95_DEG = 8;
fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(goldenDir, { recursive: true });

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
await page.waitForFunction('window.rigWebCLI?.ready === true');

for (const ch of characters) for (const v of variants) {
  const job = `${ch.id}/${v.id}`;
  try {
    const r = await page.evaluate(async ({ ch, v, bvh, src }) => {
      if (ch.synthetic) {
        const build = (0, eval)(`(${src})`);
        return window.rigWebCLI.bakeObject(await build(), await (await fetch(bvh)).text(), v.line);
      }
      return window.rigWebCLI.bakeUrls(ch.url, bvh, v.line);
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
  await ui.setInputFiles('#modelInput', [path.join(fixtures, 'ybot.fbx')]);
  await ui.waitForFunction(() => window.rigWebCLI.state.model);
  check(!(await ui.locator('#resultCard').isVisible()), 'ui: baked before any animation track was added');
  await ui.setInputFiles('#motionInput', [path.join(fixtures, BVH)]);
  await ui.waitForSelector('#resultCard:not([hidden])', { timeout: 60000 });
  check((await ui.locator('#mapBody tr').count()) > 10, 'ui: mapping table did not render');
  check((await ui.locator('#btnDownloadRaw, #btnDownloadUsdz').count()) === 0, 'ui: universal GLB / USDZ buttons should be gone');
  check(await ui.locator('#trackSelect').isHidden(), 'ui: track selector shown for a single track');
  check((await ui.locator('.stage:not(.skipped)').count()) === 7, 'ui: not all seven stages reported');
  // playback: the pose must change with the scrubber and advance on its own
  const pose = () => ui.evaluate(() => { let q; window.rigWebCLI.state.model.traverse(o => { if (o.isBone && /LeftUpLeg$/.test(o.name)) q = o.quaternion.toArray().map(x => +x.toFixed(4)).join(); }); return q; });
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
  // mapping panel: pin Spine2 to the BVH Spine1 manually, save the map, and reuse it from the raw command
  await ui.selectOption('#mapBody tr:has-text("mixamorigSpine2") select', 'Spine1');
  check(await ui.locator('#mapBody tr.manual').count() === 1, 'ui: manual mapping row not flagged');
  await ui.click('#btnSaveMap');
  check((await ui.inputValue('#cmd')).includes('--map ybot.map.json'), 'ui: saving the map did not update the command');
  await ui.click('#btnRun');
  await ui.waitForFunction(() => (document.getElementById('log').textContent.match(/baked ybot_mocap-33s\.glb/g) || []).length >= 3, null, { timeout: 60000 }); // auto-bake, the 15 fps run, then this one
  const savedMap = await ui.evaluate(() => window.rigWebCLI.state.files.get('ybot.map.json').map);
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
  check((await ui.locator('.chip:has(.kind:text("track"))').count()) === 1, 'ui: removing a track chip did not remove the track');
  check(!uiErrors.length, `ui: page errors: ${uiErrors.slice(0, 2).join(' | ')}`);
  await ui.close();
} catch (e) { failures.push(`ui: ${e.message}`); }

// ---- several animation tracks (BVH + a GLB animation) embedded as separate animations in one GLB ----
try {
  const r = await page.evaluate(() => window.rigWebCLI.bakeUrls('/fixtures/ybot.fbx', ['/fixtures/mocap-33s.bvh', '/out/xbot.trim-inplace-24fps.glb'], 'bake --no-optimize --trim 0:4 --fps 15'));
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
  const one = await page.evaluate(() => window.rigWebCLI.execute('bake ybot.fbx xbot.trim-inplace-24fps.glb --no-optimize').then(x => x.clips.map(c => c.name)));
  check(JSON.stringify(one) === JSON.stringify(['xbot.trim-inplace-24fps']), `tracks: named motion selected ${one}`);
  console.log(`tracks: ${r.tracks.join(' + ')} -> ${v0.animations.length} animations, limb error ${v0.meanLimbErrorDeg} / ${v1.meanLimbErrorDeg} deg`);
} catch (e) { failures.push(`tracks: ${e.message}`); }

// ---- export fidelity: FBX-style "transparent at opacity 1" materials must not export as BLEND ----
try {
  const r = await page.evaluate(async () => {
    const THREE = await import('/vendor/three/three.module.js');
    const { settleAlphaModes } = await import('/js/pipeline.js');
    const cv = fn => { const c = document.createElement('canvas'); c.width = c.height = 64; fn(c.getContext('2d')); return new THREE.CanvasTexture(c); };
    const white = () => cv(g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); });
    const half = () => cv(g => { g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#000'; g.fillRect(0, 0, 32, 64); });
    const mk = o => new THREE.MeshStandardMaterial({ transparent: true, ...o });
    const mats = { opaque: mk({ map: white(), alphaMap: white() }), cutout: mk({ map: white(), alphaMap: half() }), glass: mk({ opacity: 0.5 }), plain: mk({}) };
    const g = new THREE.Group(); for (const m of Object.values(mats)) g.add(new THREE.Mesh(new THREE.BufferGeometry(), m));
    const snap = () => Object.fromEntries(Object.entries(mats).map(([k, m]) => [k, { t: m.transparent, a: m.alphaTest, am: !!m.alphaMap }]));
    const s = settleAlphaModes(g), during = snap(); s.restore();
    return { during, after: snap() };
  });
  check(!r.during.opaque.t && r.during.opaque.a === 0, `alpha: an opaque alpha map should export OPAQUE, got ${JSON.stringify(r.during.opaque)}`);
  check(!r.during.cutout.t && r.during.cutout.a === 0.5 && !r.during.cutout.am, `alpha: a cutout alpha map should export MASK with the map folded in, got ${JSON.stringify(r.during.cutout)}`);
  check(r.during.glass.t, 'alpha: real translucency (opacity 0.5) must stay BLEND');
  check(!r.during.plain.t, 'alpha: a textureless opacity-1 material should export OPAQUE');
  check(r.after.opaque.t && r.after.cutout.t && r.after.cutout.am && r.after.cutout.a === 0, 'alpha: live materials were not restored after export');
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
  await live.waitForFunction('window.rigWebCLI?.ready === true');
  await live.setInputFiles('#modelInput', [path.join(fixtures, 'xbot.fbx')]);
  await live.waitForFunction(() => window.rigWebCLI.state.model);
  await live.locator('details:has(#liveUrl) > summary').click();
  await live.fill('#liveUrl', `ws://127.0.0.1:${wss.address().port}`);
  await live.click('#btnLiveConnect');
  await live.waitForFunction(() => /Recording: (\d+) frames/.test(document.getElementById('liveStatus').textContent) && +document.getElementById('liveStatus').textContent.match(/(\d+) frames/)[1] >= 80, null, { timeout: 20000 });
  await live.click('#btnLiveStop'); await live.click('#btnLiveUse');
  const r = await live.evaluate(async () => { const x = await window.rigWebCLI.execute('bake --no-optimize'); const s = window.rigWebCLI.state; return { b64: window.rigWebCLI.b64(x.glb), bvh: s.motions[0].text, frames: x.report.frames }; });
  const ver = await verifyGLB(Buffer.from(r.b64, 'base64'), r.bvh);
  check(ver.validator.errors === 0, 'live: validator errors');
  check(r.frames > 40, `live: only ${r.frames} frames baked`);
  check(Object.keys(ver.limb).length >= 6 && ver.meanLimbErrorDeg <= MAX_MEAN_DEG, `live: limb error ${ver.meanLimbErrorDeg}`);
  console.log(`live: ${r.frames} frames, mean limb error ${ver.meanLimbErrorDeg} deg`);
  await live.close(); wss.close();
} catch (e) { failures.push(`live: ${e.message}`); }

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
  await off.waitForFunction('window.rigWebCLI?.ready === true');
  await off.evaluate(() => window.rigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake')); // warms the runtime cache for the fixtures
  await sw.setOffline(true);
  await off.reload(); await off.waitForFunction('window.rigWebCLI?.ready === true');
  const o = await off.evaluate(() => window.rigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake').then(r => ({ kb: r.glbBytes / 1024, frames: r.report.frames })));
  check(o.frames > 900 && o.kb > 50, 'offline: bake failed or produced a tiny GLB');
  console.log(`offline: baked ${o.frames} frames to ${Math.round(o.kb)} KB with the network disabled`);
  await sw.close();
} catch (e) { failures.push(`offline: ${e.message}`); }

check(!pageErrors.length, `page errors: ${[...new Set(pageErrors)].slice(0, 3).join(' | ')}`);
await browser.close(); server.close();

if (failures.length) { console.error(`\nFAILED (${failures.length}):\n - ${failures.join('\n - ')}`); process.exit(1); }
console.log(UPDATE ? '\ngolden frames updated' : '\nall checks passed');
