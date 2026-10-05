// usdz.js -- skinned, animated USDZ (UsdSkel) for macOS Preview / Quick Look, which cannot open GLB.
// Samples the baked clip per frame from the live model, so it works for any clip the engine produces.
import * as THREE from 'three';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';

const num = x => { const s = String(+x.toPrecision(7)); return s === '-0' ? '0' : s; };
const vec = (a, i, n) => `(${Array.from({ length: n }, (_, k) => num(a[i + k])).join(', ')})`;
// USD matrices are row-major with translation in the last row, which is three's column-major element order.
const mat = m => `( ${[0, 1, 2, 3].map(r => `(${[0, 1, 2, 3].map(c => num(m.elements[r * 4 + c])).join(', ')})`).join(', ')} )`;
const ident = s => { const t = s.replace(/[^A-Za-z0-9_]/g, '_'); return /^[0-9]/.test(t) || !t ? `n_${t}` : t; };

async function textureBytes(tex) {
  const img = tex.image, w = img.width, h = img.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function alignedZip(files) { // USDZ requires stored entries starting on 64-byte boundaries
  let offset = 0;
  for (const name in files) {
    const f = files[name]; offset += 34 + name.length;
    const mod = offset & 63;
    if (mod !== 4) files[name] = [f, { extra: { 12345: new Uint8Array(64 - mod) } }];
    offset = f.length;
  }
  return zipSync(files, { level: 0, mtime: new Date() });
}

export async function exportUSDZ(model, clip, { rig, fps = 30 } = {}) {
  rig.poseAll();
  const bones = [...rig.bones].sort((a, b) => depthOf(a) - depthOf(b));
  function depthOf(b) { let d = 0; for (let p = b.parent; p?.isBone; p = p.parent) d++; return d; }
  const index = new Map(bones.map((b, i) => [b, i]));
  const root = bones.find(b => !b.parent?.isBone), S = root.parent ? root.parent.matrixWorld.clone() : new THREE.Matrix4(), Sinv = S.clone().invert();

  const paths = new Map(); // joint path = parent path + sanitized, sibling-unique name
  const used = new Map();
  for (const b of bones) {
    const parent = b.parent?.isBone && index.has(b.parent) ? paths.get(b.parent) : '';
    let name = ident(b.name); const key = `${parent}/${name}`;
    const n = used.get(key) ?? 0; used.set(key, n + 1); if (n) name += `_${n}`;
    paths.set(b, parent ? `${parent}/${name}` : name);
  }
  const jointTokens = `[${bones.map(b => `"${paths.get(b)}"`).join(', ')}]`;
  const bind = bones.map(b => mat(new THREE.Matrix4().multiplyMatrices(Sinv, b.matrixWorld)));
  const rest = bones.map(b => mat(b.matrix));

  // sample the animation by driving the model itself
  const mixer = new THREE.AnimationMixer(model); mixer.clipAction(clip).play();
  const frames = Math.round(clip.duration * fps) + 1, rot = [], trn = [];
  for (let f = 0; f < frames; f++) {
    mixer.setTime(Math.min(f / fps, clip.duration));
    rot.push(`${f}: [${bones.map(b => `(${num(b.quaternion.w)}, ${num(b.quaternion.x)}, ${num(b.quaternion.y)}, ${num(b.quaternion.z)})`).join(', ')}],`);
    trn.push(`${f}: [${bones.map(b => vec(b.position.toArray(), 0, 3)).join(', ')}],`);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(model); rig.poseAll();
  const scales = `[${bones.map(b => vec(b.scale.toArray(), 0, 3)).join(', ')}]`;

  const files = {}, texIds = new Map(), materialDefs = new Map();
  const skipped = [];
  const matPath = m => {
    if (materialDefs.has(m)) return materialDefs.get(m).path;
    const id = materialDefs.size, path = `/Root/Materials/M${id}`;
    materialDefs.set(m, { path, id, tex: m.map?.image ? m.map : null, flipY: m.map?.flipY });
    return path;
  };

  const meshes = [];
  model.traverse(o => { if (o.isSkinnedMesh && o.visible) meshes.push(o); else if (o.isMesh && o.visible) skipped.push(o.name || 'mesh'); });
  let meshUsd = '';
  meshes.forEach((sm, mi) => {
    const g = sm.geometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const idx = g.index ? g.index.array : null, count = idx ? idx.length : pos.count;
    const remap = sm.skeleton.bones.map(b => index.get(b));
    const mats = [].concat(sm.material);
    const flip = mats[0]?.map?.flipY ?? true;
    const pts = [], nrm = [], st = [], ji = [], jw = [];
    for (let v = 0; v < pos.count; v++) {
      pts.push(`(${num(pos.getX(v))}, ${num(pos.getY(v))}, ${num(pos.getZ(v))})`);
      if (nor) nrm.push(`(${num(nor.getX(v))}, ${num(nor.getY(v))}, ${num(nor.getZ(v))})`);
      if (uv) st.push(`(${num(uv.getX(v))}, ${num(flip ? uv.getY(v) : 1 - uv.getY(v))})`);
      for (let k = 0; k < 4; k++) { ji.push(remap[si.getComponent(v, k)] ?? 0); jw.push(num(sw.getComponent(v, k))); }
    }
    const tris = []; for (let i = 0; i < count; i++) tris.push(idx ? idx[i] : i);
    const geomBind = mat(new THREE.Matrix4().multiplyMatrices(Sinv, sm.bindMatrix));
    const groups = mats.length > 1 && g.groups.length ? g.groups : null;
    const single = matPath(mats[0]);
    let subsets = '';
    if (groups) groups.forEach((gr, gi) => {
      const m = mats[gr.materialIndex]; if (!m) return;
      const faces = []; for (let f = gr.start / 3; f < (gr.start + gr.count) / 3; f++) faces.push(f);
      subsets += `
            def GeomSubset "Sub${gi}" (prepend apiSchemas = ["MaterialBindingAPI"])
            {
                uniform token elementType = "face"
                uniform token familyName = "materialBind"
                int[] indices = [${faces.join(', ')}]
                rel material:binding = <${matPath(m)}>
            }`;
    });
    meshUsd += `
        def Mesh "Mesh${mi}" (prepend apiSchemas = ["SkelBindingAPI", "MaterialBindingAPI"])
        {
            int[] faceVertexCounts = [${new Array(count / 3).fill(3).join(', ')}]
            int[] faceVertexIndices = [${tris.join(', ')}]
            point3f[] points = [${pts.join(', ')}]
            ${nor ? `normal3f[] normals = [${nrm.join(', ')}] (interpolation = "vertex")` : ''}
            ${uv ? `texCoord2f[] primvars:st = [${st.join(', ')}] (interpolation = "vertex")` : ''}
            matrix4d primvars:skel:geomBindTransform = ${geomBind}
            int[] primvars:skel:jointIndices = [${ji.join(', ')}] (
                elementSize = 4
                interpolation = "vertex"
            )
            float[] primvars:skel:jointWeights = [${jw.join(', ')}] (
                elementSize = 4
                interpolation = "vertex"
            )
            rel skel:skeleton = </Root/Skel>
            uniform token subdivisionScheme = "none"
            uniform bool doubleSided = true
            rel material:binding = <${single}>${subsets}
        }`;
  });

  let matUsd = '';
  for (const [m, d] of materialDefs) {
    let texSrc = '', color = `(${num(m.color?.r ?? 1)}, ${num(m.color?.g ?? 1)}, ${num(m.color?.b ?? 1)})`;
    if (d.tex) {
      if (!texIds.has(d.tex)) { const id = texIds.size; texIds.set(d.tex, id); files[`textures/Texture_${id}.png`] = await textureBytes(d.tex); }
      const file = `textures/Texture_${texIds.get(d.tex)}.png`;
      texSrc = `
            def Shader "stReader"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                token inputs:varname = "st"
                float2 outputs:result
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @${file}@
                float2 inputs:st.connect = <${d.path}/stReader.outputs:result>
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                token inputs:sourceColorSpace = "sRGB"
                float3 outputs:rgb
            }`;
      color = `<${d.path}/Tex.outputs:rgb>`;
    }
    const opacity = m.transparent && m.opacity < 1 ? m.opacity : 1;
    matUsd += `
        def Material "M${d.id}"
        {
            token outputs:surface.connect = <${d.path}/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                ${d.tex ? `color3f inputs:diffuseColor.connect = ${color}` : `color3f inputs:diffuseColor = ${color}`}
                float inputs:roughness = 0.8
                float inputs:metallic = 0
                float inputs:opacity = ${num(opacity)}
                token outputs:surface
            }${texSrc}
        }`;
  }

  const box = new THREE.Box3(); bones.forEach(b => box.expandByPoint(b.getWorldPosition(new THREE.Vector3())));
  const height = box.max.y - box.min.y, metersPerUnit = height > 10 ? 0.01 : 1; // FBX characters are usually in centimetres

  const usda = `#usda 1.0
(
    customLayerData = { string creator = "rig webCLI" }
    defaultPrim = "Root"
    metersPerUnit = ${metersPerUnit}
    upAxis = "Y"
    startTimeCode = 0
    endTimeCode = ${frames - 1}
    timeCodesPerSecond = ${fps}
    framesPerSecond = ${fps}
)

def SkelRoot "Root"
{
    def Skeleton "Skel" (prepend apiSchemas = ["SkelBindingAPI"])
    {
        matrix4d xformOp:transform = ${mat(S)}
        uniform token[] xformOpOrder = ["xformOp:transform"]
        uniform token[] joints = ${jointTokens}
        uniform matrix4d[] bindTransforms = [${bind.join(', ')}]
        uniform matrix4d[] restTransforms = [${rest.join(', ')}]
        rel skel:animationSource = </Root/Skel/Anim>

        def SkelAnimation "Anim"
        {
            uniform token[] joints = ${jointTokens}
            quatf[] rotations.timeSamples = {
${rot.join('\n')}
            }
            float3[] translations.timeSamples = {
${trn.join('\n')}
            }
            float3[] scales = ${scales}
        }
    }
${meshUsd}
    def Scope "Materials"
    {${matUsd}
    }
}
`;
  files['model.usda'] = strToU8(usda);
  // model.usda must be the first entry
  const ordered = { 'model.usda': files['model.usda'] };
  for (const k in files) if (k !== 'model.usda') ordered[k] = files[k];
  return { usdz: alignedZip(ordered), skippedMeshes: skipped, joints: bones.length, frames, meshes: meshes.length };
}
