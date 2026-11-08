// Render a scene script from several angles into one contact sheet, so a model can be
// checked (and fixed) before anyone sees it.
//
//   node scripts/render-check.mjs <script.json> <out.png> [--url http://localhost:4173/] [--solid] [--focus id1,id2]
//
// Needs a running build (npm run build && npx vite preview --port 4173).
import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [scriptPath, outPath] = args.filter((a, i) => !a.startsWith('--') && !['--url', '--focus'].includes(args[i - 1]));
if (!scriptPath || !outPath) throw new Error('usage: render-check.mjs <script.json> <out.png> [--url U] [--solid] [--focus id]');
const url = opt('--url', 'http://localhost:4173/');
const solid = args.includes('--solid');
const focus = opt('--focus', null);
const raw = JSON.parse(fs.readFileSync(scriptPath, 'utf8').trim().replace(/^```\w*\n?|```$/g, ''));
const text = JSON.stringify(Array.isArray(raw) ? raw : { format: 'b3d-studio-script', version: 1, ...raw });

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url + '?debug');
await page.waitForSelector('[data-testid="viewport-canvas"]');
await page.waitForTimeout(1200);
// Hide the UI around the viewport so the shots show only the scene.
await page.addStyleTag({ content: '.topbar,.sidebar,.panel-timeline,.statusbar,.toolshelf,.vp-nav,.vp-header,.vp-axes,.resizer{display:none!important}' });

const result = await page.evaluate(async ({ text, solid }) => {
  const b = window.__b3d;
  // Validate like the app's script dialog (also maps script shorthand to commands).
  const commands = b.parseScript(text).command.commands;
  const s = b.store;
  if (b.prepare) await b.prepare(commands);
  s.dispatch({ type: 'batch', commands: [{ type: 'delete', ids: [...s.getState().doc.order] }, ...commands] }, { select: false });
  s.select(null);
  s.setShading(solid ? 'solid' : 'rendered');
  await b.viewport().settle();
  return { notice: s.getState().notice, objects: s.getState().doc.order.length };
}, { text, solid });
if (result.objects === 0) {
  console.error('Script failed:', result.notice);
  process.exit(1);
}
await page.waitForTimeout(1500);

const views = [['persp', 'Perspective'], ['front', 'Front'], ['right', 'Right'], ['top', 'Top']];
const shots = [];
const hasCam = await page.evaluate(() => !!window.__b3d.store.getState().doc.camera);
if (hasCam && !focus) {
  await page.evaluate(() => window.__b3d.viewport().viewCamera());
  await page.waitForTimeout(900);
  shots.push(['Scene camera', await page.screenshot({ type: 'png', timeout: 180000 })]);
}
for (const [v, label] of views) {
  await page.evaluate((v) => window.__b3d.viewport().setView(v), v);
  // Camera moves are animated per rendered frame; wait until this one has finished.
  await page.waitForFunction(() => !window.__b3d.viewport().tween, null, { timeout: 180000 });
  await page.evaluate((focus) => window.__b3d.viewport().frame(true, focus ? focus.split(',') : undefined), focus);
  await page.waitForFunction(() => !window.__b3d.viewport().tween, null, { timeout: 180000 });
  await page.waitForTimeout(300);
  shots.push([label, await page.screenshot({ type: 'png', timeout: 180000 })]);
}

// Contact sheet: 2 columns.
const sheet = await page.evaluate(async (imgs) => {
  const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
  const ims = await Promise.all(imgs.map(([, b]) => load(b)));
  const w = 600, h = Math.round((ims[0].height / ims[0].width) * w);
  const cols = 2, rows = Math.ceil(ims.length / cols);
  const c = document.createElement('canvas');
  c.width = w * cols; c.height = h * rows;
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
  ims.forEach((im, i) => {
    const x = (i % cols) * w, y = Math.floor(i / cols) * h;
    g.drawImage(im, x, y, w, h);
    g.fillStyle = '#000a'; g.fillRect(x, y, 150, 26);
    g.fillStyle = '#fff'; g.font = '15px sans-serif'; g.fillText(imgs[i][0], x + 8, y + 18);
  });
  return c.toDataURL('image/png').split(',')[1];
}, shots.map(([l, b]) => [l, b.toString('base64')]));
fs.writeFileSync(outPath, Buffer.from(sheet, 'base64'));
console.log(`${outPath}: ${shots.length} views, ${result.objects} objects${errors.length ? ', page errors: ' + errors.slice(0, 2).join(' | ') : ''}`);
await browser.close();
