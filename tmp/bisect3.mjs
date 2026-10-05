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
  const exp = async (roots, anims = []) => window.rigWebCLI.b64(await new GLTFExporter().parseAsync(roots, { binary: true, animations: anims, onlyVisible: false, trs: true }));
  const toStd = m => { const n = new THREE.MeshStandardMaterial({ color: m.color?.clone() ?? 0xcccccc, roughness: 0.8, metalness: 0 }); n.name = m.name; return n; };
  model.traverse(o => { if (o.isMesh) o.material = toStd([].concat(o.material)[0]); });
  s.rig.poseAll();
  const res = {}, info = {};
  const skinned = []; model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  info.meshes = skinned.map(m => { const w = m.geometry.attributes.skinWeight; let maxErr = 0, zeros = 0; for (let i = 0; i < w.count; i++) { const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i); maxErr = Math.max(maxErr, Math.abs(sum - 1)); } return { name: m.name, verts: w.count, maxWeightSumErr: maxErr, bones: m.skeleton.bones.length, scale: m.scale.toArray(), parentScale: m.parent.scale.toArray() }; });
  info.modelScale = model.scale.toArray(); info.hipsParentScale = s.rig.bones[0].parent.scale.toArray();

  // L: single skin only (Surface), nothing else
  const hide = skinned.slice(0, -1); hide.forEach(m => m.visible = false);
  res.L_xbot_one_skin = await exp(model);
  hide.forEach(m => m.visible = true);

  // M: weights renormalised exactly
  for (const m of skinned) { const w = m.geometry.attributes.skinWeight; for (let i = 0; i < w.count; i++) { const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i) || 1; w.setXYZW(i, w.getX(i) / sum, w.getY(i) / sum, w.getZ(i) / sum, w.getW(i) / sum); } }
  res.M_xbot_weights_normalised = await exp(model);

  // K: everything baked to metres (positions, geometry, inverse binds), identity scale everywhere
  const bones = s.rig.bones;
  model.updateMatrixWorld(true);
  for (const b of bones) b.position.multiplyScalar(0.01);
  for (const m of skinned) { m.geometry = m.geometry.clone(); m.geometry.scale(0.01, 0.01, 0.01); m.geometry.computeBoundingSphere(); }
  model.updateMatrixWorld(true);
  for (const m of skinned) { m.skeleton.calculateInverses(); m.bind(m.skeleton, m.matrixWorld); }
  const clip2 = clip.clone(); for (const t of clip2.tracks) if (t.name.endsWith('.position')) for (let i = 0; i < t.values.length; i++) t.values[i] *= 0.01;
  res.K_xbot_metres_with_anim = await exp(model, [clip2]);
  return { res, info };
});
console.log(JSON.stringify(out.info));
fs.mkdirSync('tests/out/preview-bisect', { recursive: true });
for (const [k, v] of Object.entries(out.res)) { fs.writeFileSync(`tests/out/preview-bisect/${k}.glb`, Buffer.from(v, 'base64')); console.log(k, Math.round(v.length * 0.75 / 1024), 'KB'); }
await b.close(); srv.close();
