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
  check('v0.3: model shows its source in Properties', /Ceramic Vase/.test(await page.textContent('[data-testid="properties"]')));

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
  await page.screenshot({ path: `${shots}/village.png` });
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
