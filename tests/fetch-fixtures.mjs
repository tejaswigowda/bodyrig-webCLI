// Downloads the X Bot / Y Bot test characters from the CDN (they are not committed) and verifies their SHA-256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SAMPLE_CHARACTERS } from '../docs/js/samples.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export async function ensureFixtures() {
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, { url, sha256: want }] of Object.entries(SAMPLE_CHARACTERS)) {
    const file = path.join(dir, `${id}.fbx`);
    if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === want) continue;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fixture ${id}: ${url} returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== want) throw new Error(`fixture ${id}: SHA-256 mismatch for ${url}`);
    fs.writeFileSync(file, buf);
    console.log(`fixtures: downloaded ${id}.fbx (${Math.round(buf.length / 1024)} KB)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await ensureFixtures();
