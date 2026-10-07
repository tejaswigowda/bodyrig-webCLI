// Static dev server for docs/. No COOP/COEP needed: the core path uses no SharedArrayBuffer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.bvh': 'text/plain', '.wasm': 'application/wasm',
};

export function createServer(dir = root, extra = {}) {
  return http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    let base = dir;
    for (const [prefix, d] of Object.entries(extra)) if (rel.startsWith(prefix)) { base = d; rel = rel.slice(prefix.length - 1); break; }
    const file = path.join(base, rel);
    if (!file.startsWith(base)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-length': st.size });
      fs.createReadStream(file).pipe(res);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 8010;
  createServer().listen(port, '127.0.0.1', () => console.log(`bodyrig-webCLI at http://127.0.0.1:${port}`));
}
