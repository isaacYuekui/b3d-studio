// End-to-end smoke test in real headless Chrome (WebGL via SwiftShader).
// Usage: node tests/e2e/smoke.mjs <url> <screenshot-dir>
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4173/';
const shots = process.argv[3] ?? 'test-results';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function open(viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr ?? 1, hasTouch: !!opts.touch, isMobile: !!opts.touch, acceptDownloads: true });
  const page = await ctx.newPage();
  // Enable file-chooser interception from the start (enabling it after a reload is unreliable in Playwright).
  page.on('filechooser', () => {});
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await page.waitForSelector('[data-testid="viewport-canvas"]');
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}

const objCount = (page) => page.$$eval('[data-outliner-id]', (els) => els.length);
const selectedName = (page) => page.$eval('[data-outliner-id][aria-selected="true"] .ol-name', (e) => e.textContent).catch(() => null);

// ---------------------------------------------------------------- desktop
{
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  const gl = await page.evaluate(() => !!document.querySelector('canvas').getContext('webgl2') || !!document.querySelector('canvas').getContext('webgl'));
  check('desktop: WebGL context available', gl);

  // Canvas actually renders something other than a flat colour
  const variance = await page.evaluate(async () => {
    const c = document.querySelector('canvas');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tmp = document.createElement('canvas');
    tmp.width = 64; tmp.height = 64;
    const g = tmp.getContext('2d');
    g.drawImage(c, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add(`${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`);
    return set.size;
  });
  check('desktop: viewport renders geometry (colour variety)', variance > 8, `${variance} colour buckets`);

  check('desktop: default cube present', (await objCount(page)) === 1 && (await selectedName(page)) === 'Cube');
  await page.screenshot({ path: `${shots}/desktop-initial.png` });

  // Add via top menu
  await page.click('[data-menu="Add"]');
  await page.click('.menu [data-action="add.sphere"]');
  check('desktop: Add > Sphere via menu', (await objCount(page)) === 2 && (await selectedName(page)) === 'Sphere');

  // Add via Shift+A
  await page.mouse.move(700, 450);
  await page.keyboard.press('Shift+A');
  await page.click('.menu [data-action="add.cylinder"]');
  await page.keyboard.press('Shift+A');
  await page.click('.menu [data-action="add.plane"]');
  check('desktop: Shift+A add cylinder and plane', (await objCount(page)) === 4);

  // Duplicate + delete shortcuts
  await page.keyboard.press('Shift+D');
  check('desktop: Shift+D duplicates', (await objCount(page)) === 5 && (await selectedName(page)) === 'Plane.001');
  await page.keyboard.press('x');
  check('desktop: X deletes', (await objCount(page)) === 4);

  // Undo / redo
  await page.keyboard.press('Control+z');
  check('desktop: Ctrl+Z restores deleted object', (await objCount(page)) === 5);
  await page.keyboard.press('Control+Shift+z');
  check('desktop: Ctrl+Shift+Z redoes delete', (await objCount(page)) === 4);

  // Outliner selection sync -> properties
  await page.click('[data-outliner-id] >> text=Cube');
  const propName = await page.inputValue('[data-testid="prop-name"]');
  check('desktop: Outliner click syncs Properties', propName === 'Cube', propName);

  // Type a location value
  const xField = page.locator('[aria-label="X"]').first();
  await xField.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('2*1.5');
  await page.keyboard.press('Enter');
  const xVal = await page.locator('[aria-label="X"]').first().getAttribute('aria-valuenow');
  check('desktop: typed expression sets Location X', xVal === '3', `X=${xVal}`);

  // Scrub Location Y by dragging
  const yBox = await page.locator('[aria-label="Y"]').first().boundingBox();
  await page.mouse.move(yBox.x + 40, yBox.y + yBox.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(yBox.x + 40 + i * 10, yBox.y + yBox.height / 2);
  await page.mouse.up();
  const yVal = Number(await page.locator('[aria-label="Y"]').first().getAttribute('aria-valuenow'));
  check('desktop: drag-scrub changes Location Y', Math.abs(yVal - 1) < 0.01, `Y=${yVal}`);
  await page.keyboard.press('Control+z');
  const yAfterUndo = Number(await page.locator('[aria-label="Y"]').first().getAttribute('aria-valuenow'));
  check('desktop: one undo reverts the whole scrub', yAfterUndo === 0, `Y=${yAfterUndo}`);

  // Viewport click selection: deselect on empty, then click the cube centre
  await page.keyboard.press('Escape');
  check('desktop: Esc deselects', (await selectedName(page)) === null);
  await page.keyboard.press('Home');
  await page.waitForTimeout(600);
  const canvasBox = await page.locator('canvas').boundingBox();
  let picked = null;
  outer: for (let gy = 0.3; gy <= 0.7; gy += 0.1) {
    for (let gx = 0.3; gx <= 0.7; gx += 0.1) {
      await page.mouse.click(canvasBox.x + canvasBox.width * gx, canvasBox.y + canvasBox.height * gy);
      await page.waitForTimeout(60);
      picked = await selectedName(page);
      if (picked) break outer;
    }
  }
  check('desktop: clicking in the viewport selects an object', !!picked, String(picked));

  // Tool switching via keyboard
  await page.keyboard.press('r');
  check('desktop: R switches to Rotate tool', (await page.getAttribute('[data-tool="rotate"]', 'aria-pressed')) === 'true');
  await page.keyboard.press('g');

  // Context menu
  await page.mouse.click(canvasBox.x + 30, canvasBox.y + canvasBox.height - 30, { button: 'right' });
  check('desktop: right-click opens context menu', await page.isVisible('.menu'));
  await page.keyboard.press('Escape');

  // Rename via Properties
  if (await page.isVisible('[data-testid="prop-name"]')) {
    await page.fill('[data-testid="prop-name"]', 'Hero');
    await page.keyboard.press('Enter');
    check('desktop: rename through Properties', (await selectedName(page)) === 'Hero');
  }

  // Export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+e')]);
  const path = `${shots}/export.b3d.json`;
  await dl.saveAs(path);
  const fs = await import('node:fs');
  const exported = JSON.parse(fs.readFileSync(path, 'utf8'));
  check('desktop: export produces a valid project file', exported.format === 'b3d-studio-project' && Object.keys(exported.scene.objects).length === 4);

  // Reload restores autosave
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector('[data-outliner-id]');
  check('desktop: reload restores autosaved scene', (await objCount(page)) === 4);

  // Import: new scene, then import exported file
  await page.click('[data-menu="File"]');
  await page.click('.menu [data-action="file.new"]');
  await page.click('[data-testid="confirm-ok"]');
  check('desktop: File > New resets to default cube', (await objCount(page)) === 1);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.keyboard.press('Control+i')]);
  await chooser.setFiles(path);
  await page.waitForTimeout(300);
  check('desktop: import restores exported scene', (await objCount(page)) === 4);

  // Timeline playback
  await page.click('[data-testid="play"]');
  await page.waitForTimeout(500);
  await page.click('[data-testid="play"]');
  const frame = await page.$eval('[aria-label="Current frame"]', (e) => Number(e.value));
  check('desktop: timeline playback advances frames', frame > 3, `frame ${frame}`);

  await page.screenshot({ path: `${shots}/desktop-after.png` });
  check('desktop: no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- scene builder (v0.2)
{
  const fs = await import('node:fs');
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  const script = fs.readFileSync(new URL('../../examples/robot-studio.b3d-script.json', import.meta.url), 'utf8');

  // invalid script shows a readable error and cannot run
  await page.click('[data-testid="script-btn"]');
  await page.fill('[data-testid="script-text"]', '{"format":"b3d-studio-script","version":1,"commands":[{"type":"add","primitive":"teapot"}]}');
  check('v0.2: invalid script shows error and disables Run', (await page.isDisabled('[data-testid="script-run"]')) && /primitive/.test(await page.textContent('.script-status')));

  // valid script (wrapped in a chat-style code fence)
  await page.fill('[data-testid="script-text"]', 'Here is your scene:\n```json\n' + script + '\n```');
  check('v0.2: script parsed and ready', /23 commands/.test(await page.textContent('.script-status')));
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(1200);
  check('v0.2: script builds the scene (23 objects, default cube replaced)', (await objCount(page)) === 23);
  check('v0.2: hierarchy — eyes nested under visor under head', await page.isVisible('[data-outliner-id] >> text=Eye.L'));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/v02-robot-solid.png` });

  await page.click('[data-outliner-id] >> text=Robot');
  await page.keyboard.press('Period');
  await page.keyboard.press('Escape');
  await page.click('[data-shading="rendered"]');
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${shots}/v02-robot-rendered.png` });
  check('v0.2: rendered shading toggles on', (await page.getAttribute('[data-shading="rendered"]', 'aria-pressed')) === 'true');

  // material edit through Properties
  await page.click('[data-outliner-id] >> text=Vase');
  check('v0.2: custom mesh shows geometry stats', /verts/.test(await page.textContent('[data-testid="properties"]')));
  const metal = page.locator('[aria-label="Metallic"]');
  await metal.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  check('v0.2: material metallic edit applies', (await page.locator('[aria-label="Metallic"]').getAttribute('aria-valuenow')) === '1');

  // light properties
  await page.click('[data-outliner-id] >> text=Key Sun');
  check('v0.2: light shows Light properties', await page.isVisible('#light-type'));

  // one undo reverts the edit, the second reverts the whole script
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  check('v0.2: two undos revert edit + entire script', (await objCount(page)) === 1);
  await page.keyboard.press('Control+Shift+z');
  check('v0.2: redo restores the scene', (await objCount(page)) === 23);

  // add menu: torus + light
  await page.mouse.move(700, 450);
  await page.keyboard.press('Shift+A');
  await page.click('.menu [data-action="add.torus"]');
  check('v0.2: Add > Torus', (await selectedName(page)) === 'Torus');

  // GLB export
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), (async () => { await page.click('[data-menu="File"]'); await page.click('.menu [data-action="file.glb"]'); })()]);
  const glbPath = `${shots}/scene.glb`;
  await dl.saveAs(glbPath);
  const glb = fs.readFileSync(glbPath);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const names = (json.nodes ?? []).map((n) => n.name);
  check('v0.2: GLB export is a valid glTF binary', glb.subarray(0, 4).toString() === 'glTF' && glb.readUInt32LE(4) === 2, `${glb.length} bytes`);
  check('v0.2: GLB contains scene objects, not grid/helpers', names.includes('Vase') && names.includes('Torso') && !names.includes('grid') && !names.some((n) => /helper/.test(n)), `${names.length} nodes`);

  check('v0.2: no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- realism (v0.3)
{
  const fs = await import('node:fs');
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));

  // Library browser
  await page.click('[data-testid="library-btn"]');
  await page.waitForSelector('[data-asset]');
  const models = await page.$$eval('[data-asset]', (els) => els.length);
  check('v0.3: library lists models with thumbnails', models >= 40, `${models} models`);
  await page.fill('#lib-search', 'vase');
  const found = await page.$$eval('[data-asset]', (els) => els.map((e) => e.dataset.asset));
  check('v0.3: library search filters by name and category', found.length >= 3 && found.length < 10 && found.includes('ceramic_vase_01'), found.join(', '));
  await page.click('[data-asset="ceramic_vase_01"]');
  await page.waitForTimeout(2500);
  check('v0.3: adding a library model selects it', (await selectedName(page)) === 'Ceramic Vase');
  check('v0.3: model shows its asset in Properties', /ceramic_vase_01/.test(await page.textContent('[data-testid="properties"]')));

  // Apply a photo material to a cube
  await page.click('[data-outliner-id] >> text=Cube');
  await page.click('[data-testid="library-btn"]');
  await page.click('[data-lib-tab="textures"]');
  await page.click('[data-asset="brown_planks_05"]');
  check('v0.3: material from library applies to selected cube', (await page.inputValue('#mat-texture')) === 'brown_planks_05');

  // Sky
  await page.click('[data-testid="library-btn"]');
  await page.click('[data-lib-tab="hdris"]');
  await page.click('[data-asset="venice_sunset"]');
  await page.waitForTimeout(3000);
  check('v0.3: sky applies and switches to Rendered view', (await page.getAttribute('[data-shading="rendered"]', 'aria-pressed')) === 'true');
  await page.keyboard.press('Escape');
  check('v0.3: World panel shows the chosen sky', (await page.inputValue('#world-hdri')) === 'venice_sunset');

  // Realistic scene script
  await page.click('[data-testid="script-btn"]');
  await page.fill('[data-testid="script-text"]', fs.readFileSync(new URL('../../examples/still-life.b3d-script.json', import.meta.url), 'utf8'));
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(7000);
  check('v0.3: still-life script builds 13 objects', (await objCount(page)) === 13);
  await page.screenshot({ path: `${shots}/v03-still-life.png` });

  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 150000 }), (async () => { await page.click('[data-menu="File"]'); await page.click('.menu [data-action="file.glb"]'); })()]);
  const glbPath = `${shots}/still-life.glb`;
  await dl.saveAs(glbPath);
  const glb = fs.readFileSync(glbPath);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  check('v0.3: GLB export includes scanned models and their textures', (json.meshes?.length ?? 0) >= 10 && (json.images?.length ?? 0) >= 10, `${json.meshes?.length} meshes, ${json.images?.length} images, ${(glb.length / 1e6).toFixed(1)} MB`);

  check('v0.3: every asset loaded (no failed requests)', failed.length === 0, failed.slice(0, 3).join(' | '));
  check('v0.3: no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- example scenes + scene camera (v0.4)
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  const failed = [];
  page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
  await page.click('[data-testid="script-btn"]');
  await page.click('[data-example="forest-supercar"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="script-text"]').value.length > 1000);
  check('v0.4: example chip loads a scene script', /Supercar in the pines/.test(await page.textContent('.script-status')));
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(15000);
  check('v0.4: forest supercar builds 61 objects', (await objCount(page)) === 61, `${await objCount(page)}`);
  await page.keyboard.press('5');
  await page.waitForTimeout(1500);
  await page.keyboard.press('0');
  await page.waitForTimeout(2500);
  const sel = await page.evaluate(() => document.querySelector('.status-notice').textContent);
  check('v0.4: key 0 returns to the scene camera without complaint', !/no camera/.test(sel), sel);
  check('v0.4: all forest assets loaded', failed.length === 0, failed.slice(0, 3).join(' | '));
  check('v0.4: no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- iPad (landscape + portrait), touch
for (const [label, vp] of [['ipad-landscape', { width: 1180, height: 820 }], ['ipad-portrait', { width: 820, height: 1180 }]]) {
  const { ctx, page, errors } = await open(vp, { touch: true, dpr: 2 });
  const sidebar = await page.isVisible('.sidebar');
  check(`${label}: sidebar layout`, sidebar);
  await page.tap('[data-testid="add-btn"]');
  await page.tap('.menu [data-action="add.sphere"]');
  check(`${label}: tap Add > Sphere`, (await objCount(page)) === 2);
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(`${label}: no horizontal overflow`, noHScroll);
  await page.screenshot({ path: `${shots}/${label}.png` });
  check(`${label}: no errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- phone, touch
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, { touch: true, dpr: 3 });
  check('phone: compact layout (no sidebar, tab bar shown)', !(await page.isVisible('.sidebar')) && (await page.isVisible('.tabbar')));
  await page.tap('[data-tab="outliner"]');
  check('phone: Outliner sheet opens', (await objCount(page)) === 1);
  await page.tap('[data-tab="properties"]');
  check('phone: Properties sheet shows selected object', (await page.inputValue('[data-testid="prop-name"]')) === 'Cube');
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('phone: no horizontal overflow', noHScroll);
  // Touch targets
  const small = await page.$$eval('button', (bs) => bs.filter((b) => b.offsetParent && (b.getBoundingClientRect().height < 30)).map((b) => b.getAttribute('aria-label') || b.textContent).slice(0, 5));
  check('phone: visible buttons are at least 30px tall', small.length === 0, small.join(', '));
  await page.screenshot({ path: `${shots}/phone-properties.png` });
  await page.tap('[data-tab="properties"]');
  await page.screenshot({ path: `${shots}/phone-viewport.png` });
  check('phone: no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
