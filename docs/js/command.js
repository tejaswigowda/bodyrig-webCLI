// command.js -- the raw control surface. Pure functions (no DOM) so the GUI, the terminal box and tests share one grammar.
//   bake [model] [unit ...] [--fps N] [--trim S:E] [--in-place] [--loop] [--no-align] [--foot-lock] [--map FILE]
//        [--morph-map FILE] [--face-head] [--optimize | --no-optimize] [--level medium|high] [--max-tex N] [--no-jpeg]
//        [--hide NAME[,NAME]] [--out NAME]
//   A unit is one file (body or face .json) or a pair written body+face, e.g. walk.bvh+smile.json.
//   map  [--map FILE]        auto-map and print the mapping table
//   inspect                  print the stage-by-stage report of the last bake
//   help | clear

export const DEFAULTS = { fps: 30, trim: null, inPlace: false, loop: false, align: true, footLock: false, mapFile: null, optimize: true, jpeg: true, level: 'medium', maxTex: 0, hide: null, out: null, morphMapFile: null, faceHead: false };
export const COMMANDS = ['bake', 'map', 'inspect', 'help', 'clear'];
const VALUE_FLAGS = new Set(['fps', 'trim', 'map', 'morph-map', 'level', 'max-tex', 'hide', 'out']);
const BOOL_FLAGS = new Set(['in-place', 'loop', 'no-align', 'foot-lock', 'face-head', 'optimize', 'no-optimize', 'no-jpeg']);

export function tokenize(line) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function parseTrim(v) {
  const m = /^(\d*\.?\d*):(\d*\.?\d*)$/.exec(v);
  if (!m || (m[1] === '' && m[2] === '')) throw new Error(`--trim expects START:END in seconds (e.g. 2:10, 2:, :10), got "${v}"`);
  const a = m[1] === '' ? 0 : +m[1], b = m[2] === '' ? null : +m[2];
  if (b !== null && b <= a) throw new Error(`--trim end (${b}) must be greater than start (${a})`);
  return [a, b];
}

// "walk.bvh" is a body-only unit, "smile.json" a face-only unit, "walk.bvh+smile.json" a body+face pair.
// Face files are .json; anything else is a body. A unit holds at most one of each.
export function parseUnit(token) {
  const parts = token.split('+');
  const isFace = p => /\.json$/i.test(p);
  if (parts.length > 2 || parts.some(p => p === '')) throw new Error(`Unit "${token}" must be one body file, one face .json, or body+face (e.g. walk.bvh+smile.json)`);
  if (parts.length === 2 && (parts.filter(isFace).length !== 1)) throw new Error(`Unit "${token}" must pair one body file with one face .json`);
  const body = parts.find(p => !isFace(p)) ?? null;
  const face = parts.find(isFace) ?? null;
  return { token, body, face };
}

export function parseCommand(line) {
  const tok = tokenize(line.trim());
  if (!tok.length) return null;
  const cmd = tok.shift();
  if (!COMMANDS.includes(cmd)) throw new Error(`Unknown command "${cmd}". Try: ${COMMANDS.join(', ')}`);
  const positional = [], flags = {};
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t.startsWith('--')) { positional.push(t); continue; }
    const name = t.slice(2);
    if (VALUE_FLAGS.has(name)) {
      if (i + 1 >= tok.length) throw new Error(`--${name} needs a value`);
      flags[name] = tok[++i];
    } else if (BOOL_FLAGS.has(name)) flags[name] = true;
    else throw new Error(`Unknown flag --${name}`);
  }
  for (const p of positional) if (p.includes('+')) parseUnit(p);
  const opts = { ...DEFAULTS };
  if ('fps' in flags) {
    opts.fps = +flags.fps;
    if (!Number.isFinite(opts.fps) || opts.fps < 1 || opts.fps > 240) throw new Error(`--fps must be between 1 and 240, got "${flags.fps}"`);
  }
  if ('trim' in flags) opts.trim = parseTrim(flags.trim);
  if (flags['in-place']) opts.inPlace = true;
  if (flags.loop) opts.loop = true;
  if (flags['no-align']) opts.align = false;
  if (flags['foot-lock']) opts.footLock = true;
  if (flags['no-jpeg']) opts.jpeg = false;
  if (flags.map) opts.mapFile = flags.map;
  if (flags['morph-map']) opts.morphMapFile = flags['morph-map'];
  if (flags['face-head']) opts.faceHead = true;
  if (flags['no-optimize']) opts.optimize = false;
  if (flags.optimize) opts.optimize = true;
  if ('level' in flags) {
    if (!['medium', 'high'].includes(flags.level)) throw new Error('--level must be medium or high');
    opts.level = flags.level;
  }
  if ('max-tex' in flags) {
    opts.maxTex = +flags['max-tex'];
    if (!Number.isInteger(opts.maxTex) || opts.maxTex < 0) throw new Error('--max-tex must be a non-negative integer (pixels)');
  }
  if (flags.hide) opts.hide = flags.hide;
  if (flags.out) opts.out = flags.out;
  return { cmd, positional, opts, flags };
}

const q = s => (/\s/.test(s) ? `"${s}"` : s);

export function formatCommand(opts, { model, motions = [] } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parts = ['bake'];
  if (model) parts.push(q(model));
  for (const m of motions) parts.push(q(m));
  if (o.fps !== DEFAULTS.fps) parts.push('--fps', o.fps);
  if (o.trim) parts.push('--trim', `${o.trim[0] || ''}:${o.trim[1] ?? ''}`);
  if (o.inPlace) parts.push('--in-place');
  if (o.loop) parts.push('--loop');
  if (!o.align) parts.push('--no-align');
  if (o.footLock) parts.push('--foot-lock');
  if (!o.jpeg) parts.push('--no-jpeg');
  if (o.mapFile) parts.push('--map', q(o.mapFile));
  if (o.morphMapFile) parts.push('--morph-map', q(o.morphMapFile));
  if (o.faceHead) parts.push('--face-head');
  if (!o.optimize) parts.push('--no-optimize');
  else if (o.level !== DEFAULTS.level) parts.push('--level', o.level);
  if (o.maxTex) parts.push('--max-tex', o.maxTex);
  if (o.hide) parts.push('--hide', q(o.hide));
  if (o.out) parts.push('--out', q(o.out));
  return parts.join(' ');
}

// Level 1 presets and level 2 example library both resolve to raw commands -- nothing is hidden behind a button.
export const PRESETS = [
  { id: 'default', label: 'Web-optimized', desc: '30 fps, meshopt-compressed GLB', cmd: 'bake' },
  { id: 'quality', label: 'Full quality', desc: '60 fps, no compression', cmd: 'bake --fps 60 --no-optimize' },
  { id: 'loop', label: 'In-place loop', desc: 'Stay on the spot, closed cycle', cmd: 'bake --in-place --loop' },
  { id: 'mobile', label: 'Phone-friendly', desc: '24 fps, 1024 px textures', cmd: 'bake --fps 24 --max-tex 1024' },
];

export const EXAMPLES = [
  { cmd: 'bake', note: 'Retarget every loaded motion at 30 fps; each becomes its own animation track in one GLB.' },
  { cmd: 'bake character.glb walk.bvh run.fbx', note: 'Name the character and only the motion files to embed.' },
  { cmd: 'bake --trim 2:10', note: 'Keep seconds 2 to 10 only.' },
  { cmd: 'bake --trim :5 --fps 60', note: 'First 5 seconds at 60 fps.' },
  { cmd: 'bake --in-place --loop --trim 2:6', note: 'Idle/walk-in-place cycle from a 4 second window.' },
  { cmd: 'bake --no-optimize', note: 'Skip meshopt; the raw GLTFExporter output.' },
  { cmd: 'bake --level high --max-tex 2048', note: 'Stronger mesh compression, cap texture size.' },
  { cmd: 'bake --no-align', note: 'Skip reference-pose alignment (only for rigs already in the BVH rest pose).' },
  { cmd: 'bake --foot-lock', note: 'Pin planted feet and bend the legs with two-bone IK; also keeps the hips at the right height.' },
  { cmd: 'bake --map map.json', note: 'Apply a saved bone map (drop it on the page or save one from the mapping panel).' },
  { cmd: 'bake --hide Outfits', note: 'Leave out every mesh whose name, or a parent group name, contains "Outfits" (preview and export).' },
  { cmd: 'bake hero.glb walk.bvh+smile.json', note: 'One unit: the walk drives the body and smile.json drives the face, on the same timeline.' },
  { cmd: 'bake hero.glb walk.bvh+smile.json run.fbx', note: 'Two units in one GLB: a paired walk+face and a body-only run.' },
  { cmd: 'bake hero.glb smile.json', note: 'Face-only unit: blendshapes only, the rest of the body keeps its pose.' },
  { cmd: 'bake --morph-map names.json walk.bvh+smile.json', note: 'Map ARKit names to this model\'s morph targets when the names differ.' },
  { cmd: 'bake --face-head walk.bvh+smile.json', note: 'Also drive the head from the capture\'s head rotation (experimental; axis convention unverified).' },
  { cmd: 'map', note: 'Auto-map bones and print the table, including unmapped bones.' },
  { cmd: 'inspect', note: 'Show every pipeline stage of the last bake.' },
];

export const HELP = `Commands
  bake [model] [unit ...] [flags]     each unit is a body motion (BVH, FBX, GLB), a face .json, or body+face (walk.bvh+smile.json)
  map  [--map FILE]               auto-map bones, print the table
  inspect                         stage-by-stage report of the last bake
  clear                           clear this log

Flags for bake
  --fps N            output frame rate (default 30)
  --trim S:E         seconds window, e.g. 2:10, 2: or :10
  --in-place         remove horizontal root travel
  --loop             make the last frame equal the first
  --no-align         skip reference-pose alignment
  --foot-lock        detect foot contacts, pin them and correct the legs with two-bone IK (not with --in-place)
  --map FILE         bone map JSON (dropped or saved in this page)
  --morph-map FILE   ARKit-52 to morph-target name JSON, e.g. {"jawOpen": "Mouth_Open"}; only for face units
  --face-head        also drive the head bone from the face capture's head rotation (experimental); replaces the body head track
  --optimize / --no-optimize   meshopt compression (default on)
  --level medium|high          meshopt level
  --max-tex N        downscale textures to at most N px
  --no-jpeg          keep every texture lossless PNG (default: textures without alpha are written as JPEG)
  --hide NAME[,NAME] leave out meshes whose name or a parent group name contains NAME (case-insensitive), e.g. --hide Outfits
  --out NAME         output file name`;
