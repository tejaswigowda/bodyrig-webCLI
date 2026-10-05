// pipeline.js -- stages 2-7 end to end, shared by the GUI, the command box and the Playwright harness.
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { bakeMocap } from './mocap-bake.mjs';

export function downscaleTextures(model, max) {
  const seen = new Set(); let n = 0;
  model.traverse(o => {
    for (const m of [].concat(o.material || [])) for (const k in m) {
      const tex = m[k];
      if (!tex?.isTexture || seen.has(tex)) continue;
      seen.add(tex);
      const img = tex.image, w = img?.width, h = img?.height;
      if (!w || !h || Math.max(w, h) <= max) continue;
      const s = max / Math.max(w, h);
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      tex.image = c; tex.needsUpdate = true; n++;
    }
  });
  return n;
}

async function optimizeOffThread(glb, level) {
  try {
    const worker = new Worker(new URL('./optimize-worker.js', import.meta.url), { type: 'module' });
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => { worker.terminate(); data.ok ? resolve(data.glb) : reject(new Error(data.error)); };
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'optimizer worker failed')); };
      worker.postMessage({ glb: glb.slice(0), level }, []);
    });
  } catch {
    const { optimizeGLB } = await import('../vendor/gltf-optimize.js'); // module workers unavailable: fall back to the main thread
    return optimizeGLB(glb, { level });
  }
}

export async function exportGLB(model, clip, { optimize = true, level = 'medium', maxTex = 0 } = {}) {
  const stages = [];
  let t = performance.now();
  const downscaled = maxTex ? downscaleTextures(model, maxTex) : 0;
  const raw = await new GLTFExporter().parseAsync(model, { binary: true, animations: [clip], onlyVisible: false });
  stages.push({ n: 7, name: 'export GLB', ms: Math.round(performance.now() - t), info: { kb: Math.round(raw.byteLength / 1024), downscaledTextures: downscaled } });
  if (!optimize) return { glb: raw, raw, rawBytes: raw.byteLength, stages };
  t = performance.now();
  const glb = await optimizeOffThread(raw, level);
  stages.push({ n: 7, name: 'optimize (meshopt)', ms: Math.round(performance.now() - t), info: { kb: Math.round(glb.byteLength / 1024), level } });
  return { glb, raw, rawBytes: raw.byteLength, stages };
}

// map: canonical-name -> BVH bone name overrides (from the mapping panel or --map file).
export async function runBake({ model, bvh, opts = {}, map = {} }) {
  const { clip, report } = bakeMocap(model, bvh, { fps: opts.fps, trim: opts.trim, inPlace: opts.inPlace, loop: opts.loop, align: opts.align, map });
  const exp = await exportGLB(model, clip, opts);
  report.stages.push(...exp.stages);
  return { clip, glb: exp.glb, raw: exp.raw, report, rawBytes: exp.rawBytes };
}

export function bytesToBase64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
