import { chromium } from 'playwright';
import { createServer } from '../server.js';
import fs from 'node:fs';
const srv = createServer('docs', {'/fixtures/': 'tests/fixtures'});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
p.on('pageerror', e => console.log('pageerror:', e.stack));
await p.goto(origin + '/index.html?nosw');
await p.waitForFunction('window.rigWebCLI?.ready');
await p.evaluate(() => window.rigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake --trim 0:2 --fps 15 --no-optimize'));
const out = await p.evaluate(async () => {
  const THREE = await import('three');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const s = window.rigWebCLI.state, model = s.model, clip = s.last.clip;
  s.rig.poseAll();
  const skinned = []; model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  const info = skinned.map(m => ({ name: m.name, verts: m.geometry.attributes.position.count, index: m.geometry.index?.array.constructor.name, tris: m.geometry.index ? m.geometry.index.count / 3 : null }));
  // split every skinned mesh into chunks of < 65535 vertices
  const LIMIT = 60000, chunks = [];
  for (const m of skinned) {
    const g = m.geometry, idx = g.index ? g.index.array : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    const names = Object.keys(g.attributes);
    let remap = new Map(), tri = [], order = [];
    const flush = () => {
      if (!tri.length) return;
      const ng = new THREE.BufferGeometry();
      for (const n of names) { const a = g.attributes[n], Arr = a.array.constructor, out = new Arr(order.length * a.itemSize); order.forEach((v, i) => { for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.array[v * a.itemSize + k]; }); ng.setAttribute(n, new THREE.BufferAttribute(out, a.itemSize, a.normalized)); }
      ng.setIndex(new THREE.BufferAttribute(Uint16Array.from(tri), 1));
      const c = new THREE.SkinnedMesh(ng, new THREE.MeshStandardMaterial({ color: m.material.color?.clone() ?? 0xcccccc, roughness: 0.8, metalness: 0 }));
      c.name = `${m.name}_${chunks.length}`; c.bind(m.skeleton, m.bindMatrix); chunks.push([m, c]);
      remap = new Map(); tri = []; order = [];
    };
    for (let t = 0; t < idx.length; t += 3) {
      const fresh = [0, 1, 2].filter(k => !remap.has(idx[t + k])).length;
      if (order.length + fresh > LIMIT) flush();
      for (let k = 0; k < 3; k++) { const v = idx[t + k]; if (!remap.has(v)) { remap.set(v, order.length); order.push(v); } tri.push(remap.get(v)); }
    }
    flush();
  }
  for (const m of skinned) m.parent.remove(m);
  for (const [m, c] of chunks) { const mi = m; (mi.__parent ?? model).add(c); }
  const res = {};
  res.P_xbot_chunked_uint16 = window.rigWebCLI.b64(await new GLTFExporter().parseAsync(model, { binary: true, animations: [clip], onlyVisible: true, trs: true }));
  return { res, info, chunks: chunks.length };
});
console.log(JSON.stringify(out.info), out.chunks);
fs.mkdirSync('tests/out/preview-bisect', { recursive: true });
for (const [k, v] of Object.entries(out.res)) { fs.writeFileSync(`tests/out/preview-bisect/${k}.glb`, Buffer.from(v, 'base64')); console.log(k, Math.round(v.length * 0.75 / 1024), 'KB'); }
await b.close(); srv.close();
