// app.js -- GUI over the raw command surface. Every control resolves to a command line; the command line is the source of truth.
import { createViewer } from './viewer.js';
import { loadModel, loadMotion, classify, isMapJSON, cleanMap } from './loaders.js';
import { normalizeRig, analyzeMapping, CORE_BONES, canonical } from './mocap-bake.mjs';
import { runBake, bytesToBase64 } from './pipeline.js';
import { parseCommand, formatCommand, DEFAULTS, PRESETS, EXAMPLES, HELP } from './command.js';
import { explainReport, groupUnmapped } from './advice.js';
import { connectLive } from './live.js';
import * as ai from './ai.js';

const $ = id => document.getElementById(id);
const viewer = createViewer($('viewer'));

const state = {
  files: new Map(),           // name -> { kind: 'model'|'motion'|'map', ... } -- the page's virtual file system
  opts: { ...DEFAULTS },
  model: null, modelName: null, rig: null, loadInfo: null,
  bvh: null, bvhName: null, bvhText: null, motionInfo: null,
  map: {}, last: null, busy: false, live: null, ai: null,
};

// ---------- status + log ----------
function setStatus(text, mode = 'ready') { $('statusText').textContent = text; $('dot').className = `dot ${mode}`; }
function log(text, cls = '') {
  const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const baseName = n => n.replace(/\.[^.]+$/, '');
const kb = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

// ---------- options <-> UI <-> command ----------
const optInputs = ['fps', 'trimStart', 'trimEnd', 'maxTex', 'level', 'inPlace', 'loop', 'align', 'optimize'];

function readOpts() {
  const o = { ...state.opts };
  o.fps = Math.min(240, Math.max(1, +$('fps').value || DEFAULTS.fps));
  const s = $('trimStart').value, e = $('trimEnd').value;
  o.trim = s !== '' || e !== '' ? [s === '' ? 0 : +s, e === '' ? null : +e] : null;
  o.maxTex = Math.max(0, Math.round(+$('maxTex').value || 0));
  o.level = $('level').value;
  for (const k of ['inPlace', 'loop', 'align', 'optimize']) o[k] = $(k).checked;
  return o;
}

function writeOpts(o) {
  state.opts = { ...DEFAULTS, ...o };
  $('fps').value = state.opts.fps;
  $('trimStart').value = state.opts.trim?.[0] || '';
  $('trimEnd').value = state.opts.trim?.[1] ?? '';
  $('maxTex').value = state.opts.maxTex || '';
  $('level').value = state.opts.level;
  for (const k of ['inPlace', 'loop', 'align', 'optimize']) $(k).checked = state.opts[k];
  $('cmd').value = formatCommand(state.opts);
}

for (const id of optInputs) $(id).addEventListener('input', () => { state.opts = readOpts(); $('cmd').value = formatCommand(state.opts); });

$('presets').append(...PRESETS.map(p => {
  const b = document.createElement('button'); b.className = 'preset';
  b.innerHTML = `<b>${p.label}</b><span>${p.desc}</span>`;
  b.onclick = () => { writeOpts({ ...parseCommand(p.cmd).opts, mapFile: state.opts.mapFile }); };
  return b;
}));
$('examples').append(...EXAMPLES.map(x => {
  const b = document.createElement('button'); b.className = 'example';
  b.innerHTML = `<code></code><span></span>`; b.firstChild.textContent = x.cmd; b.lastChild.textContent = x.note;
  b.onclick = () => { if (x.cmd.startsWith('bake')) writeOpts({ ...parseCommand(x.cmd).opts, mapFile: x.cmd.includes('--map') ? state.opts.mapFile : null }); $('cmd').value = x.cmd; $('cmd').focus(); };
  return b;
}));

// ---------- ingest files ----------
function renderChips() {
  const rows = [];
  if (state.modelName) rows.push(['character', state.modelName, state.loadInfo]);
  if (state.bvhName) rows.push(['motion', state.bvhName, state.motionInfo]);
  for (const [n, f] of state.files) if (f.kind === 'map') rows.push(['bone map', n, `${Object.keys(f.map).length} entries`]);
  $('chips').replaceChildren(...rows.map(([k, n, m]) => {
    const d = document.createElement('div'); d.className = 'chip';
    d.innerHTML = '<span class="kind"></span><span class="name"></span><span class="meta"></span>';
    d.children[0].textContent = k; d.children[1].textContent = n; d.children[2].textContent = m ?? '';
    return d;
  }));
}

async function setModel(name, buf) {
  setStatus(`Loading ${name}...`, 'busy');
  const { model, dropped, ms } = await loadModel(buf, name);
  const rig = normalizeRig(model); // also rejects un-rigged models early
  state.model = model; state.modelName = name; state.rig = rig; state.map = {}; state.last = null;
  state.opts.mapFile = null;
  state.loadInfo = `${rig.bones.length} bones${dropped.length ? `, ${dropped.length} textures dropped` : ''}`;
  state.modelLoadMs = ms; state.dropped = dropped;
  rig.poseAll(); viewer.setModel(model); $('viewerEmpty').hidden = true;
  log(`loaded ${name}: ${rig.bones.length} bones, ${rig.skins} skin(s)${rig.removedTwinBones ? `, collapsed ${rig.removedTwinBones} twin bones` : ''}${dropped.length ? `, dropped ${dropped.length} unresolved textures` : ''}`, 'dim');
}

function setMotion(name, text) {
  const { bvh, ms } = loadMotion(text);
  state.bvh = bvh; state.bvhName = name; state.bvhText = text; state.last = null;
  state.motionInfo = `${bvh.skeleton.bones.length} joints, ${bvh.clip.duration.toFixed(1)} s`;
  state.bvhLoadMs = ms;
  log(`loaded ${name}: ${bvh.skeleton.bones.length} joints, ${bvh.clip.duration.toFixed(2)} s`, 'dim');
}

function setMap(name, map) {
  state.files.set(name, { kind: 'map', map });
  state.map = { ...map }; state.opts.mapFile = name; $('cmd').value = formatCommand(state.opts);
  log(`loaded bone map ${name} (${Object.keys(map).length} entries); use --map ${name}`, 'dim');
}

async function ingest(name, buf) {
  let kind = classify(name);
  if (!kind) throw new Error(`Unsupported file type: ${name}`);
  if (kind === 'json') {
    const json = JSON.parse(new TextDecoder().decode(buf));
    kind = isMapJSON(json) ? 'map' : 'model';
    if (kind === 'map') { setMap(name, cleanMap(json)); renderChips(); renderMapping(); return kind; }
  }
  if (kind === 'model') { state.files.set(name, { kind, buf }); await setModel(name, buf); }
  else { const text = new TextDecoder().decode(buf); state.files.set(name, { kind, text }); setMotion(name, text); }
  renderChips(); renderMapping(); refreshButtons();
  return kind;
}

async function ingestFiles(list) {
  const files = [...list];
  try {
    for (const f of files) await ingest(f.name, await f.arrayBuffer());
    setStatus(state.model && state.bvh ? 'Ready. Baking...' : state.model ? 'Character loaded. Drop a BVH.' : 'Motion loaded. Drop a character.');
    if (state.model && state.bvh) await execute('bake');
  } catch (e) { fail(e); }
}

function fail(e) { log(`error: ${e.message || e}`, 'err'); setStatus(e.message || String(e), 'busy'); $('dot').className = 'dot'; console.error(e); }

function refreshButtons() {
  const ready = !!(state.model && state.bvh);
  $('btnBake').disabled = !ready || state.busy;
  $('btnAutoMap').disabled = !ready;
  $('btnSaveMap').disabled = !ready;
  $('btnLiveUse').disabled = !state.live || state.live.rec.frames.length < 2;
}

const drop = $('drop');
drop.onclick = () => $('fileInput').click();
drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') $('fileInput').click(); };
$('fileInput').onchange = e => { ingestFiles(e.target.files); e.target.value = ''; };
for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); });
for (const t of ['dragleave', 'drop']) drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', e => ingestFiles(e.dataTransfer.files));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); if (!drop.contains(e.target)) ingestFiles(e.dataTransfer.files); });

$('btnSample').onclick = async () => {
  try {
    setStatus('Loading sample...', 'busy');
    const [m, b] = await Promise.all(['samples/xbot.fbx', 'samples/mocap-33s.bvh'].map(u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.arrayBuffer(); })));
    await ingest('xbot.fbx', m); await ingest('mocap-33s.bvh', b);
    await execute('bake');
  } catch (e) { fail(e); }
};

// ---------- mapping panel ----------
function analysis() {
  if (!state.rig || !state.bvh) return null;
  return analyzeMapping(state.rig.bones, state.bvh.skeleton.bones, state.map);
}

function knownLabels(a) { // target bone -> core label, for bones the table (or user) already placed
  const out = {};
  for (const r of a.rows) if (r.source) { const c = canonical(r.source); if (CORE_BONES.includes(c)) out[r.target] = c; }
  return out;
}

function renderMapping() {
  const a = analysis();
  if (!a) { $('mapScroll').hidden = true; return; }
  const report = { bones: a.rows.length, mapped: a.rows.filter(r => r.source).length, unmapped: a.rows.filter(r => !r.source).map(r => r.target), missingCore: a.missingCore };
  const advice = explainReport(report);
  if (!a.hips) advice.unshift({ level: 'warn', text: 'The hips bone is not mapped. Pick the BVH hips bone for the character hips below; a bake cannot run without it.' });
  const ul = document.createElement('ul');
  for (const x of advice) { const li = document.createElement('li'); li.textContent = x.text; if (x.level === 'warn') li.style.color = 'var(--warn)'; ul.appendChild(li); }
  $('advice').replaceChildren(ul);

  const coreOnly = $('mapCore').checked, hidden = new Set([...Object.values(groupUnmapped(report.unmapped)).slice(0, 3)].flat());
  const srcNames = state.bvh.skeleton.bones.map(b => b.name);
  const rows = a.rows.filter(r => !coreOnly || r.manual || (r.source ? CORE_BONES.includes(r.canonical) : !hidden.has(r.target)));
  $('mapBody').replaceChildren(...rows.map(r => {
    const tr = document.createElement('tr'); tr.className = `${r.source ? '' : 'unmapped'} ${r.manual ? 'manual' : ''}`;
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="__auto__">auto</option><option value="">none (hold rest pose)</option>' + srcNames.map(n => `<option></option>`).join('');
    [...sel.options].slice(2).forEach((o, i) => { o.value = o.textContent = srcNames[i]; });
    sel.value = r.manual ? r.source ?? '' : '__auto__';
    if (!r.manual && r.source) sel.options[0].textContent = `auto: ${r.source}`;
    sel.onchange = () => {
      if (sel.value === '__auto__') delete state.map[r.canonical]; else state.map[r.canonical] = sel.value;
      state.opts.mapFile = null; $('cmd').value = formatCommand(state.opts); renderMapping();
    };
    tr.innerHTML = '<td></td><td></td><td></td>'; tr.children[0].textContent = r.target; tr.children[1].textContent = r.canonical; tr.children[2].appendChild(sel);
    return tr;
  }));
  $('mapScroll').hidden = false;
}

$('mapCore').onchange = renderMapping;
$('btnAutoMap').onclick = () => { state.map = {}; state.opts.mapFile = null; $('cmd').value = formatCommand(state.opts); renderMapping(); log('mapping reset to automatic', 'dim'); };

function currentMapTable() {
  const a = analysis(); const out = {};
  for (const r of a.rows) out[r.canonical] = r.source ?? '';
  return out;
}

$('btnSaveMap').onclick = () => {
  const name = `${baseName(state.modelName || 'character')}.map.json`;
  const table = currentMapTable();
  state.files.set(name, { kind: 'map', map: table });
  state.opts.mapFile = name; $('cmd').value = formatCommand(state.opts);
  download(new Blob([JSON.stringify(table, null, 2)], { type: 'application/json' }), name);
  renderChips(); log(`saved ${name}; reuse with --map ${name}`, 'ok');
};
$('btnLoadMap').onclick = () => $('mapInput').click();
$('mapInput').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) ingestFiles([f]); };

// ---------- stages panel ----------
function renderStages(report) {
  const base = [
    { n: 1, name: 'load', ms: (state.modelLoadMs ?? 0) + (state.bvhLoadMs ?? 0), info: { character: state.modelName, motion: state.bvhName, droppedTextures: state.dropped ?? [] } },
  ];
  const all = [...base, ...(report?.stages ?? [])];
  const have = new Set(all.map(s => s.n));
  const names = ['load', 'normalize rig', 'map bones', 'align reference pose', 'transfer rotations', 'root motion', 'export + optimize'];
  const els = [];
  for (let n = 1; n <= 7; n++) {
    const items = all.filter(s => s.n === n);
    const d = document.createElement('details'); d.className = `stage${have.has(n) ? '' : ' skipped'}`;
    const ms = items.reduce((t, s) => t + s.ms, 0);
    d.innerHTML = `<summary><span class="n">${n}</span><span>${names[n - 1]}</span><span class="ms">${have.has(n) ? fmtMs(ms) : 'not run'}</span></summary>`;
    if (have.has(n)) { const pre = document.createElement('pre'); pre.textContent = items.map(s => `${s.name}\n${JSON.stringify(s.info, null, 2)}`).join('\n\n'); d.appendChild(pre); }
    els.push(d);
  }
  $('stages').replaceChildren(...els);
}
renderStages(null);

// ---------- command execution ----------
async function resolveInputs(p) {
  const [mName, bName] = p.positional;
  for (const n of [mName, bName].filter(Boolean)) {
    const f = state.files.get(n);
    if (!f) throw new Error(`"${n}" is not loaded. Drop it on the page first.`);
    if (f.kind === 'model' && n !== state.modelName) await setModel(n, f.buf);
    else if (f.kind === 'motion' && n !== state.bvhName) setMotion(n, f.text);
    else if (f.kind === 'map') throw new Error(`"${n}" is a bone map; pass it with --map.`);
  }
  if (!state.model) throw new Error('No character loaded. Drop an FBX, GLB, VRM or rig.json.');
  if (!state.bvh) throw new Error('No motion loaded. Drop a BVH.');
}

function printMapping() {
  const a = analysis(); if (!a) throw new Error('Load a character and a BVH first.');
  const w = Math.max(...a.rows.map(r => r.target.length));
  log(`${a.rows.filter(r => r.source).length}/${a.rows.length} bones mapped${a.missingCore.length ? `; missing core: ${a.missingCore.join(', ')}` : ''}`, a.missingCore.length ? 'err' : 'ok');
  for (const r of a.rows) log(`${r.target.padEnd(w)}  ->  ${r.source ?? '(unmapped, holds rest pose)'}${r.manual ? '  [manual]' : ''}`, r.source ? 'dim' : 'err');
}

function printReport() {
  if (!state.last) throw new Error('Nothing baked yet.');
  for (const s of state.last.report.stages) log(`[${s.n}] ${s.name} (${fmtMs(s.ms)})  ${JSON.stringify(s.info)}`, 'dim');
}

async function executeRaw(line) {
  const p = parseCommand(line);
  if (!p) return null;
  switch (p.cmd) {
    case 'help': log(HELP, 'dim'); return null;
    case 'clear': $('log').replaceChildren(); return null;
    case 'inspect': printReport(); return null;
    case 'usdz': return exportUsdz(p.opts.out);
    case 'map': await resolveInputs(p); applyMapFile(p.opts.mapFile); renderMapping(); printMapping(); return null;
    case 'bake': return bake(p);
  }
}

function applyMapFile(name) {
  if (!name) return;
  const f = state.files.get(name);
  if (!f || f.kind !== 'map') throw new Error(`Bone map "${name}" is not loaded. Drop it on the page or save one from the mapping panel.`);
  state.map = { ...f.map }; renderMapping();
}

async function bake(p) {
  if (state.busy) throw new Error('A bake is already running.');
  await resolveInputs(p);
  writeOpts(p.opts);
  applyMapFile(p.opts.mapFile);
  const manual = Object.keys(state.map).length;
  if (manual && !p.opts.mapFile) log(`note: ${manual} manual mapping override(s) active; save the map to reproduce this with --map`, 'dim');
  state.busy = true; refreshButtons(); setStatus('Baking...', 'busy');
  try {
    const t = performance.now();
    const res = await runBake({ model: state.model, bvh: state.bvh, opts: p.opts, map: state.map });
    const name = p.opts.out || `${baseName(state.modelName)}_${baseName(state.bvhName)}.glb`;
    state.last = { ...res, name, rawName: `${baseName(name)}_universal.glb`, optimized: p.opts.optimize };
    const hip = state.model.getObjectByName(res.report.stages.find(s => s.n === 6).info.hip);
    viewer.setClip(res.clip, hip);
    renderStages(res.report); renderMapping(); recordStats(res.report);
    $('resultCard').hidden = false;
    $('btnDownload').textContent = p.opts.optimize ? 'Download compressed GLB' : 'Download GLB';
    $('btnDownloadRaw').hidden = !p.opts.optimize; $('resultHint').hidden = false;
    $('resultInfo').textContent = `${name}: ${kb(res.glb.byteLength)}${p.opts.optimize ? ` (raw ${kb(res.rawBytes)})` : ''} | ${res.report.duration.toFixed(1)} s, ${res.report.frames} frames at ${res.report.fps} fps | ${res.report.mapped}/${res.report.bones} bones mapped | total ${fmtMs(performance.now() - t)}`;
    log(`baked ${name}: ${kb(res.glb.byteLength)}, ${res.report.frames} frames in ${fmtMs(performance.now() - t)}`, 'ok');
    setStatus(`Done: ${name} (${kb(res.glb.byteLength)}). Playing preview.`);
    $('btnPlay').disabled = false; $('scrub').disabled = false; viewer.play(); $('btnPlay').textContent = 'Pause';
    return state.last;
  } finally { state.busy = false; refreshButtons(); }
}

// ---------- USDZ (macOS Preview / Quick Look cannot open GLB) ----------
async function buildUsdz() {
  if (!state.last) throw new Error('Bake first; USDZ is built from the last bake.');
  const t = performance.now();
  const { exportUSDZ } = await import('./usdz.js');
  const r = await exportUSDZ(state.model, state.last.clip, { rig: state.rig, fps: state.last.report.fps });
  viewer.seek(viewer.time);
  state.last.usdz = r.usdz;
  log(`built USDZ: ${kb(r.usdz.byteLength)}, ${r.joints} joints, ${r.meshes} mesh(es), ${r.frames} frames in ${fmtMs(performance.now() - t)}${r.skippedMeshes.length ? `; skipped ${r.skippedMeshes.length} unskinned mesh(es)` : ''}`, 'ok');
  return r;
}

async function exportUsdz(out) {
  await buildUsdz();
  const name = out ? `${baseName(out)}.usdz` : `${baseName(state.last.name)}.usdz`;
  download(new Blob([state.last.usdz], { type: 'model/vnd.usdz+zip' }), name);
  return state.last;
}

$('btnDownloadUsdz').onclick = () => execute('usdz');

async function execute(line) {
  log(`$ ${line}`, 'cmd-echo');
  try { return await executeRaw(line); } catch (e) { fail(e); return null; }
}

$('btnBake').onclick = () => execute(formatCommand(readOpts()));
$('btnRun').onclick = () => execute($('cmd').value);
$('cmd').addEventListener('keydown', e => { if (e.key === 'Enter') execute($('cmd').value); });

// ---------- playback ----------
$('btnPlay').onclick = () => { if (viewer.playing) { viewer.pause(); $('btnPlay').textContent = 'Play'; } else { viewer.play(); $('btnPlay').textContent = 'Pause'; } };
$('scrub').oninput = () => viewer.seek(($('scrub').value / 1000) * viewer.duration);
viewer.onTime(t => {
  const d = viewer.duration;
  if (document.activeElement !== $('scrub')) $('scrub').value = d ? (t / d) * 1000 : 0;
  $('time').textContent = `${t.toFixed(2)} / ${d.toFixed(2)} s`;
});

// ---------- download ----------
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
$('btnDownload').onclick = () => state.last && download(new Blob([state.last.glb], { type: 'model/gltf-binary' }), state.last.name);
$('btnDownloadRaw').onclick = () => state.last && download(new Blob([state.last.raw], { type: 'model/gltf-binary' }), state.last.rawName);

// ---------- live stream ----------
$('btnLiveConnect').onclick = () => {
  try {
    state.live?.close();
    const url = $('liveUrl').value.trim();
    state.live = connectLive(url, {
      header: state.bvhText,
      onState: s => { $('liveStatus').textContent = s === 'open' ? 'Connected. Recording...' : s === 'error' ? 'Connection error.' : 'Closed.'; $('btnLiveStop').disabled = s !== 'open'; refreshButtons(); },
      onHeader: rec => { $('liveStatus').textContent = `Header received: ${rec.kinds.length} channels.`; },
      onFrame: rec => { $('liveStatus').textContent = `Recording: ${rec.frames.length} frames, ${rec.seconds.toFixed(1)} s${rec.bad ? `, ${rec.bad} rejected` : ''}`; if (rec.frames.length === 2) refreshButtons(); },
    });
  } catch (e) { fail(e); }
};
$('btnLiveStop').onclick = () => { state.live?.close(); refreshButtons(); };
$('btnLiveUse').onclick = () => {
  try {
    const text = state.live.rec.toBVH(state.opts.fps);
    state.files.set('live.bvh', { kind: 'motion', text });
    setMotion('live.bvh', text); renderChips(); renderMapping(); refreshButtons();
    log(`recording turned into live.bvh at ${state.opts.fps} fps; run bake`, 'ok');
  } catch (e) { fail(e); }
};

// ---------- zero-egress, locally measured stats (never sent) ----------
const STATS_KEY = 'rig-webcli-stats';
function recordStats(report) {
  const s = JSON.parse(localStorage.getItem(STATS_KEY) || '{"bakes":0,"missingCore":0}');
  s.bakes++; if (report.missingCore.length) s.missingCore++;
  localStorage.setItem(STATS_KEY, JSON.stringify(s));
  renderStats();
}
function renderStats() {
  const s = JSON.parse(localStorage.getItem(STATS_KEY) || '{"bakes":0,"missingCore":0}');
  $('aiStats').textContent = `Measured on this device only: ${s.missingCore} of ${s.bakes} bakes left a core bone unmapped.`;
}
renderStats();

// ---------- optional AI ----------
$('btnAiLoad').onclick = async () => {
  if (!ai.supported()) { $('aiStatus').textContent = 'WebGPU is not available in this browser, so the model cannot run. The core path is unaffected.'; return; }
  $('btnAiLoad').disabled = true; $('aiProgress').hidden = false;
  try {
    state.ai = await ai.loadEngine((p, text) => { $('aiProgress').firstChild.style.width = `${Math.round(p * 100)}%`; $('aiStatus').textContent = text; });
    $('aiStatus').textContent = 'Model ready (running locally).'; $('aiTools').hidden = false;
  } catch (e) { $('aiStatus').textContent = `Could not load the model: ${e.message}`; $('btnAiLoad').disabled = false; }
  $('aiProgress').hidden = true;
};

$('btnAiLabel').onclick = async () => {
  try {
    const a = analysis(); if (!a) throw new Error('Load a character and a BVH first.');
    const unknown = a.rows.filter(r => !r.source).map(r => r.target);
    if (!unknown.length) { $('aiStatus').textContent = 'Nothing is unmapped.'; return; }
    const known = knownLabels(a);
    const described = ai.describeBones(state.rig.bones, known, unknown.slice(0, 40));
    $('aiStatus').textContent = 'Asking the local model...';
    const labels = await ai.proposeLabels(state.ai, described);
    const { accepted, rejected } = ai.validateLabels(state.rig.bones, known, labels);
    const bvhByCanon = new Map(state.bvh.skeleton.bones.map(b => [canonical(b.name), b.name]));
    let applied = 0;
    for (const [bone, label] of Object.entries(accepted)) {
      const src = bvhByCanon.get(label); if (!src) continue;
      state.map[canonical(bone)] = src; applied++;
    }
    state.opts.mapFile = null; $('cmd').value = formatCommand(state.opts); renderMapping();
    for (const r of rejected) log(`AI label rejected: ${r.bone} as ${r.label} (${r.reason})`, 'err');
    $('aiStatus').textContent = `${applied} label(s) passed the geometry check and were applied; ${rejected.length} rejected.`;
  } catch (e) { $('aiStatus').textContent = `Failed: ${e.message}`; }
};

$('btnAiCmd').onclick = async () => {
  try {
    const line = await ai.proposeCommand(state.ai, $('aiPrompt').value);
    writeOpts({ ...parseCommand(line).opts, mapFile: state.opts.mapFile }); $('cmd').value = line;
    $('aiStatus').textContent = 'Command filled in above. Review it, then Run.';
  } catch (e) { $('aiStatus').textContent = `Failed: ${e.message}`; }
};

// ---------- test/automation hook (Playwright drives the real page through this) ----------
window.rigWebCLI = {
  ready: true,
  state,
  async bakeUrls(modelUrl, bvhUrl, line = 'bake', mapUrl = null) {
    const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.arrayBuffer(); });
    const name = u => decodeURIComponent(u.split('/').pop());
    const [m, b] = await Promise.all([get(modelUrl), get(bvhUrl)]);
    if (mapUrl) await ingest(name(mapUrl), await get(mapUrl));
    await ingest(name(modelUrl), m); await ingest(name(bvhUrl), b);
    const r = await executeRaw(line);
    return { b64: bytesToBase64(r.glb), report: r.report, glbBytes: r.glb.byteLength, rawBytes: r.rawBytes };
  },
  async bakeObject(object, bvhText, line = 'bake') {
    state.model = object; state.modelName = 'synthetic.glb'; state.rig = normalizeRig(object); state.map = {};
    viewer.setModel(object); setMotion('synthetic.bvh', bvhText); state.files.set('synthetic.bvh', { kind: 'motion', text: bvhText });
    const r = await executeRaw(line);
    return { b64: bytesToBase64(r.glb), report: r.report, glbBytes: r.glb.byteLength };
  },
  execute: executeRaw,
  b64: bytesToBase64,
  async usdz() { const r = await buildUsdz(); return { b64: bytesToBase64(r.usdz), ...r, usdz: undefined }; },
  ai,
};

if (location.protocol.startsWith('http') && 'serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}
