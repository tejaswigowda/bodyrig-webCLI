import { chromium } from 'playwright';
import { createServer } from '../server.js';
import os from 'node:os'; import fs from 'node:fs';
const file = process.argv[2];
const srv = createServer('docs', {'/fixtures/': 'tests/fixtures'});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, body: fs.readFileSync('tests/fixtures/xbot.fbx'), headers: { 'access-control-allow-origin': '*' } }));
const p = await ctx.newPage();
p.on('console', m => { if (/error/.test(m.type())) console.log(m.type(), m.text().slice(0, 300)); });
p.on('pageerror', e => console.log('PAGEERROR', e.stack?.slice(0, 600) || e.message));
await p.goto(`http://127.0.0.1:${srv.address().port}/index.html?nosw`);
if (process.argv[3] === 'sample') { await p.click('#btnSample'); await p.waitForSelector('#resultCard:not([hidden])', { timeout: 60000 }); console.log('sample done'); }
const t = Date.now();
await p.setInputFiles('#modelInput', [os.homedir() + '/Downloads/' + file]);
const last = []; 
for (let i = 0; i < 60; i++) {
  const st = await Promise.race([p.evaluate(() => document.getElementById('statusText').textContent), new Promise(r => setTimeout(() => r('<<UNRESPONSIVE>>'), 8000))]);
  const s = `${((Date.now() - t) / 1000).toFixed(0)}s ${st}`; if (last.at(-1) !== st) { console.log(s); last.push(st); }
  if (/^Done|rror|Cannot|No Skinned|Unsupported|Add an animation|Character loaded/.test(st)) break;
  await new Promise(r => setTimeout(r, 3000));
}
console.log(await p.evaluate(() => document.getElementById('log').innerText.slice(-900)).catch(() => 'log unavailable'));
await b.close(); srv.close();
