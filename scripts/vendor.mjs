// Copies + minifies three.js and builds the in-browser optimizer bundle into docs/vendor so the app is fully offline-capable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'vendor');
const three = path.join(root, 'node_modules', 'three');

const files = [
  ['build/three.core.js', 'three/three.core.js'],
  ['build/three.module.js', 'three/three.module.js'],
  ...['loaders/FBXLoader.js', 'loaders/GLTFLoader.js', 'loaders/DRACOLoader.js', 'loaders/BVHLoader.js', 'exporters/GLTFExporter.js', 'controls/OrbitControls.js',
    'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js', 'curves/NURBSCurve.js', 'curves/NURBSUtils.js', 'libs/fflate.module.js', 'libs/meshopt_decoder.module.js',
  ].map(f => [`examples/jsm/${f}`, `three/addons/${f}`]),
];

fs.rmSync(out, { recursive: true, force: true });
for (const [src, dst] of files) {
  const { code } = await transform(fs.readFileSync(path.join(three, src), 'utf8'), { minify: true, format: 'esm', legalComments: 'none' });
  const target = path.join(out, dst);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, code);
}
fs.copyFileSync(path.join(three, 'LICENSE'), path.join(out, 'three', 'LICENSE'));

// The Draco decoder (wasm + glue) is copied as-is: DRACOLoader fetches these same-origin at runtime.
const dracoOut = path.join(out, 'three/addons/libs/draco/gltf');
fs.mkdirSync(dracoOut, { recursive: true });
for (const f of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']) fs.copyFileSync(path.join(three, 'examples/jsm/libs/draco/gltf', f), path.join(dracoOut, f));

await build({
  entryPoints: [path.join(root, 'scripts', 'optimizer-entry.mjs')],
  outfile: path.join(out, 'gltf-optimize.js'),
  bundle: true, minify: true, format: 'esm', platform: 'browser', legalComments: 'none', logLevel: 'warning',
  external: ['node:fs', 'node:path'], // dynamic imports in glTF-Transform's Node-only I/O path, never reached in the browser
});

const kb = f => Math.round(fs.statSync(f).size / 1024);
console.log(`vendor ready: three.module ${kb(path.join(out, 'three/three.module.js'))} KB, three.core ${kb(path.join(out, 'three/three.core.js'))} KB, optimizer ${kb(path.join(out, 'gltf-optimize.js'))} KB`);
