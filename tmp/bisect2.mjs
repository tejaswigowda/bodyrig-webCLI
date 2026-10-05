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
  const exp = async (roots, anims = [], trs = true) => window.rigWebCLI.b64(await new GLTFExporter().parseAsync(roots, { binary: true, animations: anims, onlyVisible: false, trs }));
  const toStd = m => { const n = new THREE.MeshStandardMaterial({ color: m.color?.clone() ?? 0xcccccc, roughness: 0.8, metalness: 0 }); n.name = m.name; return n; };
  model.traverse(o => { if (o.isMesh) o.material = toStd([].concat(o.material)[0]); });
  s.rig.poseAll();
  const res = {};

  // J: smallest possible skinned mesh: 2 bones, one box, TRS nodes, ubyte joints, flat scene roots
  {
    const geo = new THREE.BoxGeometry(0.2, 1, 0.2, 1, 4, 1); geo.translate(0, 0.5, 0);
    const n = geo.attributes.position.count, si = new Uint8Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const y = geo.attributes.position.getY(i); const w = Math.min(1, Math.max(0, y)); si[i * 4] = 0; si[i * 4 + 1] = 1; sw[i * 4] = 1 - w; sw[i * 4 + 1] = w; }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    const b0 = new THREE.Bone(); b0.name = 'root'; const b1 = new THREE.Bone(); b1.name = 'tip'; b1.position.y = 1; b0.add(b1);
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.8 })); mesh.name = 'tube';
    mesh.add(b0); mesh.bind(new THREE.Skeleton([b0, b1])); mesh.updateMatrixWorld(true);
    res.J_minimal_skinned_tube = await exp([mesh]);
  }

  // F: xbot skinned, TRS nodes instead of matrices (as before, wrapped in a group)
  res.F_xbot_trs = await exp(model);

  // G: F + unsigned-byte joint indices
  const savedSI = new Map();
  model.traverse(o => { if (o.isSkinnedMesh) { const a = o.geometry.attributes.skinIndex; savedSI.set(o, a); o.geometry.setAttribute('skinIndex', new THREE.BufferAttribute(Uint8Array.from(a.array), 4)); } });
  res.G_xbot_trs_ubyte = await exp(model);

  // H: G + skinned meshes and the skeleton root as direct scene roots, mesh transform baked to identity
  const meshes = []; model.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
  const rootBone = s.rig.bones.find(b => !b.parent?.isBone);
  const roots = [rootBone];
  for (const m of meshes) { m.updateMatrixWorld(true); }
  const restore = meshes.map(m => ({ m, parent: m.parent, geo: m.geometry }));
  for (const m of meshes) {
    const g2 = m.geometry.clone(); g2.applyMatrix4(m.matrixWorld);
    const c = new THREE.SkinnedMesh(g2, m.material); c.name = m.name; c.bind(m.skeleton, new THREE.Matrix4()); roots.push(c);
  }
  rootBone.updateMatrixWorld(true);
  res.H_xbot_flat_roots = await exp(roots);
  return res;
});
fs.mkdirSync('tests/out/preview-bisect', { recursive: true });
for (const [k, v] of Object.entries(out)) { fs.writeFileSync(`tests/out/preview-bisect/${k}.glb`, Buffer.from(v, 'base64')); console.log(k, Math.round(v.length * 0.75 / 1024), 'KB'); }
await b.close(); srv.close();
