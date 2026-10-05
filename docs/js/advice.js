// advice.js -- deterministic plain-language explanation of a mapping report. No model involved.
const FINGER = /(thumb|index|middle|ring|pinky|little)\d*$/i;
const FACE = /(eye|jaw|tongue|brow|lid|lip|cheek|teeth|face)/i;
const HELPER = /(ik|pole|twist|roll|corrective|helper|ctrl|control|attach|socket|end$|_end|nub)/i;

export function groupUnmapped(unmapped) {
  const g = { fingers: [], face: [], helpers: [], other: [] };
  for (const n of unmapped) {
    if (FINGER.test(n)) g.fingers.push(n);
    else if (FACE.test(n)) g.face.push(n);
    else if (HELPER.test(n)) g.helpers.push(n);
    else g.other.push(n);
  }
  return g;
}

export function explainReport(report) {
  const out = [];
  const g = groupUnmapped(report.unmapped);
  const pct = report.bones ? Math.round(100 * report.mapped / report.bones) : 0;
  out.push({ level: report.missingCore.length ? 'warn' : 'ok', text: `${report.mapped} of ${report.bones} bones mapped (${pct}%).` });
  if (report.missingCore.length) {
    out.push({ level: 'warn', text: `Core bones with no match: ${report.missingCore.join(', ')}. Pick them in the table below, or load a map file. The limbs they drive will hold the rest pose until then.` });
  }
  if (g.fingers.length) out.push({ level: 'info', text: `${g.fingers.length} finger bone(s) unmapped. Normal when the BVH has no finger channels; fingers stay in the rest pose.` });
  if (g.face.length) out.push({ level: 'info', text: `${g.face.length} face bone(s) unmapped (${g.face.slice(0, 3).join(', ')}${g.face.length > 3 ? ', ...' : ''}). BVH body capture rarely drives these.` });
  if (g.helpers.length) out.push({ level: 'info', text: `${g.helpers.length} helper/twist bone(s) unmapped. They follow their parents and need no mapping.` });
  if (g.other.length) out.push({ level: 'warn', text: `No BVH counterpart found for: ${g.other.slice(0, 8).join(', ')}${g.other.length > 8 ? ', ...' : ''}. They hold the rest pose (and ride along with their parents). If any are main body bones, map them manually.` });
  return out;
}
