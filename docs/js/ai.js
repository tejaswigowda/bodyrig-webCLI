// ai.js -- OPTIONAL local-model assist. Follows Strata's host-first split: the model only sees the fuzzy residue
// (bones the synonym table missed, plain-English options) and the host validates every answer geometrically before use.
// Nothing here is imported by the core path; the model is loaded only by an explicit "Load model" action.
import * as THREE from 'three';
import { CORE_BONES, canonical } from './mocap-bake.mjs';
import { DEFAULTS, formatCommand, parseCommand } from './command.js';

const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm';
export const MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
export const supported = () => typeof navigator !== 'undefined' && !!navigator.gpu;

// ---------- host-side geometric validation (pure, no model) ----------

const CHAINS = {
  spine: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'],
  leftArm: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'],
  rightArm: ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'],
  leftLeg: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'],
  rightLeg: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'],
};
const chainOf = label => Object.values(CHAINS).find(c => c.includes(label));
const sideOf = label => (label.startsWith('Left') ? 1 : label.startsWith('Right') ? -1 : 0);
const wp = o => o.getWorldPosition(new THREE.Vector3());

function rigFrame(bones, known) {
  const find = l => bones.find(b => known[b.name] === l);
  const hips = find('Hips') ?? bones.find(b => !b.parent?.isBone);
  const ys = bones.map(b => wp(b).y);
  const height = Math.max(1e-6, Math.max(...ys) - Math.min(...ys));
  // "left" is learned from already-mapped pairs, falling back to the glTF convention (+X).
  const pairs = [['LeftUpLeg', 'RightUpLeg'], ['LeftArm', 'RightArm'], ['LeftShoulder', 'RightShoulder'], ['LeftFoot', 'RightFoot']];
  const left = new THREE.Vector3();
  for (const [l, r] of pairs) { const a = find(l), b = find(r); if (a && b) left.add(wp(a).sub(wp(b))); }
  left.y = 0;
  if (left.lengthSq() < 1e-12) left.set(1, 0, 0); else left.normalize();
  return { hips, hipPos: hips ? wp(hips) : new THREE.Vector3(), height, left };
}

const segLength = b => {
  const c = b.children.find(k => k.isBone);
  return c ? wp(b).distanceTo(wp(c)) : (b.parent?.isBone ? wp(b).distanceTo(wp(b.parent)) : 0);
};

// known: { targetBoneName: canonicalLabel } for bones already mapped by the synonym table. labels: { boneName: proposedLabel }.
export function validateLabels(bones, known, labels) {
  const frame = rigFrame(bones, known);
  const byName = new Map(bones.map(b => [b.name, b]));
  const claimed = new Set(Object.values(known));
  const accepted = {}, rejected = [];
  const labelOf = b => known[b.name] ?? accepted[b.name];
  const reject = (bone, label, reason) => rejected.push({ bone, label, reason });

  const limbLen = group => {
    const ls = bones.filter(b => known[b.name] && group.test(known[b.name])).map(segLength).filter(x => x > 0).sort((a, b) => a - b);
    return ls.length ? ls[Math.floor(ls.length / 2)] : 0;
  };
  const armMedian = limbLen(/Arm|Hand/), legMedian = limbLen(/Leg|Foot/);

  for (const [name, label] of Object.entries(labels)) {
    const b = byName.get(name);
    if (!b) { reject(name, label, 'no such bone'); continue; }
    if (label === 'None') continue;
    if (!CORE_BONES.includes(label)) { reject(name, label, 'not a canonical bone name'); continue; }
    if (claimed.has(label)) { reject(name, label, 'label already used by another bone'); continue; }

    const rel = wp(b).sub(frame.hipPos), lateral = rel.dot(frame.left) / frame.height, up = rel.y / frame.height;
    const s = sideOf(label);
    if (s !== 0 && lateral * s < 0.02) { reject(name, label, `bone is not on the ${s > 0 ? 'left' : 'right'} side`); continue; }
    if (s === 0 && Math.abs(lateral) > 0.12) { reject(name, label, 'a center bone must lie near the body midline'); continue; }
    if (/Leg|Foot|Toe/.test(label) && up > 0.05) { reject(name, label, 'a leg bone must be at or below the hips'); continue; }
    if (/Arm|Hand|Shoulder|Spine|Neck|Head/.test(label) && up < -0.02) { reject(name, label, 'an upper-body bone must be above the hips'); continue; }

    const chain = chainOf(label), rank = chain?.indexOf(label);
    let bad = null;
    for (let p = b.parent; p?.isBone && !bad; p = p.parent) {
      const pl = labelOf(p); if (pl && chain.includes(pl) && chain.indexOf(pl) >= rank) bad = `ancestor ${p.name} (${pl}) should come before ${label}`;
    }
    if (!bad) b.traverse(d => {
      if (d === b || bad || !d.isBone) return;
      const dl = labelOf(d); if (dl && chain.includes(dl) && chain.indexOf(dl) <= rank) bad = `descendant ${d.name} (${dl}) should come after ${label}`;
    });
    if (bad) { reject(name, label, `chain order: ${bad}`); continue; }

    const med = /Arm|Hand/.test(label) ? armMedian : /Leg|Foot/.test(label) ? legMedian : 0, len = segLength(b);
    if (med && len > 0 && (len / med < 0.2 || len / med > 5)) { reject(name, label, 'segment length is implausible for this limb'); continue; }

    accepted[name] = label; claimed.add(label);
  }
  return { accepted, rejected };
}

// Context the model sees for each unmapped bone: name, ancestry, and coarse position. Never the geometry itself.
export function describeBones(bones, known, names) {
  const frame = rigFrame(bones, known), byName = new Map(bones.map(b => [b.name, b]));
  return names.map(name => {
    const b = byName.get(name), rel = wp(b).sub(frame.hipPos);
    const lateral = rel.dot(frame.left) / frame.height;
    const path = []; for (let p = b.parent; p?.isBone; p = p.parent) path.unshift(known[p.name] ?? p.name);
    return {
      bone: name, parents: path.slice(-3).join(' > ') || '(root)',
      side: Math.abs(lateral) < 0.04 ? 'center' : lateral > 0 ? 'left' : 'right',
      height: +(rel.y / frame.height).toFixed(2), children: b.children.filter(c => c.isBone).length,
    };
  });
}

// ---------- model access (only reached after the user clicks "Load model") ----------

export async function loadEngine(onProgress) {
  if (!supported()) throw new Error('WebGPU is not available in this browser.');
  const webllm = await import(/* webpackIgnore: true */ WEBLLM_URL);
  return webllm.CreateMLCEngine(MODEL_ID, { initProgressCallback: p => onProgress?.(p.progress ?? 0, p.text ?? '') });
}

async function constrained(engine, system, user, schema) {
  const res = await engine.chat.completions.create({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0, max_tokens: 700,
    response_format: { type: 'json_object', schema: JSON.stringify(schema) },
  });
  return JSON.parse(res.choices[0].message.content);
}

export async function proposeLabels(engine, described) {
  const schema = {
    type: 'object', required: ['labels'],
    properties: { labels: { type: 'array', items: { type: 'object', required: ['bone', 'label'], properties: { bone: { enum: described.map(d => d.bone) }, label: { enum: [...CORE_BONES, 'None'] } } } } },
  };
  const out = await constrained(engine,
    'You label skeleton bones of a humanoid character. Use only the allowed canonical names, or None if a bone is not a main body bone (fingers, helpers, face).',
    `Bones to label (JSON):\n${JSON.stringify(described)}`, schema);
  return Object.fromEntries((out.labels ?? []).map(l => [l.bone, l.label]));
}

export async function proposeCommand(engine, text) {
  const schema = {
    type: 'object', required: ['fps', 'trimStart', 'trimEnd', 'inPlace', 'loop'],
    properties: { fps: { type: 'integer', minimum: 1, maximum: 240 }, trimStart: { type: 'number' }, trimEnd: { type: 'number' }, inPlace: { type: 'boolean' }, loop: { type: 'boolean' } },
  };
  const j = await constrained(engine,
    'Convert the request into mocap export options. trimStart and trimEnd are seconds; use 0 for trimEnd to mean "to the end". Defaults: fps 30, no trim, inPlace false, loop false.',
    text, schema);
  const trim = j.trimStart > 0 || j.trimEnd > 0 ? [j.trimStart || 0, j.trimEnd > 0 ? j.trimEnd : null] : null;
  const line = formatCommand({ ...DEFAULTS, fps: j.fps, trim, inPlace: !!j.inPlace, loop: !!j.loop });
  parseCommand(line); // host validation: reject anything the real grammar rejects
  return line;
}
