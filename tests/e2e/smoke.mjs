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
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'debug');
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
  await page.click('[data-prop-tab="material"]');
  const metal = page.locator('[aria-label="Metallic"]');
  await metal.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  check('v0.2: material metallic edit applies', (await page.locator('[aria-label="Metallic"]').getAttribute('aria-valuenow')) === '1');

  // light properties
  await page.click('[data-outliner-id] >> text=Key Sun');
  await page.click('[data-prop-tab="data"]');
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
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), (async () => { await page.click('[data-menu="File"]'); await page.click('.menu [data-action="file.glb"]'); })()]);
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
  await page.click('[data-prop-tab="data"]');
  check('v0.3: model shows its source in Properties', /Ceramic Vase/.test(await page.textContent('[data-testid="properties"]')));

  // Apply a photo material to a cube
  await page.click('[data-outliner-id] >> text=Cube');
  await page.click('[data-testid="library-btn"]');
  await page.click('[data-lib-tab="textures"]');
  await page.click('[data-asset="brown_planks_05"]');
  await page.click('[data-prop-tab="material"]');
  check('v0.3: material from library applies to selected cube', (await page.inputValue('#mat-texture')) === 'brown_planks_05');

  // Sky
  await page.click('[data-testid="library-btn"]');
  await page.click('[data-lib-tab="hdris"]');
  await page.click('[data-asset="venice_sunset"]');
  await page.waitForTimeout(3000);
  check('v0.3: sky applies and switches to Rendered view', (await page.getAttribute('[data-shading="rendered"]', 'aria-pressed')) === 'true');
  await page.keyboard.press('Escape');
  await page.click('[data-prop-tab="scene"]');
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
  check('v0.4: example chip loads a scene script', /Supercar drive in the pines/.test(await page.textContent('.script-status')));
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(15000);
  check('v0.4: forest supercar builds 108 objects', (await objCount(page)) === 108, `${await objCount(page)}`);
  await page.keyboard.press('5');
  await page.waitForTimeout(1500);
  await page.keyboard.press('0');
  await page.waitForTimeout(2500);
  const sel = await page.evaluate(() => document.querySelector('.status-notice').textContent);
  check('v0.4: key 0 returns to the scene camera without complaint', !/no camera/.test(sel), sel);
  // v0.6: the drive is keyframed — car, four wheel spins and a tracking camera.
  const drive = await page.evaluate(() => {
    const b = window.__b3d;
    const doc = b.store.getState().doc;
    const tracks = doc.animation?.tracks ?? {};
    const carId = Object.keys(tracks).find((id) => doc.objects[id]?.name === 'Car' || id === 'car');
    const node = (id) => b.viewport().entries.get(id)?.node;
    const spinId = Object.keys(tracks).find((id) => /spin/i.test(doc.objects[id]?.name ?? id));
    b.store.setFrame(1);
    const x1 = node(carId).position.x;
    b.store.setFrame(60);
    const x60 = node(carId).position.x;
    const spin = node(spinId);
    return { tracks: Object.keys(tracks).length, camKeys: doc.animation?.camera.length ?? 0, x1, x60, spinAngle: spin ? spin.rotationQuaternion ? 1 : Math.abs(spin.rotation.x) + Math.abs(spin.rotation.y) + Math.abs(spin.rotation.z) : 0, end: doc.animation?.end };
  });
  check('v0.6: forest drive has car + 4 wheel tracks and camera keys', drive.tracks === 5 && drive.camKeys >= 10 && drive.end === 120, JSON.stringify(drive));
  check('v0.6: car drives along the track (frame 1 → 60)', drive.x1 < -25 && Math.abs(drive.x60) < 2, `${drive.x1.toFixed(2)} → ${drive.x60.toFixed(2)}`);
  check('v0.6: wheels have turned by mid-drive', drive.spinAngle > 0, String(drive.spinAngle));
  await page.keyboard.press('0');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}/forest-drive-f60.png` });
  await page.evaluate(() => window.__b3d.store.setFrame(110));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/forest-drive-f110.png` });
  check('v0.4: all forest assets loaded', failed.length === 0, failed.slice(0, 3).join(' | '));
  check('v0.4: no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- keyframes, playback, MP4 (v0.6)
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  const id = await page.evaluate(() => window.__b3d.store.getState().selection);
  check('v0.6: default cube is selected', !!id);
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(200);
  check('v0.6: I inserts a keyframe (diamond on the timeline)', (await page.$$('[data-key-frame]')).length === 1);
  await page.evaluate((id) => {
    const s = window.__b3d.store;
    s.setFrame(24);
    s.dispatch({ type: 'setKeyframe', id, frame: 24, transform: { position: [3, 0, 1], rotation: [0, 0, 90], scale: [1, 1, 1] }, easing: 'linear' }, { select: false });
    s.dispatch({ type: 'setAnimation', end: 24 });
  }, id);
  await page.waitForTimeout(200);
  check('v0.6: second keyframe shows', (await page.$$('[data-key-frame]')).length === 2);
  const mid = await page.evaluate((id) => {
    window.__b3d.store.setFrame(12);
    return window.__b3d.viewport().entries.get(id).node.position.x;
  }, id);
  check('v0.6: object is between keys at the middle frame', mid > 0.5 && mid < 2.5, mid.toFixed(3));
  const posField = await page.$$eval('[data-testid="properties"] [role="spinbutton"]', (els) => els.slice(0, 1).map((e) => e.getAttribute('aria-valuenow')));
  check('v0.6: Properties shows the animated value', posField.length === 1 && Math.abs(Number(posField[0]) - mid) < 0.01, `${posField[0]} vs ${mid.toFixed(3)}`);
  // Auto-key: editing the animated object at a new frame adds a key there.
  await page.evaluate((id) => {
    const b = window.__b3d;
    b.store.setFrame(18);
  }, id);
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(200);
  check('v0.6: keying a third frame', (await page.$$('[data-key-frame]')).length === 3);
  await page.keyboard.press('Alt+KeyI');
  await page.waitForTimeout(200);
  check('v0.6: ⌥I deletes the key at the current frame', (await page.$$('[data-key-frame]')).length === 2);
  await page.evaluate(() => window.__b3d.store.setFrame(1));
  await page.click('[data-testid="play"]');
  await page.waitForTimeout(700);
  const playedTo = await page.evaluate(() => window.__b3d.store.getState().frame);
  await page.click('[data-testid="play"]');
  check('v0.6: playback advances frames', playedTo > 3, `frame ${playedTo}`);
  await page.evaluate(() => window.__b3d.store.setFrame(1));
  await page.click('[data-testid="tl-camkey"]');
  await page.waitForTimeout(200);
  check('v0.6: camera key stored', (await page.evaluate(() => window.__b3d.store.getState().doc.animation.camera.length)) === 1);

  // MP4 render (draft square, 24 frames).
  await page.click('[data-menu="File"]');
  await page.click('.menu [data-action="file.video"]');
  await page.click('[data-preset="square"]');
  await page.check('#video-draft');
  const t0 = Date.now();
  await page.click('[data-testid="video-render"]');
  const ok = await page.waitForSelector('[data-testid="video-preview"], .video-modal .script-status.bad', { timeout: 180000 }).then(() => true).catch(() => false);
  const bad = await page.$('.video-modal .script-status.bad');
  check('v0.6: video renders without error', ok && !bad, bad ? await bad.textContent() : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (ok && !bad) {
    const meta = await page.$eval('[data-testid="video-preview"]', (v) => new Promise((res) => {
      const done = () => res({ d: v.duration, w: v.videoWidth, h: v.videoHeight });
      if (v.readyState >= 1) done(); else v.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(() => res({ d: -1, w: 0, h: 0 }), 8000);
    }));
    check('v0.6: MP4 plays back: 1 s, square 720×720', Math.abs(meta.d - 1) < 0.15 && meta.w === 720 && meta.h === 720, JSON.stringify(meta));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="video-save"]')]);
    const fs = await import('node:fs');
    const p = await dl.path();
    const head = fs.readFileSync(p).subarray(4, 8).toString('latin1');
    check('v0.6: saved file is an MP4', dl.suggestedFilename().endsWith('.mp4') && head === 'ftyp', `${dl.suggestedFilename()} ${head} ${fs.statSync(p).size} B`);
    await page.screenshot({ path: `${shots}/video-result.png` });
  }
  check('v0.6: no console/page errors (animation, video)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- FilmCraft hosted at /film (v0.6)
{
  const { ctx, page } = await open({ width: 1280, height: 800 });
  const errors = [];
  const film = await ctx.newPage();
  film.on('pageerror', (e) => errors.push(String(e)));
  const sizes = [];
  film.on('response', async (r) => /\/film\/wasm\//.test(r.url()) && sizes.push([r.status(), Number(r.headers()['content-length'] ?? 0)]));
  await film.goto(new URL('film/', url).href);
  const started = await film.waitForFunction(() => window.filmcraftLoad && (window.filmcraftLoad.readyMs || window.filmcraftLoad.error), null, { timeout: 240000 }).then(() => film.evaluate(() => window.filmcraftLoad)).catch((e) => ({ error: String(e) }));
  check('v0.6: FilmCraft starts at /film', !!started.readyMs, JSON.stringify(started));
  check('v0.6: FilmCraft wasm parts load', sizes.length >= 2 && sizes.every(([st]) => st === 200), JSON.stringify(sizes));
  const lic = await page.evaluate(async (u) => (await fetch(u)).status, new URL('film/LICENSE-MIT', url).href);
  check('v0.6: FilmCraft licence is published with it', lic === 200);
  await film.waitForTimeout(2000);
  await film.screenshot({ path: `${shots}/filmcraft.png` });
  check('v0.6: FilmCraft runs without page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- model import (v0.5)
{
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  if (!fs.existsSync('tests/fixtures/vase-cm.glb')) execFileSync('node', ['tests/e2e/make-fixtures.mjs']);
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  const importFile = async (path) => {
    const name = path.split('/').pop().replace(/\.[^.]+$/, '');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Control+Shift+i')]);
    await chooser.setFiles(path);
    await page.waitForFunction((n) => { const t = document.querySelector('.status-notice')?.textContent ?? ''; return t.includes(`Imported “${n}”`) || t.includes('Import failed'); }, name, { timeout: 30000 });
    return page.textContent('.status-notice');
  };

  const n1 = await importFile('tests/fixtures/vase-cm.glb');
  check('v0.5: GLB import adds the model', /Imported “vase-cm”/.test(n1) && (await objCount(page)) === 2, n1);
  await page.waitForTimeout(2500);
  await page.click('[data-prop-tab="data"]');
  const size = Number(await page.locator('[aria-label="Size (longest side, m)"]').getAttribute('aria-valuenow'));
  check('v0.5: centimetre file converted to real metres', size > 0.2 && size < 0.6, `longest side ${size} m`);
  const grounded = await page.evaluate(() => {
    const vp = window.__b3d.viewport(); const sel = window.__b3d.store.getState().selection; const e = vp.entries.get(sel);
    let minY = Infinity, cx = 0, cz = 0, n = 0;
    for (const m of e.meshes) { m.computeWorldMatrix(true); const bb = m.getBoundingInfo().boundingBox; minY = Math.min(minY, bb.minimumWorld.y); cx += bb.centerWorld.x; cz += bb.centerWorld.z; n++; }
    return [minY, cx / n, cz / n].map((v) => Math.round(v * 100) / 100);
  });
  check('v0.5: imported model sits on the ground, centred at its origin', Math.abs(grounded[0]) < 0.02 && Math.abs(grounded[1]) < 0.1 && Math.abs(grounded[2]) < 0.1, grounded.join(', '));

  // Size field resizes uniformly
  const sizeField = page.locator('[aria-label="Size (longest side, m)"]');
  await sizeField.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('4.5');
  await page.keyboard.press('Enter');
  check('v0.5: typing a size scales the model', Math.abs(Number(await sizeField.getAttribute('aria-valuenow')) - 4.5) < 0.01);

  const n2 = await importFile('tests/fixtures/vase-gltf.zip');
  check('v0.5: ZIP of glTF + files imports', /Imported “vase-gltf”/.test(n2) && (await objCount(page)) === 3, n2);

  // Persists across reload (IndexedDB) and appears under My Models
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('[data-outliner-id]');
  await page.waitForTimeout(3000);
  check('v0.5: imported models reload from device storage', (await objCount(page)) === 3 && !/another device/.test(await page.textContent('.status-notice')));
  await page.click('[data-testid="library-btn"]');
  await page.click('[data-lib-tab="mine"]');
  check('v0.5: My Models lists both imports', (await page.$$eval('.lib-mine', (els) => els.length)) === 2);
  await page.keyboard.press('Escape');
  await page.click('.modal-backdrop', { position: { x: 5, y: 5 } }).catch(() => {});

  // Project export embeds the models; a fresh browser restores them
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+e')]);
  const projPath = `${shots}/with-models.b3d.json`;
  await dl.saveAs(projPath);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  check('v0.5: project export embeds imported models', Object.keys(proj.models ?? {}).length === 2);
  check('v0.5: no console/page errors (import)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  const fresh = await open({ width: 1280, height: 800 });
  const [ch] = await Promise.all([fresh.page.waitForEvent('filechooser'), fresh.page.keyboard.press('Control+i')]);
  await ch.setFiles(projPath);
  await fresh.page.waitForTimeout(4000);
  const meshes = await fresh.page.evaluate(() => [...window.__b3d.viewport().entries.values()].reduce((s, e) => s + e.meshes.length, 0));
  check('v0.5: project with embedded models opens on a fresh device', (await objCount(fresh.page)) === 3 && meshes >= 3 && !/another device/.test(await fresh.page.textContent('.status-notice')), `${meshes} meshes`);
  await fresh.ctx.close();
}

// ---------------------------------------------------------------- edit mode / modelling (v0.7)
// Screen position (client px) of a point given in Blender local coordinates of the edited object.
const screenOf = (page, p) =>
  page.evaluate((p) => {
    const vp = window.__b3d.viewport();
    const st = window.__b3d.store.getState();
    const id = st.edit?.id ?? st.selection;
    const e = vp.entries.get(id);
    const V = vp.camera.position.constructor;
    const eng = vp.engine;
    const s = V.Project(new V(p[0], p[2], p[1]), e.node.computeWorldMatrix(true), vp.scene.getTransformMatrix(), vp.camera.viewport.toGlobal(eng.getRenderWidth(), eng.getRenderHeight()));
    const r = document.querySelector('canvas').getBoundingClientRect();
    const k = eng.getHardwareScalingLevel();
    return { x: r.left + s.x * k, y: r.top + s.y * k };
  }, p);
const meshInfo = (page) =>
  page.evaluate(() => {
    const st = window.__b3d.store.getState();
    const o = st.doc.objects[st.edit?.id ?? st.selection];
    return { type: o?.type, nv: o?.mesh?.vertices.length, nf: o?.mesh?.faces.length, edit: st.edit && { mode: st.edit.mode, v: st.edit.sel.verts.length, f: st.edit.sel.faces.length, e: st.edit.sel.edges.length }, mods: o?.modifiers ?? null, smooth: o?.mesh?.smooth, maxZ: o?.mesh ? Math.max(...o.mesh.vertices.map((v) => v[2])) : null };
  });
const setNumber = async (page, scope, label, value) => {
  await page.click(`${scope} [role="spinbutton"][aria-label="${label}"]`);
  await page.fill(`${scope} .num-input`, String(value));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
};

{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.click('[data-testid="mode-toggle"]');
  await page.waitForTimeout(300);
  let m = await meshInfo(page);
  check('v0.7: Edit Mode turns the cube into an editable mesh, all selected', m.type === 'mesh' && m.nv === 8 && m.edit?.v === 8, JSON.stringify(m));
  check('v0.7: Modeling workspace tab is active', (await page.getAttribute('[data-ws="modeling"]', 'aria-selected')) === 'true');
  check('v0.7: Mesh and Select menus replace Add/Object', (await page.$$('[data-menu="Mesh"], [data-menu="Select"]')).length === 2 && !(await page.$('[data-menu="Add"]')));
  await page.click('[data-select-mode="face"]');
  const top = await screenOf(page, [0.7, -0.7, 1]);
  await page.mouse.click(top.x, top.y);
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('v0.7: clicking the top face selects just that face', m.edit?.mode === 'face' && m.edit.f === 1 && m.edit.v === 4, JSON.stringify(m.edit));
  await page.screenshot({ path: `${shots}/edit-face-selected.png` });
  await page.click('[data-edit-tool="mesh.extrude"]');
  await page.waitForTimeout(400);
  m = await meshInfo(page);
  check('v0.7: Extrude adds a block on top (10 faces)', m.nf === 10 && m.maxZ > 1.5, JSON.stringify(m));
  check('v0.7: Adjust Last Operation panel appears', await page.isVisible('[data-testid="lastop"]'));
  await setNumber(page, '[data-testid="lastop"]', 'Offset', 2);
  m = await meshInfo(page);
  check('v0.7: changing Offset re-runs the extrude (top at z = 3)', Math.abs(m.maxZ - 3) < 1e-6 && m.nf === 10, String(m.maxZ));
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('v0.7: Inset (I) on the new top face', m.nf === 14 && m.edit.f === 1, JSON.stringify(m));
  await page.keyboard.press('Control+KeyZ');
  await page.keyboard.press('Control+KeyZ');
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('v0.7: two undos return to the plain cube, still in Edit Mode with the face selected', m.nf === 6 && m.edit?.f === 1, JSON.stringify(m));
  // Move the selected face with the gizmo's median field (Properties).
  await setNumber(page, '[data-testid="properties"]', 'Z', 1.5);
  m = await meshInfo(page);
  check('v0.7: typing the median Z moves the selected face', Math.abs(m.maxZ - 1.5) < 1e-6, String(m.maxZ));
  await page.keyboard.press('Control+KeyZ');
  // Edges: select all, bevel, more segments.
  await page.keyboard.press('Digit2');
  await page.keyboard.press('KeyA');
  await page.keyboard.press('Control+KeyB');
  await page.waitForTimeout(400);
  m = await meshInfo(page);
  check('v0.7: Bevel all 12 edges (26 faces)', m.nf === 26, JSON.stringify(m));
  await setNumber(page, '[data-testid="lastop"]', 'Segments', 3);
  m = await meshInfo(page);
  check('v0.7: Bevel segments 3 rounds the edges', m.nf > 26, String(m.nf));
  await page.screenshot({ path: `${shots}/edit-bevel.png` });
  await page.keyboard.press('Control+KeyZ');
  await page.waitForTimeout(200);
  // Loop cut through a vertical edge: select one edge via the Select menu flow (box select on a side edge is fiddly), use store.
  await page.evaluate(() => {
    const s = window.__b3d.store;
    const e = s.getState().edit;
    s.setEdit({ ...e, mode: 'edge', sel: { verts: [0, 4], edges: ['0_4'], faces: [] } });
  });
  await page.keyboard.press('Control+KeyR');
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('v0.7: Loop Cut (Ctrl R) adds a ring of 4 edges', m.nf === 10 && m.edit?.e === 4, JSON.stringify(m));
  await page.keyboard.press('Control+KeyZ');
  // Box select everything in vertex mode.
  await page.keyboard.press('Digit1');
  await page.keyboard.press('Alt+KeyA');
  await page.click('[data-testid="box-select"]');
  const r = await page.$eval('canvas', (c) => c.getBoundingClientRect().toJSON());
  await page.mouse.move(r.left + 120, r.top + 80);
  await page.mouse.down();
  await page.mouse.move(r.right - 60, r.bottom - 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('v0.7: Box select picks the visible vertices (7 of 8 without X-ray)', m.edit?.v === 7, JSON.stringify(m.edit));
  await page.click('[data-testid="xray"]');
  await page.click('[data-testid="box-select"]');
  await page.mouse.move(r.left + 120, r.top + 80);
  await page.mouse.down();
  await page.mouse.move(r.right - 60, r.bottom - 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('v0.7: with X-ray, box select reaches the hidden vertex too', m.edit?.v === 8, JSON.stringify(m.edit));
  await page.click('[data-testid="xray"]');
  // Back to object mode; subdivision + mirror from Properties.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  check('v0.7: Tab returns to Object Mode', !(await meshInfo(page)).edit);
  await page.click('[data-prop-tab="modifiers"]');
  await page.click('[data-subdiv="2"]');
  await page.click('[data-mirror="x"]');
  await page.waitForTimeout(400);
  m = await meshInfo(page);
  const rendered = await page.evaluate(() => window.__b3d.viewport().entries.get(window.__b3d.store.getState().selection).node.getTotalIndices() / 3);
  check('v0.7: Subdivision 2 + Mirror X modifiers, shaded smooth, cage untouched', m.mods?.subdivision?.levels === 2 && m.mods?.mirror?.x === true && m.smooth && m.nf === 6 && rendered > 100, `${JSON.stringify(m.mods)} · ${rendered} triangles`);
  await page.screenshot({ path: `${shots}/edit-subdiv.png` });
  await page.waitForTimeout(1200); // autosave is debounced
  await page.reload();
  await page.waitForSelector('[data-testid="viewport-canvas"]');
  await page.waitForTimeout(2000);
  m = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; const o = d.objects[d.order[0]]; return { type: o.type, mods: o.modifiers }; });
  check('v0.7: edited mesh and modifiers survive a reload', m.type === 'mesh' && m.mods?.subdivision?.levels === 2);
  check('v0.7: no console/page errors (edit mode)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Scripted modelling example (editMesh).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.click('[data-testid="script-btn"]');
  await page.click('[data-example="coffee-mug"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="script-text"]').value.length > 500);
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(6000);
  const mug = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    const o = Object.values(d.objects).find((x) => x.name === 'Mug');
    return o && { type: o.type, faces: o.mesh.faces.length, subdiv: o.modifiers?.subdivision?.levels };
  });
  check('v0.8: coffee mug example is modelled with editMesh (hollow, bevelled, subdivided)', mug?.type === 'mesh' && mug.faces > 150 && mug.subdiv === 2, JSON.stringify(mug));
  await page.screenshot({ path: `${shots}/coffee-mug.png` });
  check('v0.8: no errors (coffee mug)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Characters: rig, skin, Pose Mode (v0.9).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.click('[data-testid="script-btn"]');
  await page.click('[data-example="character-walk"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="script-text"]').value.length > 500);
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const st = window.__b3d.store.getState();
    const d = st.doc;
    const rig = Object.values(d.objects).find((o) => o.type === 'armature');
    const body = Object.values(d.objects).find((o) => o.skin);
    return { bones: rig?.armature.bones.length, skinned: !!body, keys: Object.keys(d.animation?.poses?.[rig?.id] ?? {}).length, rig: rig?.id, body: body?.id };
  });
  check('v0.9: character example has a 19-bone rig, a skinned body and bone keys', info.bones === 19 && info.skinned && info.keys > 10, JSON.stringify(info));
  const posAt = (f) => page.evaluate(({ f, body }) => {
    window.__b3d.store.setFrame(f);
    const m = window.__b3d.viewport().entries.get(body).node;
    const p = m.getVerticesData('position');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 2; i < p.length; i += 3) { minY = Math.min(minY, p[i]); maxY = Math.max(maxY, p[i]); }
    return { n: p.length / 3, spread: maxY - minY };
  }, { f, body: info.body });
  const a = await posAt(1), b = await posAt(7);
  check('v0.9: the body deforms as it walks (stride changes between frames)', a.n === b.n && Math.abs(a.spread - b.spread) > 0.05, `${a.spread.toFixed(3)} → ${b.spread.toFixed(3)} (local Babylon z = Blender y)`);
  await page.evaluate(() => window.__b3d.viewport().viewCamera());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/character-walk.png` });
  // Pose Mode through the UI.
  await page.evaluate(({ rig }) => { window.__b3d.store.setFrame(1); window.__b3d.store.dispatch({ type: 'clearPoseKeys', id: rig, bone: null }); window.__b3d.store.select(rig); }, info);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  check('v0.9: Tab on the armature enters Pose Mode', (await page.textContent('[data-testid="mode-toggle"]')) === 'Pose Mode');
  await page.click('[data-bone="thigh.L"]');
  await setNumber(page, '[aria-label="thigh.L rotation"]', 'X', -45);
  const posed = await page.evaluate(({ rig }) => window.__b3d.store.getState().doc.objects[rig].pose?.['thigh.L'], info);
  check('v0.9: typing a bone rotation poses it', posed?.rotation?.[0] === -45, JSON.stringify(posed));
  await page.keyboard.press('KeyI');
  await page.waitForTimeout(200);
  const keyed = await page.evaluate(({ rig }) => window.__b3d.store.getState().doc.animation.poses?.[rig]?.['thigh.L']?.length, info);
  check('v0.9: I keys the selected bone', keyed === 1, String(keyed));
  await page.screenshot({ path: `${shots}/pose-mode.png` });
  await page.keyboard.press('Tab');
  check('v0.9: Tab leaves Pose Mode', (await page.textContent('[data-testid="mode-toggle"]')) === 'Object Mode');
  check('v0.9: no errors (characters)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Realistic people (v1.0).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.click('[data-testid="script-btn"]');
  await page.click('[data-example="living-room"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="script-text"]').value.length > 500);
  await page.click('[data-testid="script-run"]');
  await page.waitForFunction(() => Object.values(window.__b3d.store.getState().doc.objects).some((o) => o.skin?.weights), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    const rigs = Object.values(d.objects).filter((o) => o.type === 'armature');
    const parts = Object.values(d.objects).filter((o) => o.skin?.weights);
    return { rigs: rigs.length, bones: rigs[0]?.armature.bones.length, parts: parts.length, keys: Object.keys(d.animation?.poses ?? {}).length };
  });
  check('v1.0: living room has two realistic people (163-bone rigs, skinned clothes)', info.rigs === 2 && info.bones === 163 && info.parts >= 8 && info.keys === 2, JSON.stringify(info));
  const t0 = Date.now();
  const move = await page.evaluate(async () => {
    const b = window.__b3d;
    const node = b.viewport().entries.get('he-body').node;
    const sample = () => Array.from(node.getVerticesData('position').slice(0, 300));
    b.store.setFrame(10);
    const a = sample();
    b.store.setFrame(20);
    const c = sample();
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - c[i]));
    return d;
  });
  check('v1.0: the walking body deforms between frames', move > 0.01, `max vertex move ${move.toFixed(3)} m, ${Date.now() - t0} ms for 2 frames (software GPU)`);
  await page.evaluate(() => { window.__b3d.store.setFrame(100); window.__b3d.viewport().viewCamera(); });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}/living-room.png` });
  check('v1.0: no errors (people)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Environments + Roblox export (v1.1).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.click('[data-testid="script-btn"]');
  await page.click('[data-example="village-valley"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="script-text"]').value.length > 500);
  await page.click('[data-testid="script-run"]');
  await page.waitForFunction(() => Object.values(window.__b3d.store.getState().doc.objects).some((o) => o.terrain), null, { timeout: 60000 });
  await page.evaluate(() => window.__b3d.viewport().settle());
  const info = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    const os = Object.values(d.objects);
    return { terrain: os.filter((o) => o.terrain).length, scatter: os.filter((o) => o.scatter).reduce((s, o) => s + o.scatter.items.length, 0), houses: os.filter((o) => /^h\d$/.test(o.id)).length };
  });
  check('v1.1: village has terrain, 5 houses and hundreds of scattered plants', info.terrain === 1 && info.houses === 5 && info.scatter > 400, JSON.stringify(info));
  const sky = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    return { time: d.world?.time, water: !!d.objects.lake?.water, suns: Object.values(d.objects).filter((o) => o.light?.type === 'sun').length };
  });
  check('v1.2: village is set in the afternoon with one sun and a lake', sky.time === 'afternoon' && sky.water && sky.suns === 1, JSON.stringify(sky));
  await page.evaluate(() => window.__b3d.store.select(null));
  const t0 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), (async () => { await page.click('[data-menu="File"]'); await page.click('.menu [data-action="file.roblox"]'); })()]);
  const zipPath = `${shots}/village-roblox.zip`;
  await dl.saveAs(zipPath);
  const fs = await import('node:fs');
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const names = Object.keys(files).sort();
  check('v1.1: Roblox zip has models, terrain heightmap + colormap and README', ['README.txt', 'models.glb', 'terrain_colormap.png', 'terrain_heightmap.png', 'terrain_mesh_optional.glb'].every((n) => names.includes(n)), `${names.join(', ')} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const glb = Buffer.from(files['models.glb']);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const triCount = (m) => m.primitives.reduce((s, p) => s + (p.indices !== undefined ? json.accessors[p.indices].count : json.accessors[p.attributes.POSITION].count) / 3, 0);
  const maxTris = Math.max(...json.meshes.map(triCount));
  const parts = json.nodes.filter((n) => n.mesh !== undefined).length;
  const exts = json.extensionsUsed ?? [];
  check('v1.1: Roblox GLB: every mesh ≤ 20k triangles, scatter expanded into parts, no unsupported extensions', glb.subarray(0, 4).toString() === 'glTF' && maxTris <= 20000 && parts > 400 && !exts.some((e) => /instancing|webp|texture_transform/.test(e)), `${parts} parts, largest ${maxTris} tris, ext [${exts}]`);
  const readme = Buffer.from(files['README.txt']).toString();
  check('v1.1: README gives the terrain size in studs', /Size \(studs\):\s+X 571\.4/.test(readme), readme.split('\n').find((l) => l.includes('Size')));
  check('v1.2: README gives the lake as Roblox water and lighting for the time of day', /Water "Water": Position X -21\.4/.test(readme) && /ClockTime = 16/.test(readme) && !json.nodes.some((n) => /^Water/.test(n.name ?? '')), readme.split('\n').filter((l) => /Water "|ClockTime/.test(l)).join(' | '));
  // Time of day from the World panel.
  await page.evaluate(() => window.__b3d.store.select(null));
  await page.selectOption('#world-time', 'sunset');
  const tod = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; return { time: d.world.time, hdri: d.world.hdri, shading: window.__b3d.store.getState().shading, suns: Object.values(d.objects).filter((o) => o.light?.type === 'sun').length }; });
  check('v1.2: World → Time of day switches sky and keeps one sun', tod.time === 'sunset' && tod.hdri === 'qwantani_sunset_puresky' && tod.shading === 'rendered' && tod.suns === 1, JSON.stringify(tod));

  await page.evaluate(() => window.__b3d.viewport().viewCamera());
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${shots}/village.png`, timeout: 60000 }).catch(() => console.log('(village screenshot skipped: slow software rendering)'));
  // A model script with no camera, pasted after a scene that set one, must be framed, not
  // viewed through the old scene camera 45 m away.
  await page.click('[data-testid="script-btn"]');
  await page.fill('[data-testid="script-text"]', '{"commands":[{"type":"add","primitive":"torus","name":"Pasted"}]}');
  await page.click('[data-testid="script-run"]');
  await page.waitForTimeout(2500);
  const view = await page.evaluate(() => {
    const vp = window.__b3d.viewport();
    const t = vp.camera.target;
    return { radius: vp.camera.radius, dist: Math.hypot(t.x, t.y, t.z), objects: Object.keys(window.__b3d.store.getState().doc.objects).length };
  });
  check('v1.1: pasted model without a camera is framed (not the old scene camera)', view.objects === 1 && view.radius < 12 && view.dist < 2, JSON.stringify(view));
  check('v1.1: no errors (environments)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Camera moves (v1.3), on the light default scene (the village renders too slowly on the software GPU for UI clicks).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.click('[data-menu="Animation"]');
  await page.click('.menu [data-action="anim.camOrbit"]');
  await page.waitForTimeout(800);
  const orbit = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; return { keys: d.animation?.camera.length ?? 0, cameraView: window.__b3d.store.getState().cameraView }; });
  check('v1.3: Animation → Camera Move: Orbit keys the camera across the timeline', orbit.keys > 20 && orbit.cameraView === true, JSON.stringify(orbit));
  // Quality on this device (v1.5): Fast draws fewer pixels and is remembered after reload.
  const before = await page.evaluate(() => window.__b3d.viewport().engine.getHardwareScalingLevel());
  await page.evaluate(() => window.__b3d.store.select(null));
  await page.selectOption('#quality', 'fast');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ q: window.__b3d.store.getState().quality, scaling: window.__b3d.viewport().engine.getHardwareScalingLevel() }));
  await page.reload();
  await page.waitForFunction(() => !!window.__b3d);
  const kept = await page.evaluate(() => window.__b3d.store.getState().quality);
  check('v1.5: Quality → Fast lowers resolution and is remembered on this device', after.q === 'fast' && after.scaling >= before && kept === 'fast', JSON.stringify({ before, ...after, kept }));
  await page.evaluate(() => window.__b3d.store.setQuality('balanced'));
  check('v1.3: no errors (camera moves)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Hard-surface tools (v2.0): bevel modifier, creased subdivision, boolean from the Shape panel.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'block', name: 'Block' },
      { type: 'add', primitive: 'cylinder', id: 'drill', name: 'Drill', params: { radiusTop: 0.4, radiusBottom: 0.4, segments: 32 }, transform: { rotation: [90, 0, 0], scale: [1, 1, 2] } },
    ] });
    s.select('block');
  });
  await page.click('[data-prop-tab="modifiers"]');
  await page.click('[data-bevel="0.03"]');
  await page.click('[data-subdiv="2"]');
  await page.click('[data-testid="subdiv-sharp"]');
  const mods = await page.evaluate(() => window.__b3d.store.getState().doc.objects.block.modifiers);
  check('v2.0: Shape panel sets Bevel and Subdivision with sharp edges', mods?.bevel?.width === 0.03 && mods?.subdivision?.levels === 2 && mods?.subdivision?.sharpAngle === 30, JSON.stringify(mods));
  await page.selectOption('#bool-cutter', 'drill');
  await page.click('[data-testid="bool-apply"]');
  await page.waitForFunction(() => !window.__b3d.store.getState().doc.objects.drill.visible, null, { timeout: 30000 });
  const res = await page.evaluate(() => { const o = window.__b3d.store.getState().doc.objects.block; return { faces: o.mesh.faces.length, mods: !!o.modifiers }; });
  check('v2.0: Boolean cut applies (WASM loads in the browser) and hides the cutter', res.faces > 100 && !res.mods, JSON.stringify(res));
  await page.screenshot({ path: `${shots}/boolean.png` });
  check('v2.0: no errors (hard-surface tools)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Dope Sheet (v2.1): every key in rows; drag to move, Add + Slower ×2 to retime, Delete.
{
  const { ctx, page, errors } = await open({ width: 1180, height: 820 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    const k = (id, frame, x) => ({ type: 'setKeyframe', id, frame, transform: { position: [x, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'a', name: 'Box' }, { type: 'add', primitive: 'sphere', id: 'b', name: 'Ball' },
      k('a', 1, 0), k('a', 30, 2), k('a', 60, 4), k('b', 30, 1), k('b', 90, 3),
      { type: 'setCameraKey', frame: 1, position: [0, -10, 3], target: [0, 0, 0] }, { type: 'setCameraKey', frame: 120, position: [6, -10, 3], target: [0, 0, 0] },
    ] });
  });
  const opened = await page.evaluate(() => document.querySelector('[data-testid="tl-dopesheet"]')?.getAttribute('aria-pressed'));
  if (opened !== 'true') await page.click('[data-testid="tl-dopesheet"]');
  await page.waitForSelector('[data-ds-key="obj:a@30"]');
  const rows = await page.evaluate(() => [...document.querySelectorAll('.ds-label')].map((e) => e.textContent));
  check('v2.1: Dope Sheet lists Summary, Camera and each animated object', JSON.stringify(rows) === JSON.stringify(['Summary', 'Camera', 'Box', 'Ball']), JSON.stringify(rows));
  const kb = await page.locator('[data-ds-key="obj:a@30"]').boundingBox();
  const g = await page.locator('[data-testid="ds-grid"]').boundingBox();
  const end = await page.evaluate(() => window.__b3d.store.getState().doc.animation.end);
  const ppf = (g.width - 18) / (end - 1);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2 + ppf * 8, kb.y + kb.height / 2, { steps: 4 });
  await page.mouse.move(kb.x + kb.width / 2 + ppf * 15, kb.y + kb.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const moved = await page.evaluate(() => window.__b3d.store.getState().doc.animation.tracks.a.map((k) => k.frame));
  check('v2.1: dragging a key moves it (one undo step)', JSON.stringify(moved) === JSON.stringify([1, 45, 60]), JSON.stringify(moved));
  await page.click('[data-testid="ds-add"]');
  await page.click('[data-ds-key="obj:a@45"]'); // unselect (was selected)
  await page.click('[data-ds-key="obj:b@30"]');
  await page.click('[data-ds-key="obj:b@90"]');
  await page.click('[data-testid="ds-slower"]');
  const slower = await page.evaluate(() => window.__b3d.store.getState().doc.animation.tracks.b.map((k) => k.frame));
  check('v2.1: Add + Slower ×2 retimes the picked keys', JSON.stringify(slower) === JSON.stringify([30, 150]), JSON.stringify(slower));
  await page.click('[data-testid="ds-delete"]');
  const gone = await page.evaluate(() => window.__b3d.store.getState().doc.animation.tracks.b);
  await page.keyboard.press('Control+z');
  const back = await page.evaluate(() => window.__b3d.store.getState().doc.animation.tracks.b?.map((k) => k.frame));
  check('v2.1: Delete removes the selected keys and Undo brings them back', gone === undefined && JSON.stringify(back) === JSON.stringify([30, 150]), JSON.stringify({ gone, back }));
  await page.screenshot({ path: `${shots}/dopesheet.png` });
  check('v2.1: no errors (dope sheet)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Edit tools (v2.2): snapping, proportional editing, separate, join.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'a', name: 'Alpha' },
      { type: 'add', primitive: 'cube', id: 'b', name: 'Beta', transform: { position: [4, 0, 0] } },
    ] });
    s.select('a');
  });
  await page.click('[data-testid="snap"]');
  const snap = await page.evaluate(() => ({ on: window.__b3d.store.getState().snap, step: window.__b3d.viewport().gizmos.gizmos.positionGizmo.snapDistance }));
  check('v2.2: Snap button turns on 0.25 m gizmo steps', snap.on === true && snap.step === 0.25, JSON.stringify(snap));
  await page.click('[data-testid="snap"]');
  // Join Beta into Alpha from the Shape panel, then split again by loose parts.
  await page.click('[data-prop-tab="modifiers"]');
  await page.selectOption('#join-other', 'b');
  await page.click('[data-testid="join-apply"]');
  const joined = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; return { beta: !!d.objects.b, faces: d.objects.a.mesh?.faces.length }; });
  check('v2.2: Join pulls the other object into this one', !joined.beta && joined.faces === 12, JSON.stringify(joined));
  await page.click('[data-menu="Object"]');
  await page.click('.menu [data-action="object.separateLoose"]');
  const split = await page.evaluate(() => Object.values(window.__b3d.store.getState().doc.objects).filter((o) => o.mesh?.faces.length === 6).length);
  check('v2.2: Separate by Loose Parts splits it back into two objects', split === 2, String(split));
  // Proportional editing toggle in edit mode, with its radius field.
  await page.evaluate(() => window.__b3d.store.select('a'));
  await page.click('[data-testid="mode-toggle"]');
  await page.click('[data-testid="proportional"]');
  const prop = await page.evaluate(() => window.__b3d.store.getState().proportional);
  check('v2.2: Proportional editing toggles in edit mode and shows its radius', prop.on === true && (await page.isVisible('[data-testid="prop-radius"]')), JSON.stringify(prop));
  await page.click('[data-testid="proportional"]');
  await page.click('[data-testid="mode-toggle"]');
  check('v2.2: no errors (edit tools)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Materials (v2.3): presets and procedural patterns from the Material panel.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [{ type: 'delete', ids: [...s.getState().doc.order] }, { type: 'add', primitive: 'sphere', id: 'ball', name: 'Ball' }] });
    s.select('ball');
  });
  await page.click('[data-prop-tab="material"]');
  await page.click('.mat-more summary');
  await page.click('[data-mat-preset="Car paint"]');
  const paint = await page.evaluate(() => { const m = window.__b3d.store.getState().doc.objects.ball.material; return { cc: m.clearcoat, metal: m.metallic }; });
  const coat = await page.evaluate(() => window.__b3d.viewport().scene.meshes.find((m) => m.metadata?.id === 'ball' || m.parent?.metadata?.id === 'ball')?.material?.clearCoat?.isEnabled ?? null);
  check('v2.3: Car paint preset turns on clearcoat (also in the renderer)', paint.cc === 1 && paint.metal === 0.6 && coat === true, JSON.stringify({ ...paint, coat }));
  await page.selectOption('#mat-pattern', 'marble');
  await page.waitForTimeout(500);
  const pat = await page.evaluate(() => {
    const m = window.__b3d.store.getState().doc.objects.ball.material.pattern;
    const mesh = window.__b3d.viewport().scene.meshes.find((x) => x.metadata?.id === 'ball' || x.parent?.metadata?.id === 'ball');
    return { type: m?.type, tex: mesh?.material?.albedoTexture?.name ?? null };
  });
  check('v2.3: Pattern → Marble makes a procedural texture', pat.type === 'marble' && String(pat.tex).startsWith('pattern-marble'), JSON.stringify(pat));
  check('v2.3: no errors (materials)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Particles (v3.4): a preset from the Physics tab; particles move with the frame, no bake.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'sphere', id: 'src', name: 'Source', transform: { position: [0, 0, 1], scale: [0.2, 0.2, 0.2] } },
      { type: 'setAnimation', start: 1, end: 60 },
    ] });
    s.select('src');
    window.__b3d.viewport().frame(false);
  });
  await page.click('[data-prop-tab="physics"]');
  await page.click('.prop-section-head:has-text("Particles")');
  await page.click('[data-particle-preset="sparks"]');
  const ps = await page.evaluate(() => window.__b3d.store.getState().doc.objects.src.particles);
  check('v3.4: the Sparks preset sets up a particle system', ps?.count === 600 && ps.glow === 1 && ps.ground === 'stop', JSON.stringify(ps));
  const count = (f) => page.evaluate((fr) => { window.__b3d.store.setFrame(fr); const m = window.__b3d.viewport().scene.getMeshByName('src-particles'); return { n: m?.thinInstanceCount ?? -1, on: m?.isEnabled() }; }, f);
  const at1 = await count(1), at20 = await count(20), at20b = await count(20);
  check('v3.4: particles appear over time and the same frame shows the same count', at20.n > at1.n && at20.n > 50 && at20.on && at20.n === at20b.n, JSON.stringify({ at1, at20, at20b }));
  await page.screenshot({ path: `${shots}/particles.png` });
  await page.click('[data-testid="particles-toggle"]');
  const gone = await page.evaluate(() => !window.__b3d.viewport().scene.getMeshByName('src-particles') && !window.__b3d.store.getState().doc.objects.src.particles);
  check('v3.4: turning particles off removes them', gone);
  check('v3.4: no errors (particles)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Image textures + UV unwrap (v3.18): upload a picture, Smart UV Project, it follows the UVs.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'mesh', id: 'crate', name: 'Crate', mesh: { vertices: [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0], [-1, -1, 2], [1, -1, 2], [-1, 1, 2], [1, 1, 2]], faces: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]], smooth: false } },
    ] });
    s.select('crate');
  });
  await page.click('[data-prop-tab="material"]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.selectOption('#mat-texture', '__upload')]);
  await chooser.setFiles('tests/e2e/assets/uv-test.png');
  await page.waitForFunction(() => (window.__b3d.store.getState().doc.objects.crate.material.texture ?? '').startsWith('img-'), null, { timeout: 20000 });
  await page.waitForSelector('#mat-texture optgroup[label="Your images"] option', { state: 'attached', timeout: 5000 }).catch(() => {});
  const t = await page.evaluate(() => { const m = window.__b3d.store.getState().doc.objects.crate.material; return { tex: m.texture, scale: m.textureScale, hint: !!document.querySelector('[data-testid="mat-unwrap"]'), opt: !!document.querySelector('#mat-texture optgroup[label="Your images"] option') }; });
  check('v3.18: Texture → Upload an image puts your picture on the object', t.tex.startsWith('img-') && t.scale === 1 && t.hint && t.opt, JSON.stringify(t));
  await page.click('[data-testid="mat-unwrap"]');
  await page.evaluate(() => window.__b3d.store.setShading('rendered'));
  await page.waitForFunction(() => !!window.__b3d.viewport().entries.get('crate').material.albedoTexture?.isReady?.(), null, { timeout: 20000 }).catch(() => {});
  const u = await page.evaluate(() => {
    const o = window.__b3d.store.getState().doc.objects.crate;
    const e = window.__b3d.viewport().entries.get('crate');
    const uvs = e.node.getVerticesData('uv');
    return { faces: o.mesh.uv?.length, inUnit: [...uvs].every((x) => x >= -1e-6 && x <= 1 + 1e-6), tex: !!e.material.albedoTexture };
  });
  check('v3.18: Smart UV Project gives a UV map in 0..1 and the texture follows it', u.faces === 6 && u.inUnit && u.tex, JSON.stringify(u));
  // Edit Mode: U unwraps too; the Mesh menu has UV → Clear.
  await page.click('[data-testid="mode-toggle"]');
  await page.evaluate(() => window.__b3d.store.dispatch({ type: 'clearUv', id: 'crate' }, { select: false }));
  await page.mouse.move(640, 400);
  await page.keyboard.press('KeyU');
  const again = await page.evaluate(() => window.__b3d.store.getState().doc.objects.crate.mesh.uv?.length);
  check('v3.18: U in Edit Mode unwraps (Smart UV Project)', again === 6, String(again));
  await page.click('[data-testid="mode-toggle"]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/uv-texture.png`, timeout: 60000 }).catch(() => {});
  check('v3.18: no errors (image textures)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Collections (v3.17): Outliner folders, M to move, eye / camera toggles, active collection.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [{ type: 'delete', ids: [...s.getState().doc.order] }, { type: 'add', primitive: 'cube', id: 'box' }] });
    s.select(null);
  });
  await page.click('[data-testid="collection-add"]');
  await page.click('[data-menu="Add"]');
  await page.click('.menu [data-action="add.sphere"]');
  const a = await page.evaluate(() => {
    const st = window.__b3d.store.getState();
    const c = st.doc.collections?.[0];
    const sphere = Object.values(st.doc.objects).find((o) => o.type === 'sphere');
    return { c: c?.name, active: st.activeCollection === c?.id, sphereIn: sphere?.collection === c?.id, rows: document.querySelectorAll('[data-collection-row]').length };
  });
  check('v3.17: + in the Outliner makes a collection, and new objects go into it', a.c === 'Collection' && a.active && a.sphereIn && a.rows === 2, JSON.stringify(a));
  await page.click('[data-outliner-id="box"]');
  await page.mouse.move(640, 400);
  await page.keyboard.press('KeyM');
  await page.waitForSelector('[data-testid="move-collection-menu"]');
  const cid = await page.evaluate(() => window.__b3d.store.getState().doc.collections[0].id);
  await page.click(`[data-move-to="${cid}"]`);
  const moved = await page.evaluate(() => window.__b3d.store.getState().doc.objects.box.collection);
  check('v3.17: M → collection moves the selected object', moved === cid, String(moved));
  await page.click(`[data-collection-eye="${cid}"]`);
  const hid = await page.evaluate(() => { const vp = window.__b3d.viewport(); return [...vp.entries.values()].map((e) => e.node.isEnabled()); });
  check('v3.17: the collection eye hides everything in it', hid.length === 2 && hid.every((x) => !x), JSON.stringify(hid));
  await page.click(`[data-collection-eye="${cid}"]`);
  await page.click(`[data-collection-render="${cid}"]`);
  const r = await page.evaluate(() => { const c = window.__b3d.store.getState().doc.collections[0]; return { visible: c.visible, render: c.render, shown: [...window.__b3d.viewport().entries.values()].every((e) => e.node.isEnabled()) }; });
  check('v3.17: the camera toggle leaves a collection out of renders but shown in the viewport', r.visible && !r.render && r.shown, JSON.stringify(r));
  await page.click(`[data-collection-row="${cid}"]`, { button: 'right' });
  await page.click('[data-testid="collection-delete"]');
  const after = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; return { cols: d.collections?.length ?? 0, objs: d.order.length, any: d.order.some((id) => d.objects[id].collection) }; });
  check('v3.17: deleting a collection keeps its objects (back in the Scene Collection)', after.cols === 0 && after.objs === 2 && !after.any, JSON.stringify(after));
  check('v3.17: no errors (collections)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Sound effects (v3.16): videos get an automatic soundtrack from the scene (here: an explosion).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'setAnimation', fps: 24, start: 1, end: 24 },
      { type: 'add', primitive: 'cube', id: 'crate', transform: { position: [0, 0, 1] } },
      { type: 'add', primitive: 'empty', id: 'boom', transform: { position: [0, 0, 1] } },
      { type: 'setField', id: 'boom', field: { type: 'force', strength: 400, radius: 14, start: 4, end: 5, flash: 60000 } },
    ] });
  });
  await page.click('[data-menu="File"]');
  await page.click('.menu [data-action="file.video"]');
  await page.click('[data-preset="square"]');
  await page.check('#video-draft');
  const label = await page.evaluate(() => ({ on: document.querySelector('#video-sound')?.checked, text: document.querySelector('#video-sound')?.parentElement?.textContent }));
  check('v3.16: the video dialog lists the scene’s sounds (Explosion) and has sound on', label.on === true && /Explosion/.test(label.text ?? ''), JSON.stringify(label));
  await page.click('[data-testid="video-render"]');
  const ok = await page.waitForSelector('[data-testid="video-preview"], .video-modal .script-status.bad', { timeout: 180000 }).then(() => true).catch(() => false);
  const foot = ok ? await page.evaluate(() => [...document.querySelectorAll('.video-result .help-foot')].map((e) => e.textContent).join(' ')) : '';
  check('v3.16: the MP4 has a sound track', ok && /with sound/.test(foot), foot);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="video-save-sound"]')]);
  const fs = await import('node:fs');
  const wav = fs.readFileSync(await dl.path());
  // Loudest moment should be the blast (frame 4 = 0.125 s), not the start.
  const ch = wav.readUInt16LE(22), rate = wav.readUInt32LE(24), n = (wav.length - 44) / 2 / ch;
  let peakAt = 0, peak = 0;
  for (let i = 0; i < n; i += 64) { const v = Math.abs(wav.readInt16LE(44 + i * ch * 2)); if (v > peak) { peak = v; peakAt = i / rate; } }
  check('v3.16: Save sound gives a WAV whose loudest moment is the explosion', wav.subarray(0, 4).toString('latin1') === 'RIFF' && Math.abs(n / rate - 1) < 0.01 && peak > 3000 && peakAt > 0.1 && peakAt < 0.6, JSON.stringify({ secs: n / rate, peak, peakAt }));
  check('v3.16: no errors (sound)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Material slots (v3.15): Material tab → Slots → +, Edit Mode → Assign; fracture inner material.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'mesh', id: 'box', name: 'Box', mesh: { vertices: [[-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]], faces: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]], smooth: false }, material: { baseColor: '#cc3333' } },
    ] });
    s.select('box');
  });
  await page.click('[data-prop-tab="material"]');
  await page.click('[data-testid="mat-slot-add"]');
  await page.evaluate(() => window.__b3d.store.dispatch({ type: 'setMaterial', id: 'box', slot: 1, material: { baseColor: '#3355ff' } }, { select: false }));
  await page.click('[data-testid="mode-toggle"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const s = window.__b3d.store; s.setEdit({ ...s.getState().edit, mode: 'face', sel: { verts: [4, 5, 6, 7], edges: [], faces: [1] } }); });
  await page.click('[data-prop-tab="material"]');
  await page.click('[data-mat-slot="1"]');
  await page.click('[data-testid="mat-assign"]');
  const sl = await page.evaluate(() => {
    const o = window.__b3d.store.getState().doc.objects.box;
    const node = window.__b3d.viewport().entries.get('box').node;
    return { index: o.mesh.materialIndex, slots: o.materialSlots?.length, sub: node.subMeshes.length, multi: node.material?.getClassName?.(), mats: node.material?.subMaterials?.length };
  });
  check('v3.15: + adds a material slot and Assign puts the selected face on it (two sub-meshes, multi-material)', JSON.stringify(sl.index) === '[0,1,0,0,0,0]' && sl.slots === 1 && sl.sub === 2 && sl.multi === 'MultiMaterial' && sl.mats === 2, JSON.stringify(sl));
  // Extrude the top face: the new cap keeps the slot.
  await page.evaluate(() => window.__b3d.store.dispatch({ type: 'editMesh', id: 'box', steps: [{ op: 'extrude', select: { indices: [1] }, offset: 1 }] }, { select: false }));
  const ex = await page.evaluate(() => {
    const m = window.__b3d.store.getState().doc.objects.box.mesh;
    const top = m.faces.findIndex((f) => f.every((v) => m.vertices[v][2] > 1.9));
    return { top: m.materialIndex?.[top], n: m.materialIndex?.length, faces: m.faces.length };
  });
  check('v3.15: an extruded face keeps its material slot', ex.top === 1 && ex.n === ex.faces, JSON.stringify(ex));
  await page.click('[data-testid="mode-toggle"]');
  await page.evaluate(() => window.__b3d.store.setShading('rendered'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/slots.png` });
  check('v3.15: no errors (material slots)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Wave spray (v3.14): Water → Giant wave → Add spray on the crest.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'setAnimation', start: 1, end: 120 },
      { type: 'addWater', id: 'sea', size: [80, 80], level: 0, direction: 90 },
      { type: 'setWater', id: 'sea', water: { surge: { height: 8, start: 10, speed: 14, width: 15, from: -60 } } },
    ] });
    s.select('sea');
  });
  await page.click('[data-prop-tab="data"]');
  await page.click('[data-testid="surge-spray"]');
  const sp = await page.evaluate(() => {
    const s = window.__b3d.store;
    const p = s.getState().doc.objects.sea.particles;
    s.setShading('rendered');
    s.setFrame(60);
    return { emit: p?.emit, start: p?.start, end: p?.end, hide: p?.hideEmitter, shape: p?.shape };
  });
  // Front reaches y = -40 (water edge) at frame 9 + 20/14 s; leaves y = 40 at 9 + 100/14 s.
  check('v3.14: Add spray on the crest sets crest particles for the time the wave is over the water', sp.emit === 'crest' && sp.start === 43 && sp.end === 181 && sp.hide === false && sp.shape === 'smoke', JSON.stringify(sp));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/spray.png` });
  check('v3.14: no errors (spray)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Night lights (v3.13): pattern Glow (lit windows), towns light up after dark, explosion flash.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'setTimeOfDay', time: 'night' },
      { type: 'add', primitive: 'cube', id: 'wall', name: 'Wall', material: { pattern: { type: 'windows', colorA: '#2b3a48', colorB: '#d8cdb8', scale: 0.333, bump: 0.5 } } },
      { type: 'setAnimation', start: 1, end: 60 },
    ] });
    s.select('wall');
  });
  await page.click('[data-prop-tab="material"]');
  await setNumber(page, '[data-testid="properties"]', 'Glow', 3);
  const g = await page.evaluate(() => {
    const p = window.__b3d.store.getState().doc.objects.wall.material.pattern;
    const m = window.__b3d.viewport().entries.get('wall').material;
    return { glow: p.glow, emissiveMap: !!m.emissiveTexture, emissive: m.emissiveColor.r, colourRow: !!document.querySelector('[aria-label="Pattern glow colour"]') };
  });
  check('v3.13: Material → Pattern → Glow lights the windows (emission map)', g.glow === 3 && g.emissiveMap && g.emissive === 3 && g.colourRow, JSON.stringify(g));
  await page.click('[data-menu="Add"]');
  await page.hover('.menu-item:has-text("Town")');
  await page.click('.menu [data-action="add.town.village"]');
  const lit = await page.evaluate(() => {
    const o = window.__b3d.store.getState().doc.objects;
    const b = Object.keys(o).filter((id) => /^village-b\d+$/.test(id));
    return { buildings: b.length, lit: b.filter((id) => (o[id].material.pattern?.glow ?? 0) > 0).length };
  });
  check('v3.13: a town added at night has its windows lit', lit.buildings > 2 && lit.lit === lit.buildings, JSON.stringify(lit));
  // Explosion preset carries a flash: dark before the blast, bright at it (Rendered).
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'add', primitive: 'empty', id: 'boom', name: 'Boom', transform: { position: [0, 0, 1] } });
    s.select('boom');
    s.setFrame(20);
  });
  // Click before switching to Rendered (a lit village at night is slow to draw in software GL).
  await page.click('[data-prop-tab="physics"]');
  await page.click('[data-field-preset="blast"]');
  await page.evaluate(() => window.__b3d.store.setShading('rendered'));
  const fl = await page.evaluate(() => {
    const s = window.__b3d.store;
    const f = s.getState().doc.objects.boom.field;
    const vp = window.__b3d.viewport();
    s.setFrame(19);
    const before = vp.entries.get('boom').flash?.intensity;
    s.setFrame(20);
    const at = vp.entries.get('boom').flash?.intensity;
    s.setFrame(50);
    const after = vp.entries.get('boom').flash?.intensity;
    return { flash: f.flash, before, at, after, box: !!document.querySelector('[aria-label="Light flash"]:checked') };
  });
  check('v3.13: Explosion field flashes at its start frame and fades', fl.flash > 0 && fl.before === 0 && fl.at > 100 && fl.after < fl.at / 4 && fl.box, JSON.stringify(fl));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${shots}/night-lights.png`, timeout: 60000 }).catch(() => console.log('(night-lights screenshot skipped: slow software rendering)'));
  check('v3.13: no errors (night lights)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Town generator (v3.12): Add → Town → Village / Town / City; buildings with windows and roofs.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'delete', ids: [...s.getState().doc.order] });
  });
  await page.click('[data-menu="Add"]');
  await page.hover('.menu-item:has-text("Town")');
  await page.click('.menu [data-action="add.town.town"]');
  const t = await page.evaluate(() => {
    const o = window.__b3d.store.getState().doc.objects;
    const ids = Object.keys(o);
    const b = ids.filter((id) => /^town-b\d+$/.test(id));
    return { buildings: b.length, roofs: b.filter((id) => o[`${id}-roof`]).length, ground: o['town-ground']?.rigid?.type, windows: o[b[0]]?.material.pattern?.type };
  });
  check('v3.12: Add → Town builds a street grid of buildings with roofs, windows and a ground', t.buildings >= 4 && t.roofs === t.buildings && t.ground === 'passive' && t.windows === 'windows', JSON.stringify(t));
  await page.evaluate(() => window.__b3d.store.setShading('rendered'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/town.png` });
  await page.evaluate(() => { window.__b3d.store.setShading('solid'); window.__b3d.store.select('town-b0'); });
  await page.click('[data-menu="Object"]');
  await page.hover('.menu-item:has-text("Quick Effects")');
  await page.click('.menu [data-action="quick.explode"]');
  await page.waitForFunction(() => !!window.__b3d.store.getState().doc.objects['town-b0-roof']?.rigid, null, { timeout: 90000 });
  const roof = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; return { rigid: d.objects['town-b0-roof'].rigid.type, keys: d.animation?.tracks['town-b0-roof']?.length ?? 0 }; });
  check('v3.12: Quick Explode on a town building brings its roof down too', roof.rigid === 'active' && roof.keys > 2, JSON.stringify(roof));
  const inner = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    const pieces = Object.values(d.objects).filter((o) => o.id.startsWith('town-b0.'));
    return { pieces: pieces.length, slotted: pieces.filter((o) => o.materialSlots?.length === 1 && o.mesh.materialIndex?.includes(1)).length };
  });
  check('v3.15: broken building pieces get an inside material', inner.pieces > 3 && inner.slotted === inner.pieces, JSON.stringify(inner));
  check('v3.12: no errors (town)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Quick Effects (v3.11): Object → Quick Effects → Quick Explode in one tap.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'crate', name: 'Crate', transform: { position: [0, 0, 1] } },
      { type: 'setAnimation', start: 1, end: 60 },
    ] });
    s.select('crate');
    s.setFrame(12);
  });
  await page.click('[data-menu="Object"]');
  await page.hover('.menu-item:has-text("Quick Effects")');
  await page.click('.menu [data-action="quick.explode"]');
  await page.waitForFunction(() => Object.values(window.__b3d.store.getState().doc.objects).filter((o) => o.rigid?.type === 'active').length > 10, null, { timeout: 90000 });
  const r = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    const pieces = Object.values(d.objects).filter((o) => o.rigid?.type === 'active');
    const flew = pieces.filter((o) => { const k = d.animation.tracks[o.id]; return k && Math.hypot(k[k.length - 1].transform.position[0], k[k.length - 1].transform.position[1]) > 1.5; }).length;
    return { pieces: pieces.length, flew, ground: Object.values(d.objects).some((o) => o.rigid?.type === 'passive'), field: Object.values(d.objects).some((o) => o.field?.start === 12), shake: d.animation.shakes?.[0]?.start };
  });
  check('v3.11: Quick Explode fractures, blasts, bakes and shakes in one go', r.pieces >= 12 && r.flew > r.pieces / 2 && r.ground && r.field && r.shake === 12, JSON.stringify(r));
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => !!window.__b3d.store.getState().doc.objects.crate && Object.keys(window.__b3d.store.getState().doc.objects).length === 1);
  check('v3.11: one undo removes the whole effect', undone);
  check('v3.11: no errors (quick effects)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Animated rigid bodies (v3.10): a keyed passive paddle shoves an active box in the bake.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'ground', transform: { position: [0, 0, -0.5], scale: [30, 30, 0.5] } },
      { type: 'setRigidBody', id: 'ground', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'box', transform: { position: [0, 0, 0.5], scale: [0.5, 0.5, 0.5] } },
      { type: 'setRigidBody', id: 'box', rigid: {} },
      { type: 'add', primitive: 'cube', id: 'paddle', name: 'Paddle', transform: { position: [-4, 0, 0.6], scale: [0.2, 1, 0.6] } },
      { type: 'setKeyframe', id: 'paddle', frame: 1, easing: 'linear', transform: { position: [-4, 0, 0.6], rotation: [0, 0, 0], scale: [0.2, 1, 0.6] } },
      { type: 'setKeyframe', id: 'paddle', frame: 25, easing: 'linear', transform: { position: [4, 0, 0.6], rotation: [0, 0, 0], scale: [0.2, 1, 0.6] } },
      { type: 'setRigidBody', id: 'paddle', rigid: { type: 'passive' } },
      { type: 'setAnimation', start: 1, end: 48 },
    ] });
    s.select('paddle');
  });
  await page.click('[data-prop-tab="physics"]');
  await page.click('[data-testid="rigid-animated"]');
  await page.click('[data-testid="physics-bake"]');
  await page.waitForFunction(() => (window.__b3d.store.getState().doc.animation?.tracks.box?.length ?? 0) > 5, null, { timeout: 60000 });
  const r = await page.evaluate(() => { const d = window.__b3d.store.getState().doc; const k = d.animation.tracks.box; return { animated: d.objects.paddle.rigid.animated, x: k[k.length - 1].transform.position[0], paddleKeys: d.animation.tracks.paddle.length }; });
  check('v3.10: an Animated passive paddle pushes the box during the bake and keeps its own keys', r.animated === true && r.x > 4 && r.paddleKeys === 2, JSON.stringify(r));
  check('v3.10: no errors (animated rigid bodies)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Force fields (v3.9): Add → Force Field → Explosion; it blows rigid bodies apart in the bake.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'ground', transform: { position: [0, 0, -0.5], scale: [20, 20, 0.5] } },
      { type: 'setRigidBody', id: 'ground', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'l', transform: { position: [-1.2, 0, 0.5], scale: [0.5, 0.5, 0.5] } },
      { type: 'setRigidBody', id: 'l', rigid: {} },
      { type: 'add', primitive: 'cube', id: 'r', transform: { position: [1.2, 0, 0.5], scale: [0.5, 0.5, 0.5] } },
      { type: 'setRigidBody', id: 'r', rigid: {} },
      { type: 'setAnimation', start: 1, end: 48 },
    ] });
    s.setFrame(10);
  });
  await page.click('[data-menu="Add"]');
  await page.hover('.menu-item:has-text("Force Field")');
  await page.click('.menu [data-action="add.field.blast"]');
  const field = await page.evaluate(() => {
    const s = window.__b3d.store, id = s.getState().selection;
    s.dispatch({ type: 'transform', id, position: [0, 0, 0.3] }, { select: false });
    return s.getState().doc.objects[id];
  });
  check('v3.9: Add → Force Field → Explosion makes an empty with a blast at the current frame', field.type === 'empty' && field.field?.type === 'force' && field.field.start === 10 && field.field.end === 12, JSON.stringify(field.field));
  await page.click('[data-prop-tab="physics"]');
  const panel = await page.isVisible('[data-field-preset="wind"]');
  await page.evaluate(async () => { await window.__b3d.prepare([{ type: 'bakePhysics' }]); window.__b3d.store.dispatch({ type: 'bakePhysics' }); });
  const xs = await page.evaluate(() => { const t = window.__b3d.store.getState().doc.animation.tracks; return [t.l[t.l.length - 1].transform.position[0], t.r[t.r.length - 1].transform.position[0]]; });
  check('v3.9: the bake blows the boxes apart (field settings in the Physics tab)', panel && xs[0] < -3 && xs[1] > 3, JSON.stringify(xs));
  check('v3.9: no errors (force fields)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Tsunami surge (v3.8): a giant wave crosses the water and lifts what floats.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'addWater', id: 'sea', size: [120, 40], level: 0, direction: 0 },
      { type: 'add', primitive: 'cube', id: 'raft', name: 'Raft', transform: { position: [0, 0, 0], scale: [1, 1, 0.2] } },
      { type: 'setFloat', id: 'raft', float: { offset: 0 } },
    ] });
    s.select('sea');
    s.setFrame(1);
  });
  await page.click('[data-prop-tab="data"]');
  await page.click('[data-testid="surge-toggle"]');
  const surge = await page.evaluate(() => window.__b3d.store.getState().doc.objects.sea.water.surge);
  const lift = await page.evaluate(() => {
    const s = window.__b3d.store, raft = window.__b3d.viewport().entries.get('raft').node;
    const at = (f) => { s.setFrame(f); return Math.round(raft.position.y * 100) / 100; };
    const zs = [1, 40, 80, 100, 120].map(at);
    return { zs, x: Math.round(raft.position.x * 100) / 100 };
  });
  check('v3.8: Giant wave lifts the floating raft as it passes and carries it along', surge?.height === 8 && Math.max(...lift.zs) > 4 && lift.zs[0] < 1 && lift.x > 1, JSON.stringify({ surge, lift }));
  check('v3.8: no errors (tsunami)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Camera shake and floating on water (v3.7).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'addWater', id: 'sea', size: [40, 40], level: 0, height: 1.5, waves: 2 },
      { type: 'add', primitive: 'cube', id: 'buoy', name: 'Buoy', transform: { position: [2, 3, 0], scale: [0.5, 0.5, 0.5] } },
      { type: 'setCamera', position: [0, -14, 4], target: [0, 0, 0] },
    ] });
    s.select(null);
    s.setFrame(10);
  });
  await page.click('.prop-section-head:has-text("Camera shake")');
  await page.click('[data-shake="impact"]');
  const shakes = await page.evaluate(() => window.__b3d.store.getState().doc.animation?.shakes);
  check('v3.7: Scene → Camera shake adds an impact at the current frame', shakes?.length === 1 && shakes[0].start === 10 && shakes[0].end > 20, JSON.stringify(shakes));
  const aim = await page.evaluate(async () => {
    const s = window.__b3d.store, vp = window.__b3d.viewport();
    vp.viewCamera();
    await new Promise((r) => setTimeout(r, 600));
    const at = (f) => { s.setFrame(f); const t = vp.camera.target; return [t.x, t.y, t.z].map((v) => Math.round(v * 1000) / 1000); };
    return { before: at(8), during: at(13), after: at(60) };
  });
  check('v3.7: the camera jolts during the shake and settles after', JSON.stringify(aim.before) === JSON.stringify(aim.after) && JSON.stringify(aim.during) !== JSON.stringify(aim.before), JSON.stringify(aim));
  await page.evaluate(() => { window.__b3d.store.setCameraView(false); window.__b3d.store.select('buoy'); });
  await page.click('[data-prop-tab="physics"]');
  await page.click('[data-testid="float-toggle"]');
  const bob = await page.evaluate(() => {
    const s = window.__b3d.store, node = window.__b3d.viewport().entries.get('buoy').node;
    const y = (f) => { s.setFrame(f); return Math.round(node.position.y * 1000) / 1000; };
    return { f: s.getState().doc.objects.buoy.float, a: y(1), b: y(12), c: y(24) };
  });
  check('v3.7: Float on water makes it bob with the waves', bob.f?.offset === 0 && new Set([bob.a, bob.b, bob.c]).size > 1, JSON.stringify(bob));
  check('v3.7: no errors (shake, float)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Ocean waves and burst presets (v3.6).
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'delete', ids: [...s.getState().doc.order] });
  });
  await page.click('[data-menu="Add"]');
  await page.click('.menu [data-action="add.water"]');
  await page.waitForTimeout(500);
  const sea = await page.evaluate(() => {
    const s = window.__b3d.store;
    const id = s.getState().selection;
    const node = window.__b3d.viewport().entries.get(id).node;
    const y = (f) => { s.setFrame(f); return node.getVerticesData('position')[301]; };
    return { id, water: s.getState().doc.objects[id].water, verts: node.getTotalVertices(), a: y(1), b: y(13), a2: y(1) };
  });
  check('v3.6: Add → Water / Ocean makes a wavy surface that moves with the frame', sea.water?.height > 0 && sea.verts > 2000 && sea.a !== sea.b && sea.a === sea.a2, JSON.stringify(sea));
  await page.click('[data-prop-tab="data"]');
  await page.click('[data-sea="storm"]');
  const storm = await page.evaluate((id) => window.__b3d.store.getState().doc.objects[id].water, sea.id);
  check('v3.6: the Storm button raises the waves', storm.height === 3.5 && storm.waves >= 5.6, JSON.stringify(storm));
  await page.evaluate(() => window.__b3d.viewport().frame(false));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/ocean.png` });
  // A burst preset starts at the current frame.
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'add', primitive: 'sphere', id: 'bomb', name: 'Bomb', transform: { position: [0, 0, 1] } });
    s.select('bomb');
    s.setFrame(30);
  });
  await page.click('[data-prop-tab="physics"]');
  await page.click('.prop-section-head:has-text("Particles")');
  await page.click('[data-particle-preset="explosion"]');
  const ex = await page.evaluate(() => window.__b3d.store.getState().doc.objects.bomb.particles);
  check('v3.6: the Explosion preset bursts at the current frame', ex?.start === 30 && ex.end === 33 && ex.shape === 'fire', JSON.stringify(ex));
  check('v3.6: no errors (ocean, bursts)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Fire and smoke (v3.5): camera-facing puffs with a colour per particle.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'sphere', id: 'f', name: 'Fire source', transform: { position: [0, 0, 0.3], scale: [0.3, 0.3, 0.1] } },
      { type: 'setAnimation', start: 1, end: 60 },
    ] });
    s.select('f');
  });
  await page.click('[data-prop-tab="physics"]');
  await page.click('.prop-section-head:has-text("Particles")');
  await page.click('[data-particle-preset="fire"]');
  await page.evaluate(() => { const s = window.__b3d.store; s.setFrame(40); s.setShading('rendered'); window.__b3d.viewport().frame(false); });
  await page.waitForTimeout(1500);
  const fire = await page.evaluate(() => {
    const m = window.__b3d.viewport().scene.getMeshByName('f-particles');
    return { n: m?.thinInstanceCount, unlit: m?.material?.unlit, add: m?.material?.alphaMode, colours: !!m?.getVertexBuffer('instanceColor'), shape: window.__b3d.store.getState().doc.objects.f.particles.shape };
  });
  check('v3.5: the Fire preset makes glowing, camera-facing puffs with their own colours', fire.shape === 'fire' && fire.n > 100 && fire.unlit === true && fire.add === 1 && fire.colours, JSON.stringify(fire));
  await page.screenshot({ path: `${shots}/fire.png` });
  await page.evaluate(() => window.__b3d.store.setShading('solid'));
  check('v3.5: no errors (fire)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Cell Fracture (v3.3): break a block into rigid pieces from the Physics tab, then bake.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'floor', name: 'Floor', transform: { position: [0, 0, -1], scale: [6, 6, 1] } },
      { type: 'setRigidBody', id: 'floor', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'block', name: 'Block', transform: { position: [0, 0, 2.5], rotation: [30, 20, 0], scale: [0.8, 0.8, 0.8] } },
      { type: 'setAnimation', start: 1, end: 48 },
    ] });
    s.select('block');
  });
  await page.click('[data-prop-tab="physics"]');
  await page.click('.prop-section-head:has-text("Fracture")');
  await page.click('[data-pieces="8"]');
  await page.click('[data-testid="fracture"]');
  await page.waitForFunction(() => !window.__b3d.store.getState().doc.objects.block, null, { timeout: 60000 });
  const pieces = await page.evaluate(() => Object.values(window.__b3d.store.getState().doc.objects).filter((o) => o.name.startsWith('Block piece')).map((o) => o.rigid?.shape));
  check('v3.3: Break into pieces makes 8 rigid convex-hull pieces', pieces.length === 8 && pieces.every((x) => x === 'hull'), JSON.stringify(pieces));
  await page.evaluate(() => window.__b3d.store.select(null));
  await page.click('.prop-section-head:has-text("Physics")').catch(() => {});
  await page.evaluate(async () => { await window.__b3d.prepare([{ type: 'bakePhysics' }]); window.__b3d.store.dispatch({ type: 'bakePhysics' }); });
  const fell = await page.evaluate(() => {
    const d = window.__b3d.store.getState().doc;
    // Every piece dropped; they may come to rest on each other, so allow a little stacking.
    const z = Object.values(d.objects).filter((o) => o.name.startsWith('Block piece')).map((o) => { const k = d.animation.tracks[o.id]; return k ? [k[0].transform.position[2], k[k.length - 1].transform.position[2]] : null; });
    return { ok: z.every((p) => p && p[1] < p[0] - 0.3 && p[1] < 2.2) && z.filter((p) => p[1] < 1.5).length >= z.length - 2, z: JSON.stringify(z) };
  });
  check('v3.3: baked pieces fall and land on the floor', fell.ok, fell.z);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  const back = await page.evaluate(() => !!window.__b3d.store.getState().doc.objects.block);
  check('v3.3: undo puts the block back in one piece', back);
  await page.screenshot({ path: `${shots}/fracture.png` });
  check('v3.3: no errors (fracture)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Wireframe shading (v3.2) and the What's new panel.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'c', name: 'Box' },
      { type: 'add', primitive: 'sphere', id: 's', name: 'Ball', transform: { position: [3, 0, 0] } },
      { type: 'setModifiers', id: 's', modifiers: { subdivision: { levels: 1 } } },
    ] });
    s.select('c');
    window.__b3d.viewport().frame(false);
  });
  await page.click('[data-shading="wireframe"]');
  await page.waitForTimeout(400);
  const w = await page.evaluate(() => {
    const vp = window.__b3d.viewport();
    const lines = vp.scene.meshes.filter((m) => m.name.endsWith('-wire'));
    const cube = lines.find((m) => m.name === 'c-wire');
    return { n: lines.length, cubeLines: cube?.getTotalIndices() / 2, surface: vp.entries.get('c').meshes[0].visibility, orange: cube?.color.r > 0.9 && cube?.color.g < 0.7 };
  });
  check('v3.2: Wireframe draws every polygon edge (12 for a cube), hides surfaces, selected in orange', w.n === 2 && w.cubeLines === 12 && w.surface === 0 && w.orange, JSON.stringify(w));
  await page.screenshot({ path: `${shots}/wireframe.png` });
  await page.keyboard.press('Shift+z');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ shading: window.__b3d.store.getState().shading, lines: window.__b3d.viewport().scene.meshes.filter((m) => m.name.endsWith('-wire')).length, surface: window.__b3d.viewport().entries.get('c').meshes[0].visibility }));
  check('v3.2: ⇧ Z goes back to Solid with the surfaces', back.shading === 'solid' && back.lines === 0 && back.surface === 1, JSON.stringify(back));
  check('v3.2: no errors (wireframe)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  // A returning user sees what's new once.
  const p2 = await open({ width: 1024, height: 768 }, {});
  await p2.page.goto(url + (url.includes('?') ? '&' : '?') + 'whatsnew=3.0');
  await p2.page.waitForSelector('[data-testid="whatsnew"]');
  const text = await p2.page.textContent('[data-testid="whatsnew"]');
  await p2.page.click('[data-testid="whatsnew"] .btn');
  const gone = !(await p2.page.isVisible('[data-testid="whatsnew"]'));
  const newest = await p2.page.evaluate(() => (document.querySelector('.statusbar')?.textContent.match(/v(\d+\.\d+)/) ?? [])[1]);
  check("v3.2: What's new lists the changes since the last visit (newest first) and closes", text.includes(`v${newest}`) && !/v3\.0\s/.test(text) && gone, `${newest} | ${text.slice(0, 120)}`);
  await p2.ctx.close();
}

// Properties tabs (v3.1): Blender-style tabs; only the ones the object has; remembered.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'c', name: 'Box' },
      { type: 'add', primitive: 'light', id: 'l', name: 'Lamp', light: { type: 'point' } },
    ] });
    s.select('c');
  });
  const tabsOf = () => page.$$eval('[data-prop-tab]', (els) => els.map((e) => e.getAttribute('data-prop-tab') + (e.getAttribute('aria-selected') === 'true' ? '*' : '')).join(' '));
  const cube = await tabsOf();
  check('v3.1: a shape gets Scene, Object, Modifiers, Physics, Material tabs (Object first)', cube === 'scene object* modifiers physics material', cube);
  await page.click('[data-prop-tab="material"]');
  const mat = await page.isVisible('#mat-base');
  await page.evaluate(() => window.__b3d.store.select('l'));
  const lamp = await tabsOf();
  check('v3.1: Material shows the material; a light has a Light tab and no Material tab', mat && lamp === 'scene object* data', lamp);
  await page.evaluate(() => window.__b3d.store.select('c'));
  const back = await tabsOf();
  check('v3.1: the last tab is remembered when going back to the shape', back.includes('material*'), back);
  check('v3.1: no errors (tabs)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Rigid body physics (v3.0): turn on Rigid body, bake, the box falls and lands.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'floor', name: 'Floor', transform: { position: [0, 0, -0.5], scale: [6, 6, 0.5] } },
      { type: 'setRigidBody', id: 'floor', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'crate', name: 'Crate', transform: { position: [0, 0, 3], rotation: [20, 10, 0], scale: [0.5, 0.5, 0.5] } },
      { type: 'setAnimation', start: 1, end: 72 },
    ] });
    s.select('crate');
  });
  await page.click('[data-prop-tab="physics"]');
  await page.click('.prop-section-head:has-text("Physics")');
  await page.click('[data-testid="rigid-toggle"]');
  const rigid = await page.evaluate(() => window.__b3d.store.getState().doc.objects.crate.rigid);
  check('v3.0: Physics → Rigid body makes the crate an active body', rigid?.type === 'active' && rigid.mass === 1, JSON.stringify(rigid));
  await page.click('[data-testid="physics-bake"]');
  await page.waitForFunction(() => (window.__b3d.store.getState().doc.animation?.tracks.crate?.length ?? 0) > 10, null, { timeout: 60000 });
  const res = await page.evaluate(() => {
    const s = window.__b3d.store;
    const keys = s.getState().doc.animation.tracks.crate;
    s.setFrame(72);
    return { n: keys.length, first: keys[0].transform.position[2], last: keys[keys.length - 1].transform.position[2], lastFrame: keys[keys.length - 1].frame, notice: s.getState().notice };
  });
  check('v3.0: Bake drops it onto the floor as keyframes', res.first === 3 && Math.abs(res.last - 0.5) < 0.08 && res.lastFrame === 72, JSON.stringify(res));
  await page.waitForTimeout(500);
  const node = await page.evaluate(() => window.__b3d.viewport().entries.get('crate').node.position.y);
  check('v3.0: scrubbing to the end shows it resting on the floor', Math.abs(node - 0.5) < 0.08, String(node));
  await page.screenshot({ path: `${shots}/physics.png` });
  await page.click('[data-menu="Animation"]');
  await page.click('.menu [data-action="physics.free"]');
  const freed = await page.evaluate(() => !window.__b3d.store.getState().doc.animation?.tracks.crate);
  check('v3.0: Free bake removes the keys', freed);
  check('v3.0: no errors (physics)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// 3D text (v2.9): Add → Text, edit the words, change font; mesh edits convert it.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'delete', ids: [...s.getState().doc.order] });
  });
  await page.click('[data-menu="Add"]');
  await page.click('.menu [data-action="add.text"]');
  await page.waitForFunction(() => Object.values(window.__b3d.store.getState().doc.objects).some((o) => o.text), null, { timeout: 30000 });
  const t0 = await page.evaluate(() => { const o = Object.values(window.__b3d.store.getState().doc.objects).find((x) => x.text); return { id: o.id, body: o.text.body, faces: o.mesh.faces.length, rot: o.transform.rotation }; });
  check('v2.9: Add → Text makes standing 3D letters', t0.body === 'Text' && t0.faces > 50 && t0.rot[0] === 90, JSON.stringify(t0));
  await page.click('[data-prop-tab="data"]');
  await page.fill('[data-testid="text-body"]', 'Hello B3D');
  await page.click('.prop-section-head:has-text("Text")'); // blur the box (commits), closes the section
  await page.click('.prop-section-head:has-text("Text")');
  await page.selectOption('[data-testid="text-font"]', 'display');
  await page.waitForFunction((id) => window.__b3d.store.getState().doc.objects[id].text.font === 'display', t0.id, { timeout: 30000 });
  const t1 = await page.evaluate((id) => { const o = window.__b3d.store.getState().doc.objects[id]; return { body: o.text.body, font: o.text.font, faces: o.mesh.faces.length }; }, t0.id);
  check('v2.9: typing new words and picking another font rebuilds the letters', t1.body === 'Hello B3D' && t1.font === 'display' && t1.faces > t0.faces, JSON.stringify(t1));
  await page.evaluate(() => window.__b3d.viewport().frame(false));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/text-3d.png` });
  await page.keyboard.press('Control+z');
  const t2 = await page.evaluate((id) => window.__b3d.store.getState().doc.objects[id].text, t0.id);
  check('v2.9: undo steps back one text change', t2.font === 'sans' && t2.body === 'Hello B3D', JSON.stringify(t2));
  await page.click('[data-testid="mode-toggle"]');
  await page.keyboard.press('Alt+s');
  await page.click('[data-testid="mode-toggle"]');
  const t3 = await page.evaluate((id) => !!window.__b3d.store.getState().doc.objects[id].text, t0.id);
  check('v2.9: editing the mesh turns the text into a plain mesh', t3 === false);
  check('v2.9: no errors (text)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Graph Editor (v2.8): curves per channel; drag a key up to change a value, sideways to retime.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'cube', id: 'b', name: 'Bouncer' },
      { type: 'setKeyframe', id: 'b', frame: 1, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'setKeyframe', id: 'b', frame: 25, transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'setAnimation', start: 1, end: 60 },
    ] });
    s.select('b');
  });
  await page.click('[data-testid="tl-graph"]');
  await page.waitForSelector('[data-testid="graph-svg"]');
  const chans = await page.evaluate(() => ({ x: document.querySelector('[data-graph-ch="loc0"]').getAttribute('aria-pressed'), y: document.querySelector('[data-graph-ch="loc1"]').getAttribute('aria-pressed'), curves: document.querySelectorAll('[data-testid="graph-svg"] polyline').length }));
  check('v2.8: Graph Editor shows the curve that moves (Location X), not the flat ones', chans.x === 'true' && chans.y === 'false' && chans.curves === 1, JSON.stringify(chans));
  const key = async () => page.evaluate(() => window.__b3d.store.getState().doc.animation.tracks.b.map((k) => ({ f: k.frame, x: k.transform.position[0], y: k.transform.position[1], e: k.easing })));
  let bb = await page.locator('[data-graph-key="loc0@25"]').boundingBox();
  let cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx, cy - i * 5);
  await page.mouse.up();
  const up = await key();
  check('v2.8: dragging a key up raises that channel only, in one undo step', up[1].f === 25 && up[1].x > 4.5 && up[1].y === 0, JSON.stringify(up));
  await page.keyboard.press('Control+z');
  const undone = await key();
  bb = await page.locator('[data-graph-key="loc0@25"]').boundingBox();
  cx = bb.x + bb.width / 2; cy = bb.y + bb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 10, cy);
  await page.mouse.up();
  const moved = await key();
  check('v2.8: undo restores it; dragging sideways retimes the key', undone[1].x === 4 && moved[1].f > 25 && moved[1].x === 4, JSON.stringify({ undone, moved }));
  await page.selectOption('[data-testid="graph-easing"]', 'constant');
  const eased = await key();
  check('v2.8: the selected key gets Constant interpolation', eased.find((k) => k.f === moved[1].f)?.e === 'constant', JSON.stringify(eased));
  await page.screenshot({ path: `${shots}/graph-editor.png` });
  await page.click('[data-testid="tl-graph"]');
  check('v2.8: no errors (graph editor)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Camera lens (v2.7): focal length and depth of field from the Camera panel.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [
      { type: 'delete', ids: [...s.getState().doc.order] },
      { type: 'add', primitive: 'sphere', id: 'near', name: 'Near', transform: { position: [0, -2, 1] } },
      { type: 'add', primitive: 'cube', id: 'far', name: 'Far', transform: { position: [2, 8, 1] } },
      { type: 'setCamera', position: [0, -9, 2], target: [0, -2, 1] },
    ] });
    s.select(null);
  });
  await page.click('.prop-section-head:has-text("Camera")');
  await page.selectOption('[data-testid="lens-focal"]', '85');
  await page.click('[data-testid="lens-dof"]');
  await page.click('[data-fstop="1.4"]');
  const lens = await page.evaluate(() => window.__b3d.store.getState().doc.lens);
  check('v2.7: Camera panel sets an 85 mm lens with depth of field at f/1.4', lens?.focal === 85 && lens.dof === true && lens.fStop === 1.4, JSON.stringify(lens));
  await page.evaluate(async () => {
    const s = window.__b3d.store;
    s.setShading('rendered');
    window.__b3d.viewport().viewCamera();
  });
  await page.waitForTimeout(1200);
  const cam = await page.evaluate(() => {
    const vp = window.__b3d.viewport();
    return { fov: vp.camera.fov, mode: vp.camera.fovMode, dof: vp.pipeline?.depthOfFieldEnabled, focus: vp.pipeline?.depthOfField.focusDistance, view: window.__b3d.store.getState().cameraView };
  });
  const want = 2 * Math.atan(18 / 85);
  check('v2.7: through the camera the view is 85 mm across and focuses on the target', cam.view && Math.abs(cam.fov - want) < 1e-6 && cam.mode === 1 && cam.dof === true && Math.abs(cam.focus - 7071) < 5, JSON.stringify(cam));
  await page.screenshot({ path: `${shots}/lens-dof.png` });
  await page.evaluate(() => window.__b3d.store.setCameraView(false));
  await page.waitForTimeout(300);
  const free = await page.evaluate(() => ({ fov: window.__b3d.viewport().camera.fov, dof: window.__b3d.viewport().pipeline?.depthOfFieldEnabled }));
  check('v2.7: the free viewport keeps its own view, without blur', Math.abs(free.fov - 0.8) < 1e-9 && !free.dof, JSON.stringify(free));
  await page.evaluate(() => window.__b3d.store.setShading('solid'));
  check('v2.7: no errors (lens)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// More Edit Mode tools (v2.6): connect, dissolve, triangulate / tris to quads, shrink/fatten.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [{ type: 'delete', ids: [...s.getState().doc.order] }, { type: 'add', primitive: 'cube', id: 'c', name: 'Block' }] });
    s.select('c');
  });
  await page.click('[data-testid="mode-toggle"]');
  const faces = () => page.evaluate(() => window.__b3d.store.getState().doc.objects.c.mesh.faces.length);
  // Two opposite corners of the top face, then J.
  await page.evaluate(() => {
    const s = window.__b3d.store;
    const m = s.getState().doc.objects.c.mesh;
    const top = m.faces.find((f) => f.every((v) => m.vertices[v][2] > 0.99));
    s.setEdit({ ...s.getState().edit, mode: 'vert', sel: { verts: [top[0], top[2]], edges: [], faces: [] } });
  });
  await page.mouse.move(640, 400);
  await page.keyboard.press('j');
  const f1 = await faces();
  check('v2.6: J connects two corners, splitting the face', f1 === 7, String(f1));
  await page.keyboard.press('Control+x');
  const f2 = await faces();
  check('v2.6: Ctrl+X dissolves the new edge (faces merge back, no hole)', f2 === 6, String(f2));
  await page.keyboard.press('3');
  await page.keyboard.press('a');
  await page.keyboard.press('Control+t');
  const f3 = await faces();
  await page.keyboard.press('Alt+j');
  const f4 = await faces();
  check('v2.6: Triangulate then Tris to Quads round-trips the cube', f3 === 12 && f4 === 6, `${f3} → ${f4}`);
  const v0 = await page.evaluate(() => window.__b3d.store.getState().doc.objects.c.mesh.vertices[0].map(Math.abs));
  await page.keyboard.press('a');
  await page.keyboard.press('Alt+s');
  const v1 = await page.evaluate(() => window.__b3d.store.getState().doc.objects.c.mesh.vertices[0].map(Math.abs));
  const panel = await page.textContent('[data-testid="lastop"]').catch(() => '');
  check('v2.6: Shrink/Fatten (Alt+S) pushes vertices out and shows its settings', v1[0] > v0[0] && /Shrink\/Fatten/.test(panel), JSON.stringify({ v0, v1, panel }));
  await page.click('[data-menu="Mesh"]');
  const inMenu = await page.isVisible('.menu [data-action="mesh.bridge"]');
  await page.keyboard.press('Escape');
  check('v2.6: Bridge Edge Loops and Dissolve are in the Mesh menu', inMenu);
  await page.click('[data-testid="mode-toggle"]');
  check('v2.6: no errors (edit tools 2)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// More modifiers (v2.5): Array, Solidify, Displace from the Shape panel.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [{ type: 'delete', ids: [...s.getState().doc.order] }, { type: 'add', primitive: 'cube', id: 'step', name: 'Step', transform: { scale: [0.5, 0.5, 0.1] } }] });
    s.select('step');
    window.__b3d.viewport().frame(false);
  });
  const tris = () => page.evaluate(() => window.__b3d.viewport().entries.get('step').node.getTotalIndices() / 3);
  const t0 = await tris();
  await page.click('[data-prop-tab="modifiers"]');
  await page.click('[data-array="5"]');
  await page.click('[data-array-axis="z"]');
  await page.waitForTimeout(400);
  let mods = await page.evaluate(() => window.__b3d.store.getState().doc.objects.step.modifiers);
  const t1 = await tris();
  check('v2.5: Array ×5 along Z repeats the shape', mods?.array?.count === 5 && mods.array.relative[2] === 1 && t1 > t0 * 2, JSON.stringify({ mods, t0, t1 }));
  await page.click('[data-solidify="0.05"]');
  await page.click('[data-displace="0.03"]');
  await page.click('[data-testid="displace-seed"]');
  await page.waitForTimeout(400);
  mods = await page.evaluate(() => window.__b3d.store.getState().doc.objects.step.modifiers);
  check('v2.5: Solidify and Displace set from the Shape panel', mods?.solidify?.thickness === 0.05 && mods?.displace?.strength === 0.03 && mods.displace.seed === 1 && mods.array.count === 5, JSON.stringify(mods));
  await page.screenshot({ path: `${shots}/modifiers-v25.png` });
  await page.keyboard.press('Control+z');
  mods = await page.evaluate(() => window.__b3d.store.getState().doc.objects.step.modifiers);
  check('v2.5: undo steps back one modifier change', mods?.displace?.seed === undefined && mods?.displace?.strength === 0.03, JSON.stringify(mods));
  check('v2.5: no errors (modifiers)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// Sculpt Mode (v2.4): brushes on a subdivided sphere; one stroke = one undo; view stays put.
{
  const { ctx, page, errors } = await open({ width: 1180, height: 820 });
  await page.evaluate(() => {
    const s = window.__b3d.store;
    s.dispatch({ type: 'batch', commands: [{ type: 'delete', ids: [...s.getState().doc.order] }, { type: 'add', primitive: 'sphere', id: 'clay', name: 'Clay' }] });
    s.select('clay');
    window.__b3d.viewport().frame(false);
  });
  await page.waitForTimeout(800);
  await page.click('[data-testid="sculpt-toggle"]');
  await page.click('[data-testid="sculpt-detail"]');
  const n = await page.evaluate(() => window.__b3d.store.getState().doc.objects.clay.mesh.vertices.length);
  check('v2.4: Sculpt Mode + Add detail subdivides the model', n > 1500 && (await page.textContent('[data-testid="mode-toggle"]')) === 'Sculpt Mode', String(n));
  const cv = await page.locator('[data-testid="viewport-canvas"]').boundingBox();
  const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
  const before = await page.evaluate(() => JSON.stringify(window.__b3d.store.getState().doc.objects.clay.mesh.vertices));
  const alpha0 = await page.evaluate(() => window.__b3d.viewport().camera.alpha);
  await page.mouse.move(cx - 50, cy);
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) { await page.mouse.move(cx - 50 + i * 10, cy + Math.sin(i) * 10); await page.waitForTimeout(40); }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify(window.__b3d.store.getState().doc.objects.clay.mesh.vertices));
  const alpha1 = await page.evaluate(() => window.__b3d.viewport().camera.alpha);
  check('v2.4: a stroke on the model sculpts it and does not turn the view', before !== after && Math.abs(alpha1 - alpha0) < 1e-6, JSON.stringify({ alpha0, alpha1 }));
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => JSON.stringify(window.__b3d.store.getState().doc.objects.clay.mesh.vertices));
  check('v2.4: one undo removes the whole stroke', undone === before);
  await page.click('[data-testid="sculpt-done"]');
  check('v2.4: no errors (sculpt)', errors.length === 0 && (await page.textContent('[data-testid="mode-toggle"]')) === 'Object Mode', errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// iPad: edit mode by touch.
{
  const { ctx, page, errors } = await open({ width: 820, height: 1180 }, { touch: true, dpr: 2 });
  await page.tap('[data-testid="mode-toggle"]');
  await page.waitForTimeout(300);
  await page.tap('[data-select-mode="face"]');
  const top = await screenOf(page, [0.7, -0.7, 1]);
  await page.touchscreen.tap(top.x, top.y);
  await page.waitForTimeout(300);
  let m = await meshInfo(page);
  check('ipad: tap selects a face in Edit Mode', m.edit?.f === 1, JSON.stringify(m.edit));
  await page.tap('[data-testid="add-select"]');
  const side = await screenOf(page, [0.5, -1, 0.3]);
  await page.touchscreen.tap(side.x, side.y);
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('ipad: "add to selection" toggle lets a second tap add a face', m.edit?.f === 2, JSON.stringify(m.edit));
  await page.tap('[data-edit-tool="mesh.extrude"]');
  await page.waitForTimeout(300);
  m = await meshInfo(page);
  check('ipad: Extrude from the toolbar', m.nf === 6 + 2 + 6 - 1 || m.nf > 6, JSON.stringify(m));
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('ipad: edit header fits without horizontal overflow', noHScroll);
  await page.screenshot({ path: `${shots}/ipad-edit.png` });
  check('ipad: no errors (edit mode)', errors.length === 0, errors.slice(0, 3).join(' | '));
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
