// app.js -- GUI over the raw command surface. Every control resolves to a command line; the command line is the source of truth.
import { createViewer } from './viewer.js';
import { loadModel, loadMotion, loadMotionFile, classify, isMapJSON, cleanMap } from './loaders.js';
import { normalizeRig, analyzeMapping, CORE_BONES, canonical } from './mocap-bake.mjs';
import { runBake, bytesToBase64 } from './pipeline.js';
import { parseCommand, formatCommand, DEFAULTS, PRESETS, EXAMPLES, HELP } from './command.js';
import { explainReport, groupUnmapped } from './advice.js';
import { connectLive } from './live.js';
import * as ai from './ai.js';
import { SAMPLE_CHARACTERS } from './samples.js';
import { parseRunParams, fetchInput } from './webcli.js';

const $ = id => document.getElementById(id);
const viewer = createViewer($('viewer'));

const state = {
  files: new Map(),           // name -> { kind: 'map', map } -- saved / loaded bone maps
  models: new Map(),          // character file name -> bytes, so a command can switch characters by name
  opts: { ...DEFAULTS },
  model: null, modelName: null, rig: null, loadInfo: null,
  motions: [],                // animation tracks: { file, name, source, info, ms, text? } -- one per BVH, one per clip of an FBX / GLB
  mapTrack: 0,                // which track the mapping panel shows
  map: {}, last: null, busy: false, live: null, ai: null,
};

// ---------- agent contract: data-webcli-status + window.__webcli_result (same shape across the family) ----------
function webcliStatus(s) { document.body.setAttribute('data-webcli-status', s); if (s === 'running') window.__webcli_result = null; }
function publishResult(r) {
  const mime = 'model/gltf-binary';
  let dataUrl; // built on first read: only agents need it
  const artifact = { mime, name: r.name, size: r.glb.byteLength };
  Object.defineProperty(artifact, 'dataUrl', { enumerable: true, get: () => (dataUrl ??= `data:${mime};base64,${bytesToBase64(r.glb)}`) });
  const rep = r.report;
  window.__webcli_result = { ok: true, op: 'bake', artifact, error: null, meta: { tracks: r.clips.map(c => c.name), frames: rep.frames, fps: rep.fps, mapped: rep.mapped, bones: rep.bones } };
  webcliStatus('done');
}
webcliStatus('idle');

// ---------- status + log ----------
function setStatus(text, mode = 'ready') { $('statusText').textContent = text; $('dot').className = `dot ${mode}`; }
function log(text, cls = '') {
  const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const baseName = n => n.replace(/\.[^.]+$/, '');
const kb = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

// ---------- progress: spinner + bar for every load, removal and bake ----------
const jobs = new Set();
const paint = () => new Promise(r => setTimeout(r, 30)); // lets the spinner paint before a long synchronous parse blocks the thread

function renderBusy() {
  const j = [...jobs].at(-1);
  $('spinner').hidden = $('busyBar').hidden = !j;
  document.body.setAttribute('aria-busy', j ? 'true' : 'false');
  if (!j) return;
  const known = j.fraction != null;
  $('busyBar').className = `busybar ${known ? 'determinate' : 'indeterminate'}`;
  $('busyFill').style.width = known ? `${Math.round(j.fraction * 100)}%` : '';
  $('busyBar').setAttribute('aria-valuenow', known ? Math.round(j.fraction * 100) : '');
  setStatus(j.label, 'busy');
}

// info.pending: { kind, name } shows a placeholder chip; info.removing: chip key (a track file or 'character') shown as being removed.
async function job(label, fn, info = {}) {
  const j = { label, fraction: null, ...info };
  jobs.add(j); renderBusy(); renderChips(); refreshButtons(); await paint();
  try { return await fn(j); } finally { jobs.delete(j); renderBusy(); renderChips(); refreshButtons(); }
}

function progress(j, fraction, label) { j.fraction = fraction; if (label) j.label = label; renderBusy(); }

// ---------- options <-> UI <-> command ----------
const optInputs = ['fps', 'trimStart', 'trimEnd', 'maxTex', 'level', 'inPlace', 'loop', 'align', 'footLock', 'optimize'];

function readOpts() {
  const o = { ...state.opts };
  o.fps = Math.min(240, Math.max(1, +$('fps').value || DEFAULTS.fps));
  const s = $('trimStart').value, e = $('trimEnd').value;
  o.trim = s !== '' || e !== '' ? [s === '' ? 0 : +s, e === '' ? null : +e] : null;
  o.maxTex = Math.max(0, Math.round(+$('maxTex').value || 0));
  o.level = $('level').value;
  for (const k of ['inPlace', 'loop', 'align', 'footLock', 'optimize']) o[k] = $(k).checked;
  return o;
}

function writeOpts(o) {
  state.opts = { ...DEFAULTS, ...o };
  $('fps').value = state.opts.fps;
  $('trimStart').value = state.opts.trim?.[0] || '';
  $('trimEnd').value = state.opts.trim?.[1] ?? '';
  $('maxTex').value = state.opts.maxTex || '';
  $('level').value = state.opts.level;
  for (const k of ['inPlace', 'loop', 'align', 'footLock', 'optimize']) $(k).checked = state.opts[k];
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
const curMotion = () => state.motions[Math.min(state.mapTrack, state.motions.length - 1)] ?? null;
const bvhHeaderText = () => state.motions.find(m => m.text)?.text ?? null;

function renderChips() {
  const rows = [];
  const removing = key => [...jobs].some(j => j.removing === key);
  if (state.modelName) rows.push({ kind: 'character', name: state.modelName, meta: state.loadInfo, key: 'character', rm: true });
  for (const m of state.motions) rows.push({ kind: 'track', name: m.name, meta: m.info, key: m.file, file: m.file, rm: true });
  for (const [n, f] of state.files) if (f.kind === 'map') rows.push({ kind: 'bone map', name: n, meta: `${Object.keys(f.map).length} entries` });
  for (const j of jobs) if (j.pending) rows.push({ kind: j.pending.kind, name: j.pending.name, meta: 'loading...', busy: true });
  $('chips').replaceChildren(...rows.map(r => {
    const busy = r.busy || removing(r.key);
    const d = document.createElement('div'); d.className = `chip${busy ? ' busy' : ''}`;
    d.innerHTML = '<span class="kind"></span><span class="name"></span><span class="meta"></span>';
    d.children[0].textContent = r.kind; d.children[1].textContent = r.name; d.children[2].textContent = removing(r.key) ? 'removing...' : r.meta ?? '';
    if (busy) { const s = document.createElement('span'); s.className = 'spinner'; d.appendChild(s); }
    else if (r.rm) {
      const b = document.createElement('button'); b.className = 'rm'; b.textContent = '\u00d7'; b.title = `Remove ${r.name}`; b.setAttribute('aria-label', `Remove ${r.name}`);
      b.onclick = () => (r.file ? removeMotionFile(r.file) : removeCharacter());
      d.appendChild(b);
    }
    return d;
  }));
  const sel = $('mapTrack'), many = state.motions.length > 1;
  sel.replaceChildren(...state.motions.map((m, i) => { const o = document.createElement('option'); o.value = i; o.textContent = m.name; return o; }));
  sel.value = Math.min(state.mapTrack, Math.max(0, state.motions.length - 1));
  $('mapTrackField').hidden = !many;
}

async function setModel(name, buf) {
  await job(`Loading character ${name}...`, async () => {
    const { model, dropped, ms } = await loadModel(buf, name);
    const rig = normalizeRig(model); // also rejects un-rigged models early
    state.models.set(name, buf);
    state.model = model; state.modelName = name; state.rig = rig; state.map = {}; state.last = null;
    state.opts.mapFile = null;
    state.loadInfo = `${rig.bones.length} bones${dropped.length ? `, ${dropped.length} textures dropped` : ''}`;
    state.modelLoadMs = ms; state.dropped = dropped;
    rig.poseAll(); viewer.setModel(model); $('viewerEmpty').hidden = true;
    log(`loaded ${name}: ${rig.bones.length} bones, ${rig.skins} skin(s)${rig.removedTwinBones ? `, collapsed ${rig.removedTwinBones} twin bones` : ''}${dropped.length ? `, dropped ${dropped.length} unresolved textures` : ''}`, 'dim');
  }, { pending: { kind: 'character', name } });
}

const describeSource = (s, dur) => `${s.bones.length} joints, ${dur.toFixed(1)} s`;

function resetResult() {
  state.last = null;
  $('resultCard').hidden = true; $('trackSelect').hidden = true;
  $('btnPlay').disabled = true; $('scrub').disabled = true; $('btnPlay').textContent = 'Play';
  viewer.clearClips(); renderStages(null);
}

async function afterRemoval() {
  if (isReady()) await execute('bake'); else { resetResult(); setStatus(state.model ? 'Add an animation track.' : 'Drop a character and at least one animation to begin.'); }
}

async function removeMotionFile(file) {
  try {
    await job(`Removing ${file}...`, async () => {
      state.motions = state.motions.filter(m => m.file !== file);
      state.mapTrack = Math.min(state.mapTrack, Math.max(0, state.motions.length - 1));
      state.last = null; renderMapping();
      log(`removed ${file}`, 'dim');
    }, { removing: file });
    await afterRemoval();
  } catch (e) { fail(e); }
}

async function removeCharacter() {
  try {
    const name = state.modelName;
    await job(`Removing ${name}...`, async () => {
      state.models.delete(name);
      state.model = state.rig = state.modelName = state.loadInfo = null; state.map = {}; state.opts.mapFile = null; state.dropped = [];
      viewer.clear(); $('viewerEmpty').hidden = false; resetResult(); renderMapping();
      log(`removed ${name}`, 'dim');
    }, { removing: 'character' });
    await afterRemoval();
  } catch (e) { fail(e); }
}

function addBvhText(name, text) {
  const { bvh, source, ms } = loadMotion(text);
  state.motions = state.motions.filter(m => m.file !== name);
  state.motions.push({ file: name, name: baseName(name), source, text, ms, info: describeSource(source, source.clip.duration) });
  state.last = null;
  log(`loaded ${name}: ${source.bones.length} joints, ${source.clip.duration.toFixed(2)} s${bvh.absoluteRootPosition ? '; root positions are absolute (OFFSET not added)' : ''}`, 'dim');
}

async function addAnimationFile(name, buf) {
  await job(`Loading animation ${name}...`, async () => {
    const { sources, ms } = await loadMotionFile(buf, name);
    state.motions = state.motions.filter(m => m.file !== name);
    sources.forEach((source, i) => state.motions.push({
      file: name, ms: i ? 0 : ms, source, info: describeSource(source, source.clip.duration),
      name: sources.length > 1 ? `${baseName(name)}_${source.clip.name || i + 1}` : baseName(name),
    }));
    state.last = null;
    log(`loaded ${name}: ${sources.length} animation clip(s), ${sources[0].bones.length} joints`, 'dim');
  }, { pending: { kind: 'track', name } });
}

function setMap(name, map) {
  state.files.set(name, { kind: 'map', map });
  state.map = { ...map }; state.opts.mapFile = name; $('cmd').value = formatCommand(state.opts);
  log(`loaded bone map ${name} (${Object.keys(map).length} entries); use --map ${name}`, 'dim');
}

// role: which upload the file came through ('model' | 'motion'); undefined = decide by extension (BVH is a motion, the rest a character).
async function ingest(name, buf, role) {
  let kind = classify(name, role);
  if (!kind) throw new Error(`Unsupported file type: ${name}`);
  if (kind === 'json') {
    const json = JSON.parse(new TextDecoder().decode(buf));
    kind = isMapJSON(json) ? 'map' : 'model';
    if (kind === 'map') { setMap(name, cleanMap(json)); renderChips(); renderMapping(); return kind; }
  }
  if (kind === 'model') await setModel(name, buf);
  else if (/\.bvh$/i.test(name)) await job(`Parsing ${name}...`, async () => addBvhText(name, new TextDecoder().decode(buf)), { pending: { kind: 'track', name } });
  else await addAnimationFile(name, buf);
  renderChips(); renderMapping(); refreshButtons();
  return kind;
}

const isReady = () => !!(state.model && state.motions.length);

async function ingestFiles(list, role) {
  const files = [...list];
  try {
    for (const f of files) await ingest(f.name, await f.arrayBuffer(), role);
    setStatus(isReady() ? 'Ready. Baking...' : state.model ? 'Character loaded. Add an animation track.' : 'Animation loaded. Drop a character.');
    if (isReady()) await execute('bake');
  } catch (e) { fail(e); }
}

function fail(e) {
  log(`error: ${e.message || e}`, 'err'); setStatus(e.message || String(e), 'busy'); $('dot').className = 'dot'; console.error(e);
  window.__webcli_result = { ok: false, op: 'bake', artifact: null, error: String(e.message || e) };
  webcliStatus('error');
}

function refreshButtons() {
  const ready = isReady();
  $('btnBake').disabled = !ready || state.busy;
  $('btnBake').textContent = state.busy ? 'Baking...' : 'Bake & export GLB';
  $('btnAutoMap').disabled = !ready;
  $('btnSaveMap').disabled = !ready;
  $('btnLiveUse').disabled = !state.live || state.live.rec.frames.length < 2;
}

function wireDrop(zone, input, role) {
  zone.onclick = () => input.click();
  zone.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') input.click(); };
  input.onchange = e => { ingestFiles(e.target.files, role); e.target.value = ''; };
  for (const t of ['dragenter', 'dragover']) zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); });
  zone.addEventListener('drop', e => { e.stopPropagation(); ingestFiles(e.dataTransfer.files, role); });
}
wireDrop($('dropModel'), $('modelInput'), 'model');
wireDrop($('dropMotion'), $('motionInput'), 'motion');
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); ingestFiles(e.dataTransfer.files); });

$('btnSample').onclick = async () => {
  try {
    const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.arrayBuffer(); });
    const [m, b] = await job('Fetching the sample...', () => Promise.all([get(SAMPLE_CHARACTERS.xbot.url), get('samples/mocap-33s.bvh')]));
    await ingest('xbot.fbx', m, 'model'); await ingest('mocap-33s.bvh', b, 'motion');
    await execute('bake');
  } catch (e) { fail(e); }
};

// ---------- mapping panel ----------
function analysis() {
  const m = curMotion();
  if (!state.rig || !m) return null;
  return analyzeMapping(state.rig.bones, m.source.bones, state.map);
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
  const srcNames = curMotion().source.bones.map(b => b.name);
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
$('mapTrack').onchange = () => { state.mapTrack = +$('mapTrack').value; renderMapping(); };
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
    { n: 1, name: 'load', ms: (state.modelLoadMs ?? 0) + state.motions.reduce((t, m) => t + (m.ms ?? 0), 0), info: { character: state.modelName, tracks: state.motions.map(m => m.name), droppedTextures: state.dropped ?? [] } },
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
// Returns the tracks to bake: the motion files named on the command line, or every loaded track.
async function resolveInputs(p) {
  let modelChosen = false; const motionFiles = [];
  for (const n of p.positional) {
    if (!modelChosen && state.models.has(n)) { modelChosen = true; if (n !== state.modelName) await setModel(n, state.models.get(n)); }
    else if (state.motions.some(m => m.file === n)) motionFiles.push(n);
    else if (state.files.get(n)?.kind === 'map') throw new Error(`"${n}" is a bone map; pass it with --map.`);
    else throw new Error(`"${n}" is not loaded. Drop it on the page first.`);
  }
  if (!state.model) throw new Error('No character loaded. Drop an FBX, GLB or VRM into Character.');
  const motions = motionFiles.length ? state.motions.filter(m => motionFiles.includes(m.file)) : state.motions;
  if (!motions.length) throw new Error('No animation loaded. Drop a BVH, FBX or GLB into Animation tracks.');
  return motions;
}

function printMapping() {
  const a = analysis(); if (!a) throw new Error('Load a character and an animation first.');
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
  const motions = await resolveInputs(p);
  writeOpts(p.opts);
  applyMapFile(p.opts.mapFile);
  const manual = Object.keys(state.map).length;
  if (manual && !p.opts.mapFile) log(`note: ${manual} manual mapping override(s) active; save the map to reproduce this with --map`, 'dim');
  state.busy = true; refreshButtons(); webcliStatus('running');
  try {
    return await job(`Retargeting ${motions.length} track${motions.length > 1 ? 's' : ''}...`, async j => {
    const t = performance.now();
    const res = await runBake({ model: state.model, motions: motions.map(m => ({ name: m.name, source: m.source })), opts: p.opts, map: state.map, onProgress: (f, label) => progress(j, f, label) });
    const name = p.opts.out || `${baseName(state.modelName)}_${res.clips.length > 1 ? `${res.clips.length}-tracks` : res.clips[0].name}.glb`;
    state.last = { ...res, name, optimized: p.opts.optimize };
    const hip = state.model.getObjectByName(res.report.stages.find(s => s.n === 6).info.hip);
    viewer.setClips(res.clips, hip);
    $('trackSelect').replaceChildren(...res.clips.map((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = c.name; return o; }));
    $('trackSelect').hidden = res.clips.length < 2;
    renderStages(res.report); renderMapping(); recordStats(res.report);
    $('resultCard').hidden = false; $('resultHint').hidden = false;
    const tracks = res.clips.length > 1 ? `${res.clips.length} tracks (${res.report.tracks.map(t => `${t.name} ${t.duration.toFixed(1)} s`).join(', ')}) at ${res.report.fps} fps` : `${res.report.duration.toFixed(1)} s, ${res.report.frames} frames at ${res.report.fps} fps`;
    $('resultInfo').textContent = `${name}: ${kb(res.glb.byteLength)}${p.opts.optimize ? ` (raw ${kb(res.rawBytes)})` : ''} | ${tracks} | ${res.report.mapped}/${res.report.bones} bones mapped | total ${fmtMs(performance.now() - t)}`;
    log(`baked ${name}: ${kb(res.glb.byteLength)}, ${res.clips.length} track(s), ${res.report.tracks.reduce((s, x) => s + x.frames, 0)} frames in ${fmtMs(performance.now() - t)}`, 'ok');
    setStatus(`Done: ${name} (${kb(res.glb.byteLength)}). Playing preview.`);
    $('btnPlay').disabled = false; $('scrub').disabled = false; viewer.play(); $('btnPlay').textContent = 'Pause';
    publishResult(state.last);
    return state.last;
    });
  } finally { state.busy = false; refreshButtons(); }
}

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
$('trackSelect').onchange = () => { viewer.selectClip(+$('trackSelect').value); };
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

// ---------- live stream ----------
$('btnLiveConnect').onclick = () => {
  try {
    state.live?.close();
    const url = $('liveUrl').value.trim();
    state.live = connectLive(url, {
      header: bvhHeaderText(),
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
    addBvhText('live.bvh', text); renderChips(); renderMapping(); refreshButtons();
    log(`recording turned into the live.bvh track at ${state.opts.fps} fps; run bake`, 'ok');
  } catch (e) { fail(e); }
};

// ---------- zero-egress, locally measured stats (never sent) ----------
const STATS_KEY = 'bodyrig-webcli-stats';
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
    const a = analysis(); if (!a) throw new Error('Load a character and an animation first.');
    const unknown = a.rows.filter(r => !r.source).map(r => r.target);
    if (!unknown.length) { $('aiStatus').textContent = 'Nothing is unmapped.'; return; }
    const known = knownLabels(a);
    const described = ai.describeBones(state.rig.bones, known, unknown.slice(0, 40));
    $('aiStatus').textContent = 'Asking the local model...';
    const labels = await ai.proposeLabels(state.ai, described);
    const { accepted, rejected } = ai.validateLabels(state.rig.bones, known, labels);
    const bvhByCanon = new Map(curMotion().source.bones.map(b => [canonical(b.name), b.name]));
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
window.bodyrigWebCLI = {
  ready: true,
  state,
  async bakeUrls(modelUrl, motionUrls, line = 'bake', mapUrl = null) {
    const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.arrayBuffer(); });
    const name = u => decodeURIComponent(u.split('/').pop());
    const urls = [].concat(motionUrls);
    const [m, ...bufs] = await Promise.all([get(modelUrl), ...urls.map(get)]);
    if (mapUrl) await ingest(name(mapUrl), await get(mapUrl));
    state.motions = [];
    await ingest(name(modelUrl), m, 'model');
    for (const [i, u] of urls.entries()) await ingest(name(u), bufs[i], 'motion');
    const r = await executeRaw(line);
    return { b64: bytesToBase64(r.glb), report: r.report, glbBytes: r.glb.byteLength, rawBytes: r.rawBytes, tracks: r.clips.map(c => c.name) };
  },
  async bakeObject(object, bvhText, line = 'bake') {
    state.model = object; state.modelName = 'synthetic.glb'; state.rig = normalizeRig(object); state.map = {};
    viewer.setModel(object); state.motions = []; addBvhText('synthetic.bvh', bvhText);
    const r = await executeRaw(line);
    return { b64: bytesToBase64(r.glb), report: r.report, glbBytes: r.glb.byteLength };
  },
  execute: executeRaw,
  b64: bytesToBase64,
  ai,
};

// ---------- run from the URL: inputs by GET, no click, result via the handle ----------
async function autoRun(p) {
  webcliStatus('running');
  try {
    const specs = [
      ...(p.character ? [{ spec: p.character, role: 'model', name: 'character' }] : []),
      ...p.motion.map((spec, i) => ({ spec, role: 'motion', name: `motion-${i + 1}` })),
      ...(p.map ? [{ spec: p.map, role: undefined, name: 'map' }] : []),
    ];
    const inputs = await Promise.all(specs.map(s => fetchInput(s.spec, s.name)));
    let mapName = null;
    for (const [i, f] of inputs.entries()) {
      const kind = await ingest(f.name, f.buf, specs[i].role);
      if (kind === 'map') mapName = f.name;
    }
    if (p.map && !mapName) throw new Error('map= is not a bone map JSON.');
    if (!p.run) { webcliStatus('idle'); setStatus(isReady() ? 'Ready.' : 'Inputs loaded.'); return; }
    await executeRaw(['bake', mapName && `--map ${mapName}`, p.args].filter(Boolean).join(' '));
  } catch (e) { fail(e); }
}

try {
  const params = parseRunParams(location.search, location.hash);
  if (params.requested) autoRun(params);
} catch (e) { fail(e); }

if (location.protocol.startsWith('http') && 'serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}
