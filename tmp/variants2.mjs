import { NodeIO } from '@gltf-transform/core';
import { weld } from '@gltf-transform/functions';
const src = '/Users/tejaswigowda/Downloads/xbot_mocap-33s_universal(1).glb';
const out = '/Users/tejaswigowda/Downloads/rig-variants';
const io = new NodeIO();
const load = async () => { const d = await io.read(src); for (const n of d.getRoot().listNodes()) n.setExtras({}); return d; };
const save = (d, name) => io.write(`${out}/${name}.glb`, d);
const dropSecond = d => { const n = d.getRoot().listNodes().find(x => x.getName() === 'Beta_Surface'); const m = n.getMesh(), s = n.getSkin(); n.dispose(); m.dispose(); s.dispose(); };
const doWeld = async d => { await d.transform(weld()); };
const toMeters = d => { const root = d.getRoot().getDefaultScene().listChildren()[0]; root.setScale([0.01, 0.01, 0.01]); };
const noSkeleton = d => { for (const s of d.getRoot().listSkins()) s.setSkeleton(null); };

{ const d = await load(); dropSecond(d); await save(d, 'D_one_skin'); }
{ const d = await load(); await doWeld(d); await save(d, 'E_indexed'); }
{ const d = await load(); toMeters(d); await save(d, 'F_meters'); }
{ const d = await load(); noSkeleton(d); await save(d, 'H_no_skeleton_field'); }
{ const d = await load(); dropSecond(d); await doWeld(d); toMeters(d); noSkeleton(d); await save(d, 'Z_all_combined'); }
console.log('done');
