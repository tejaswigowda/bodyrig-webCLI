// optimize-worker.js -- runs glTF-Transform + meshopt off the main thread so large characters don't freeze the UI.
import { optimizeGLB } from '../vendor/gltf-optimize.js';

self.onmessage = async ({ data: { glb, level } }) => {
  try {
    const out = await optimizeGLB(glb, { level });
    self.postMessage({ ok: true, glb: out }, [out]);
  } catch (e) {
    self.postMessage({ ok: false, error: String(e?.message || e) });
  }
};
