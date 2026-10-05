// viewer.js -- three.js preview: orbit camera framed from the model's own bounds, AnimationMixer driven by the scrubber.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createViewer(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0d0f1a);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  const controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(3, 6, 4); scene.add(sun);
  const grid = new THREE.GridHelper(1, 20, 0x3a4060, 0x252a42); scene.add(grid);

  let model = null, mixer = null, action = null, clip = null, follow = null, followSeen = false, playing = false, time = 0, speed = 1;
  const followLast = new THREE.Vector3(), listeners = new Set();
  let last = performance.now();

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host); resize();

  // Frame from the scene's own bounds -- never a fixed magic-number pose.
  function frame() {
    if (!model) return;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model); if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.length() / 2, 1e-3);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.25;
    camera.near = r / 100; camera.far = r * 200; camera.updateProjectionMatrix();
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(dist));
    controls.update();
    grid.scale.setScalar(r * 6); grid.position.set(center.x, box.min.y, center.z);
  }

  function setModel(m) {
    if (model) scene.remove(model);
    model = m; mixer = action = clip = follow = null; time = 0; playing = false;
    scene.add(model); frame();
  }

  function setClip(c, hipBone) {
    clip = c;
    if (!mixer) mixer = new THREE.AnimationMixer(model);
    mixer.stopAllAction(); mixer.uncacheRoot(model);
    action = mixer.clipAction(clip); action.play();
    follow = hipBone ?? null; followSeen = false; time = 0; frame(); seek(0);
  }

  function seek(t) {
    time = Math.min(Math.max(t, 0), clip?.duration ?? 0);
    if (!mixer) return;
    mixer.setTime(time); model.updateMatrixWorld(true);
    if (follow) {
      const p = follow.getWorldPosition(new THREE.Vector3()); p.y = controls.target.y;
      if (followSeen) { const d = p.clone().sub(followLast); camera.position.add(d); controls.target.add(d); }
      followLast.copy(p); followSeen = true;
    }
    listeners.forEach(f => f(time));
  }

  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    if (playing && clip) {
      let t = time + dt * speed;
      if (t >= clip.duration) t = 0;
      seek(t);
    }
    controls.update(); renderer.render(scene, camera);
  }
  tick();

  return {
    setModel, setClip, seek, frame, canvas: renderer.domElement,
    play() { playing = !!clip; last = performance.now(); }, pause() { playing = false; },
    get playing() { return playing; }, get time() { return time; }, get duration() { return clip?.duration ?? 0; },
    setSpeed(s) { speed = s; },
    onTime(f) { listeners.add(f); },
  };
}
