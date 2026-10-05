// Builds a Blender-style rig inside the page: Z-up armature node rotated -90 deg about X, A-pose arms, and every bone's local Y
// aimed along its own limb (non-identity rest rotations). This is the case the naive local-quaternion copy gets 100+ degrees wrong.
// Serialised by Playwright, so it must not reference anything outside its own body.
export async function buildSyntheticRig() {
  const THREE = await import('three');
  const s2 = Math.SQRT1_2;
  // name, parent, position in armature space (Z up, character faces -Y), aim-at child
  const J = [
    ['pelvis', null, [0, 0, 1.0], 'spine_01'], ['spine_01', 'pelvis', [0, 0, 1.1], 'spine_02'], ['spine_02', 'spine_01', [0, 0, 1.25], 'spine_03'],
    ['spine_03', 'spine_02', [0, 0, 1.4], 'neck_01'], ['neck_01', 'spine_03', [0, 0, 1.6], 'head'], ['head', 'neck_01', [0, 0, 1.7], null],
    ['clavicle_l', 'spine_03', [0.05, 0, 1.52], 'upperarm_l'], ['upperarm_l', 'clavicle_l', [0.17, 0, 1.52], 'lowerarm_l'],
    ['lowerarm_l', 'upperarm_l', [0.17 + 0.28 * s2, 0, 1.52 - 0.28 * s2], 'hand_l'], ['hand_l', 'lowerarm_l', [0.17 + 0.53 * s2, 0, 1.52 - 0.53 * s2], null],
    ['clavicle_r', 'spine_03', [-0.05, 0, 1.52], 'upperarm_r'], ['upperarm_r', 'clavicle_r', [-0.17, 0, 1.52], 'lowerarm_r'],
    ['lowerarm_r', 'upperarm_r', [-0.17 - 0.28 * s2, 0, 1.52 - 0.28 * s2], 'hand_r'], ['hand_r', 'lowerarm_r', [-0.17 - 0.53 * s2, 0, 1.52 - 0.53 * s2], null],
    ['thigh_l', 'pelvis', [0.09, 0, 0.95], 'calf_l'], ['calf_l', 'thigh_l', [0.09, 0, 0.52], 'foot_l'], ['foot_l', 'calf_l', [0.09, 0, 0.1], 'ball_l'], ['ball_l', 'foot_l', [0.09, -0.12, 0.04], null],
    ['thigh_r', 'pelvis', [-0.09, 0, 0.95], 'calf_r'], ['calf_r', 'thigh_r', [-0.09, 0, 0.52], 'foot_r'], ['foot_r', 'calf_r', [-0.09, 0, 0.1], 'ball_r'], ['ball_r', 'foot_r', [-0.09, -0.12, 0.04], null],
  ];
  const pos = new Map(J.map(([n, , p]) => [n, new THREE.Vector3(...p)]));
  const worldQ = new Map();
  for (const [n, parent, , aim] of J) {
    const d = aim ? pos.get(aim).clone().sub(pos.get(n)).normalize() : null;
    worldQ.set(n, d ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d) : worldQ.get(parent).clone());
  }
  const bones = new Map();
  for (const [n, parent] of J) {
    const b = new THREE.Bone(); b.name = n;
    if (parent) {
      const pq = worldQ.get(parent);
      b.position.copy(pos.get(n).clone().sub(pos.get(parent)).applyQuaternion(pq.clone().invert()));
      b.quaternion.copy(pq.clone().invert().multiply(worldQ.get(n)));
      bones.get(parent).add(b);
    } else { b.position.copy(pos.get(n)); b.quaternion.copy(worldQ.get(n)); }
    bones.set(n, b);
  }
  const armature = new THREE.Group(); armature.name = 'Armature'; armature.rotation.x = -Math.PI / 2;
  armature.add(bones.get('pelvis'));
  // one small triangle per bone, rigidly weighted to it
  const names = [...bones.keys()], P = [], SI = [], SW = [];
  names.forEach((n, i) => {
    const c = pos.get(n);
    for (const o of [[0.03, 0, 0], [-0.03, 0, 0], [0, 0, 0.03]]) { P.push(c.x + o[0], c.y + o[1], c.z + o[2]); SI.push(i, 0, 0, 0); SW.push(1, 0, 0, 0); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
  g.setIndex([...names.keys()].flatMap(i => [i * 3, i * 3 + 1, i * 3 + 2]));
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ color: 0x88aaff }));
  mesh.name = 'Body'; mesh.rotation.x = -Math.PI / 2; // same Z-up -> Y-up node rotation as the armature, as Blender exports it
  const root = new THREE.Group(); root.add(armature, mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(names.map(n => bones.get(n))), mesh.matrixWorld);
  return root;
}
