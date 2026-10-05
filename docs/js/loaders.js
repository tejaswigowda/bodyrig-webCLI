// loaders.js -- stage 1: load a skinned model by extension (FBX / GLB / glTF / VRM / Mesquite rig.json) or a BVH.
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { parseBVH } from './mocap-bake.mjs';

export const MODEL_EXT = /\.(fbx|glb|gltf|vrm|json)$/i;
export const MOTION_EXT = /\.bvh$/i;

export function classify(name) {
  if (MOTION_EXT.test(name)) return 'motion';
  if (/\.json$/i.test(name)) return 'json'; // either a Mesquite rig.json or a saved bone map -- sniffed by content
  if (MODEL_EXT.test(name)) return 'model';
  return null;
}

// A bone map is a flat { canonicalName: bvhBoneName } object; keys starting with "_" are comments.
export function isMapJSON(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.scene || obj.object || obj.metadata) return false;
  const entries = Object.entries(obj).filter(([k]) => !k.startsWith('_'));
  return entries.length > 0 && entries.every(([, v]) => typeof v === 'string');
}

export const cleanMap = obj => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));

// Textures that never decode (FBX often references external paths) are dropped instead of failing the export.
function dropUnresolvedTextures(model) {
  const dropped = [];
  model.traverse(o => {
    for (const m of [].concat(o.material || [])) for (const k in m) {
      const tex = m[k];
      if (tex?.isTexture && !(tex.image && (tex.image.width || tex.image.data))) { dropped.push(`${m.name}.${k}`); m[k] = null; m.needsUpdate = true; }
    }
  });
  return dropped;
}

export async function loadModel(buf, name) {
  const t0 = performance.now();
  let settle; const done = new Promise(r => { settle = r; });
  const manager = new THREE.LoadingManager(() => settle());
  manager.itemStart('guard'); setTimeout(() => manager.itemEnd('guard'), 0);
  let model;
  if (/\.fbx$/i.test(name)) model = new FBXLoader(manager).parse(buf, '');
  else if (/\.json$/i.test(name)) {
    const json = JSON.parse(new TextDecoder().decode(buf));
    model = await new THREE.ObjectLoader().parseAsync(json.scene ?? json);
  } else model = (await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, '')).scene;
  await Promise.race([done, new Promise(r => setTimeout(r, 20000))]);
  const dropped = dropUnresolvedTextures(model);
  return { model, dropped, ms: Math.round(performance.now() - t0) };
}

export function loadMotion(text) {
  const t0 = performance.now();
  const bvh = parseBVH(text);
  return { bvh, ms: Math.round(performance.now() - t0) };
}
