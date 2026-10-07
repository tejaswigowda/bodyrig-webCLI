// webcli.js -- the pure-transform contract: URL / dropped file in, artifact handle out. Read-only GETs; no git, token, repo write or versioning.
// Pure functions (no DOM) so the page and the unit tests share them.
//   ?character=<url>&motion=<url>[&motion=<url>...][&map=<url>][&args=--fps 24 --trim 2:10][&run=bake]

export const OPS = ['bake'];
export const STATUSES = ['idle', 'running', 'done', 'error'];

const KNOWN_EXT = /\.(fbx|glb|gltf|vrm|bvh|json)$/i;
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)@([^:\s]+):(.+)$/;
const RAW = /^https:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^/]+)\/(.+)$/;

// `owner/repo@ref:path` is optional sugar for the jsDelivr URL; any other string is already a URL.
export function expandSource(spec) {
  const m = SHORTHAND.exec(spec);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : spec;
}

// raw.githubusercontent.com rate-limits; the same file is served by jsDelivr.
export function rawFallback(url) {
  const m = RAW.exec(url);
  return m ? `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}` : null;
}

// The same parameters are read from the #fragment too: it never reaches the server, so a long data: URL does not hit request-size limits.
export function parseRunParams(search, hash = '') {
  const q = new URLSearchParams(search), h = new URLSearchParams(hash.replace(/^#/, ''));
  const get = k => h.get(k) ?? q.get(k), all = k => [...q.getAll(k), ...h.getAll(k)];
  const p = { character: get('character'), motion: all('motion'), map: get('map'), run: get('run'), args: get('args') ?? '' };
  if (p.run && !OPS.includes(p.run)) throw new Error(`Unknown run=${p.run}. Supported: ${OPS.join(', ')}.`);
  if (p.run && (!p.character || !p.motion.length)) throw new Error(`run=${p.run} needs character=<url> and at least one motion=<url>.`);
  p.requested = !!(p.character || p.motion.length || p.map || p.run);
  return p;
}

// data: and blob: URLs and extension-less URLs have no usable file name; the content decides the extension.
export function sniffExt(buf) {
  const u = new Uint8Array(buf, 0, Math.min(buf.byteLength, 64));
  const head = new TextDecoder('latin1').decode(u);
  if (head.startsWith('glTF')) return '.glb';
  if (head.startsWith('Kaydara FBX') || head.startsWith('; FBX')) return '.fbx';
  if (/^\s*HIERARCHY/.test(head)) return '.bvh';
  if (/^\s*[{[]/.test(head)) return '.json';
  return '';
}

const safeName = s => s.replace(/[\s"'\\]+/g, '_');

function nameFromUrl(url) {
  if (/^(data|blob):/i.test(url)) return '';
  try { return decodeURIComponent(new URL(url, 'http://x/').pathname.split('/').pop() || ''); } catch { return ''; }
}

// Returns { name, buf, url }. Only ever a GET with no body and no credentials.
export async function fetchInput(spec, fallbackName, fetchImpl = globalThis.fetch) {
  const url = expandSource(spec);
  const get = async u => {
    const res = await fetchImpl(u, { method: 'GET', credentials: 'omit' });
    if (!res.ok) throw new Error(`GET ${u.slice(0, 120)}: ${res.status}`);
    return res.arrayBuffer();
  };
  let buf;
  try { buf = await get(url); } catch (e) {
    const alt = rawFallback(url);
    if (!alt) throw e;
    buf = await get(alt);
  }
  let name = nameFromUrl(url);
  if (!KNOWN_EXT.test(name)) name = `${name ? safeName(name) : fallbackName}${sniffExt(buf)}`;
  return { name: safeName(name), buf, url };
}
