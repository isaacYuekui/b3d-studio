// Copy a FilmCraft browser build (from `cargo xtask web` in the filmcraft repo) into public/film/.
//
//   node scripts/vendor-film.mjs <filmcraft-repo> [optimised.wasm]
//
// Cloudflare Pages serves files up to 25 MiB, and FilmCraft's wasm is larger, so the wasm is
// split into 20 MiB parts and index.html is patched to fetch and join them before start-up.
// FilmCraft is MIT / Apache-2.0 (see public/film/LICENSE-* and NOTICE); its name and logo stay
// FilmCraft's. B3D only hosts the unmodified build next to the 3D app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const repo = process.argv[2];
if (!repo) throw new Error('usage: node scripts/vendor-film.mjs <filmcraft-repo> [optimised.wasm]');
const dist = path.join(repo, 'target/web/dist');
const wasmPath = process.argv[3] ?? path.join(dist, 'filmcraft_web_bg.wasm');
const out = path.resolve('public/film');
const PART = 20 * 1024 * 1024;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['filmcraft_web.js', 'audio-worklet.js', 'favicon.png']) fs.copyFileSync(path.join(dist, f), path.join(out, f));
fs.cpSync(path.join(dist, 'snippets'), path.join(out, 'snippets'), { recursive: true });
for (const f of ['LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE']) fs.copyFileSync(path.join(repo, f), path.join(out, f));

const wasm = fs.readFileSync(wasmPath);
const parts = [];
for (let i = 0, n = 0; i < wasm.length; i += PART, n++) {
  const name = `wasm/filmcraft_web_bg.${n}.wasm`;
  fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });
  fs.writeFileSync(path.join(out, name), wasm.subarray(i, i + PART));
  parts.push(name);
}
const sha = crypto.createHash('sha256').update(wasm).digest('hex');

let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const original = 'await init({ module_or_path: new URL("filmcraft_web_bg.wasm" + v, location.href) });';
if (!html.includes(original)) throw new Error('FilmCraft index.html changed: update the loader patch');
const loader = `// B3D Studio hosting: the wasm is served in parts (Cloudflare Pages caps files at 25 MiB).
      const parts = ${JSON.stringify(parts)};
      const total = ${wasm.length};
      let got = 0;
      const status = document.getElementById("status");
      const chunks = await Promise.all(parts.map(async (p) => {
        const r = await fetch(p + v);
        if (!r.ok) throw new Error(p + ": HTTP " + r.status);
        const reader = r.body.getReader();
        const bufs = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bufs.push(value);
          got += value.length;
          if (status) status.textContent = "Loading FilmCraft… " + Math.min(100, Math.round(got / total * 100)) + "%";
        }
        return new Blob(bufs);
      }));
      if (status) status.textContent = "Starting FilmCraft…";
      await init({ module_or_path: new Response(new Blob(chunks), { headers: { "Content-Type": "application/wasm" } }) });`;
html = html.replace(original, loader);
// The build id must change whenever the wasm changes (parts are cached as immutable).
html = html.replace(/const build = "[^"]*";/, `const build = "${sha.slice(0, 16)}";`);
html = html.replace('<title>FilmCraft</title>', '<title>FilmCraft</title>\n  <!-- Hosted unmodified by B3D Studio. FilmCraft is MIT / Apache-2.0: see LICENSE-MIT, LICENSE-APACHE, NOTICE. -->');
fs.writeFileSync(path.join(out, 'index.html'), html);

console.log(`public/film: ${parts.length} wasm parts, ${(wasm.length / 1048576).toFixed(1)} MiB, sha256 ${sha.slice(0, 16)}`);
