// Offline-first: precache the app shell and every vendored dependency; everything is same-origin, so nothing third-party is ever cached or fetched.
const CACHE = 'rig-webcli-v4';
const SHELL = [
  './', './index.html', './style.css', './manifest.json', './icon.svg',
  './js/app.js', './js/viewer.js', './js/loaders.js', './js/pipeline.js', './js/command.js', './js/mocap-bake.mjs',
  './js/live.js', './js/advice.js', './js/ai.js', './js/optimize-worker.js', './js/usdz.js',
  './vendor/gltf-optimize.js',
  './vendor/three/three.core.js', './vendor/three/three.module.js',
  './vendor/three/addons/loaders/FBXLoader.js', './vendor/three/addons/loaders/GLTFLoader.js', './vendor/three/addons/loaders/BVHLoader.js',
  './vendor/three/addons/exporters/GLTFExporter.js', './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/utils/BufferGeometryUtils.js', './vendor/three/addons/utils/SkeletonUtils.js',
  './vendor/three/addons/curves/NURBSCurve.js', './vendor/three/addons/curves/NURBSUtils.js',
  './vendor/three/addons/libs/fflate.module.js', './vendor/three/addons/libs/meshopt_decoder.module.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
    if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  })));
});
