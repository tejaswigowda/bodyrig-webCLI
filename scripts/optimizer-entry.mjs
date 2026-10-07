// In-browser GLB optimizer: glTF-Transform + meshopt. Bundled to docs/vendor/gltf-optimize.js.
import { WebIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, weld, prune, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

export async function optimizeGLB(glb, { level = 'medium' } = {}) {
  await MeshoptEncoder.ready; await MeshoptDecoder.ready;
  const io = new WebIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(new Uint8Array(glb));
  await doc.transform(dedup(), weld(), prune(), meshopt({ encoder: MeshoptEncoder, level }));
  const bytes = await io.writeBinary(doc);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
