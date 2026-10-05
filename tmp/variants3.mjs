import { NodeIO } from '@gltf-transform/core';
const src = '/Users/tejaswigowda/Downloads/xbot_mocap-33s_universal(1).glb';
const out = '/Users/tejaswigowda/Downloads/rig-variants';
const io = new NodeIO();
const load = async () => { const d = await io.read(src); for (const n of d.getRoot().listNodes()) n.setExtras({}); for (const a of d.getRoot().listAnimations()) a.dispose(); return d; };

function truncate(d, tris) {
  for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) for (const s of p.listSemantics()) {
    const a = p.getAttribute(s); const n = tris * 3, sz = a.getElementSize();
    const arr = a.getArray().slice(0, n * sz); a.setArray(arr);
  }
}

const dropJoint = name => /Thumb|Index|Middle|Ring|Pinky|_End|ToeBase$/.test(name);
function reduceJoints(d) {
  for (const node of d.getRoot().listNodes()) {
    const skin = node.getSkin(); if (!skin || skin.__done) continue;
    const joints = skin.listJoints();
    const keepIdx = joints.map((j, i) => dropJoint(j.getName()) ? -1 : i);
    const kept = joints.filter((j, i) => keepIdx[i] >= 0);
    const newIndex = new Map(kept.map((j, i) => [j, i]));
    const remap = joints.map(j => { let c = j; while (c && !newIndex.has(c)) c = c.getParentNode(); return newIndex.get(c) ?? 0; });
    const ibm = skin.getInverseBindMatrices(); const old = ibm.getArray();
    const nibm = new Float32Array(kept.length * 16);
    joints.forEach((j, i) => { if (keepIdx[i] >= 0) nibm.set(old.subarray(i * 16, i * 16 + 16), newIndex.get(j) * 16); });
    const prim = node.getMesh().listPrimitives()[0];
    const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
    const ja = J.getArray(), wa = W.getArray();
    for (let v = 0; v < J.getCount(); v++) {
      const acc = new Map();
      for (let k = 0; k < 4; k++) { const w = wa[v * 4 + k]; if (w <= 0) continue; const ni = remap[ja[v * 4 + k]]; acc.set(ni, (acc.get(ni) || 0) + w); }
      const e = [...acc.entries()]; let sum = 0; for (const [, w] of e) sum += w;
      for (let k = 0; k < 4; k++) { ja[v * 4 + k] = e[k] ? e[k][0] : 0; wa[v * 4 + k] = e[k] ? e[k][1] / (sum || 1) : 0; }
    }
    J.setArray(ja); W.setArray(wa);
    ibm.setArray(nibm);
    for (const j of joints) skin.removeJoint(j);
    for (const j of kept) skin.addJoint(j);
    skin.__done = true;
  }
  // drop the removed joint nodes, they hold no weights any more
}

{ const d = await load(); truncate(d, 3000); await io.write(`${out}/V1_small_mesh_52joints.glb`, d); }
{ const d = await load(); reduceJoints(d); await io.write(`${out}/V2_full_mesh_few_joints.glb`, d); }
{ const d = await load(); truncate(d, 3000); reduceJoints(d); await io.write(`${out}/V3_small_mesh_few_joints.glb`, d); }
console.log('done');
