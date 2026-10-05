// matrix.mjs -- Playwright drives the REAL page (dev/CI only, never part of the product).
// characters x BVH x option variants -> run the page -> GLB -> glTF-validator + limb-error threshold + golden frames,
// plus zero-egress, offline (service worker) and live-stream checks.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

const server = createServer(path.join(root, 'docs'), { '/fixtures/': fixtures, '/local/': localFixtures });
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
  await ui.setInputFiles('#fileInput', [path.join(fixtures, 'ybot.fbx'), path.join(fixtures, BVH)]);
  await ui.waitForSelector('#resultCard:not([hidden])', { timeout: 60000 });
  check((await ui.locator('#mapBody tr').count()) > 10, 'ui: mapping table did not render');
  check(await ui.locator('#btnDownloadRaw').isVisible(), 'ui: universal GLB button missing after an optimized bake');
  const needs = await ui.evaluate(() => { const u = new Uint8Array(window.rigWebCLI.state.last.raw); const n = new DataView(u.buffer).getUint32(12, true); return JSON.parse(new TextDecoder().decode(u.subarray(20, 20 + n))).extensionsRequired ?? []; });
  check(!needs.length, `ui: universal GLB requires extensions: ${needs}`);
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
  check(!uiErrors.length, `ui: page errors: ${uiErrors.slice(0, 2).join(' | ')}`);
  await ui.close();
} catch (e) { failures.push(`ui: ${e.message}`); }

// ---- USDZ for macOS Preview (which cannot open GLB): structure everywhere, Apple's own loader on macOS ----
try {
  const r = await page.evaluate(async () => { await window.rigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake --trim 0:4 --fps 15 --no-optimize'); return window.rigWebCLI.usdz(); });
  const usdz = Buffer.from(r.b64, 'base64'); fs.writeFileSync(path.join(outDir, 'xbot.usdz'), usdz);
  const nameLen = usdz.readUInt16LE(26), extraLen = usdz.readUInt16LE(28);
  check(usdz.subarray(30, 30 + nameLen).toString() === 'model.usda', 'usdz: model.usda must be the first entry');
  check((30 + nameLen + extraLen) % 64 === 0, 'usdz: first entry is not 64-byte aligned');
  check(usdz.readUInt16LE(8) === 0, 'usdz: entries must be stored, not compressed');
  if (process.platform === 'darwin') {
    const bin = path.join(outDir, 'usdz-check');
    execFileSync('swiftc', [path.join(root, 'tests', 'usdz-check.swift'), '-o', bin], { stdio: 'pipe' });
    const info = JSON.parse(execFileSync(bin, [path.join(outDir, 'xbot.usdz')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    check(info.meshes >= 1 && info.joints === r.joints && info.skinners >= 1 && info.animations >= 1, `usdz: Apple loader saw ${JSON.stringify(info)}`);
    console.log(`usdz: ModelIO/SceneKit loaded ${JSON.stringify(info)}`);
  } else console.log('usdz: structure checked (Apple loader check runs on macOS only)');
} catch (e) { failures.push(`usdz: ${e.message}`); }

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
  await live.setInputFiles('#fileInput', [path.join(fixtures, 'xbot.fbx')]);
  await live.waitForFunction(() => window.rigWebCLI.state.model);
  await live.locator('details:has(#liveUrl) > summary').click();
  await live.fill('#liveUrl', `ws://127.0.0.1:${wss.address().port}`);
  await live.click('#btnLiveConnect');
  await live.waitForFunction(() => /Recording: (\d+) frames/.test(document.getElementById('liveStatus').textContent) && +document.getElementById('liveStatus').textContent.match(/(\d+) frames/)[1] >= 80, null, { timeout: 20000 });
  await live.click('#btnLiveStop'); await live.click('#btnLiveUse');
  const r = await live.evaluate(async () => { const x = await window.rigWebCLI.execute('bake --no-optimize'); const s = window.rigWebCLI.state; return { b64: window.rigWebCLI.b64(x.glb), bvh: s.bvhText, frames: x.report.frames }; });
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
