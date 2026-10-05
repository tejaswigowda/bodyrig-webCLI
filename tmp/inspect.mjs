import { chromium } from 'playwright';
import { createServer } from '../server.js';
const srv = createServer('docs', {'/fixtures/': 'tests/fixtures'});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
await p.goto(`http://127.0.0.1:${srv.address().port}/index.html?nosw`);
await p.waitForFunction('window.rigWebCLI?.ready');
await p.evaluate(() => window.rigWebCLI.bakeUrls('/fixtures/xbot.fbx', '/fixtures/mocap-33s.bvh', 'bake --trim 0:2 --fps 15 --no-optimize'));
console.log(JSON.stringify(await p.evaluate(() => {
  const s = window.rigWebCLI.state, out = [];
  s.model.traverse(o => { if (!o.isSkinnedMesh) return;
    const g = o.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const used = new Set(); let nan = 0, maxJ = 0, zeroW = 0, over4 = 0, fourth = 0;
    for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k), j = si.getComponent(i, k); if (w > 0) { used.add(j); } else zeroW++; maxJ = Math.max(maxJ, j); if (k === 3 && w > 0) fourth++; }
    for (let i = 0; i < pos.count * 3; i++) if (!Number.isFinite(pos.array[i])) nan++;
    g.computeBoundingBox();
    out.push({ name: o.name, verts: pos.count, indexed: !!g.index, bbox: [g.boundingBox.min.toArray().map(Math.round), g.boundingBox.max.toArray().map(Math.round)], jointsUsed: used.size, maxJointIndex: maxJ, nan, vertsWithFourInfluences: fourth, bindIsMeshWorld: o.bindMatrix.equals(o.matrixWorld), bindMode: o.bindMode, meshWorld: o.matrixWorld.elements.slice(0, 16).map(x => +x.toFixed(3)), skeletonBones: o.skeleton.bones.length, firstBone: o.skeleton.bones[0].name, attrs: Object.keys(g.attributes), siType: si.array.constructor.name, groups: g.groups.length, mats: [].concat(o.material).map(m => m.name) });
  });
  return out;
}), null, 1));
await b.close(); srv.close();
