// Build realistic human presets from the MakeHuman CC0 assets (base mesh, body targets,
// default skeleton with artist weights) into public/library/humans/<preset>.json.
//
//   node scripts/build-humans.mjs            (runs at prebuild; cached downloads in .cache/makehuman)
//
// Each preset: the morphed body (metres, Z up, facing -Y, feet at z = 0), its skeleton
// (Blender-convention bones with rolls from MakeHuman's rotation planes), per-vertex weights,
// and simple garments / hair made from body regions offset along the normals, so they
// deform with exactly the same weights as the skin underneath.
// MakeHuman assets: CC0 1.0 (https://github.com/makehumancommunity/makehuman, LICENSE.ASSETS.md).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache/makehuman');
const OUT = path.join(ROOT, 'public/library/humans');
const BASE = 'https://raw.githubusercontent.com/makehumancommunity/makehuman/master/makehuman/data/';
const RACES = ['caucasian', 'african', 'asian'];
const VERSION = 6; // bump to rebuild outputs

const FILES = [
  '3dobjs/base.obj',
  'rigs/default.mhskel',
  'rigs/default_weights.mhw',
  ...['male', 'female'].flatMap((g) => [...RACES.map((r) => `targets/macrodetails/${r}-${g}-young.target`), `targets/macrodetails/universal-${g}-young-averagemuscle-averageweight.target`]),
];

async function fetchCached(rel) {
  const p = path.join(CACHE, rel);
  if (fs.existsSync(p) && fs.statSync(p).size > 0) return fs.readFileSync(p, 'utf8');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const r = await fetch(BASE + rel, { headers: { 'User-Agent': 'b3d-studio-asset-builder' } });
  if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
  const t = await r.text();
  fs.writeFileSync(p, t);
  return t;
}

// ---------------------------------------------------------------- parse

function parseObj(text) {
  const v = [];
  const faces = [];
  let group = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.trim().split(/\s+/);
      v.push([+x, +y, +z]);
    } else if (line.startsWith('g ')) group = line.slice(2).trim();
    else if (line.startsWith('f ') && group === 'body') faces.push(line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1));
  }
  return { v, faces };
}

function parseTarget(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const [i, x, y, z] = line.trim().split(/\s+/);
    if (z !== undefined) out.push([+i, +x, +y, +z]);
  }
  return out;
}

// ---------------------------------------------------------------- math

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const r4 = (x) => Math.round(x * 1e4) / 1e4 + 0;

/** Same as src/core/rig.ts boneRest (rotation only): minimal rotation from +Y onto d. */
function restAxes(d) {
  const c = d[1];
  if (c < -0.999999) return { x: [-1, 0, 0], z: [0, 0, 1] };
  const ax = d[2], az = -d[0], k = 1 / (1 + c);
  // columns of R
  return { x: [c + ax * ax * k, az, ax * az * k], z: [ax * az * k, -ax, c + az * az * k] };
}

// ---------------------------------------------------------------- build

async function main() {
  const marker = path.join(OUT, `.v${VERSION}`);
  if (fs.existsSync(marker) && !process.argv.includes('--force')) {
    console.log('humans: up to date');
    return;
  }
  const [objText, skelText, wText] = await Promise.all(['3dobjs/base.obj', 'rigs/default.mhskel', 'rigs/default_weights.mhw'].map(fetchCached));
  const obj = parseObj(objText);
  const skel = JSON.parse(skelText);
  const weightsSrc = JSON.parse(wText).weights;
  fs.mkdirSync(OUT, { recursive: true });

  for (const gender of ['male', 'female']) {
    // Morph: base + ⅓ of each ethnic young target + the universal average target.
    const V = obj.v.map((p) => [...p]);
    const targets = [...RACES.map((r) => [`targets/macrodetails/${r}-${gender}-young.target`, 1 / 3]), [`targets/macrodetails/universal-${gender}-young-averagemuscle-averageweight.target`, 1]];
    for (const [rel, w] of targets) for (const [i, x, y, z] of parseTarget(await fetchCached(rel))) if (V[i]) (V[i][0] += x * w), (V[i][1] += y * w), (V[i][2] += z * w);
    // MakeHuman: decimetres, Y up, facing +Z  →  metres, Z up, facing -Y.
    let P = V.map(([x, y, z]) => [x * 0.1, -z * 0.1, y * 0.1]);
    // Feet on the floor (lowest body vertex), centred.
    const used = new Set(obj.faces.flat());
    let minZ = Infinity;
    for (const i of used) minZ = Math.min(minZ, P[i][2]);
    P = P.map(([x, y, z]) => [x, y, z - minZ]);

    // Skeleton from joint vertex groups (centroids), rolls from rotation planes.
    const joint = (name) => {
      const ids = skel.joints[name];
      const c = ids.reduce((s, i) => addv(s, P[i]), [0, 0, 0]);
      return scl(c, 1 / ids.length);
    };
    const bones = [];
    for (const [name, b] of Object.entries(skel.bones)) {
      const head = joint(b.head), tail = joint(b.tail);
      const d = norm(sub(tail, head));
      let roll = 0;
      const plane = skel.planes[b.rotation_plane];
      if (plane) {
        const [p0, p1, p2] = plane.map(joint);
        const n = norm(cross(sub(p1, p0), sub(p2, p1)));
        // MakeHuman aligns the bone's X axis with the plane normal.
        const want = norm(sub(n, scl(d, dot(n, d))));
        // Our rest frame with roll θ has X' = cos θ·x0 − sin θ·z0 (see rig.ts boneRest).
        const { x: x0, z: z0 } = restAxes(d);
        roll = Math.atan2(-dot(want, z0), dot(want, x0)) * (180 / Math.PI);
      }
      bones.push({ name, parent: b.parent ?? null, head: head.map(r4), tail: tail.map(r4), ...(Math.abs(roll) > 1e-3 ? { roll: Math.round(roll * 100) / 100 } : {}) });
    }

    // Body: only vertices the body faces use.
    const map = new Map();
    const verts = [];
    for (const i of [...used].sort((a, b) => a - b)) {
      map.set(i, verts.length);
      verts.push(P[i].map(r4));
    }
    const faces = obj.faces.map((f) => f.map((i) => map.get(i)));

    // Weights per body vertex (top 4, normalised): [vertex, boneIndex, weight, ...] flat.
    const boneIndex = new Map(bones.map((b, i) => [b.name, i]));
    const perV = verts.map(() => []);
    for (const [bone, list] of Object.entries(weightsSrc)) {
      const bi = boneIndex.get(bone);
      if (bi === undefined) continue;
      for (const [vi, w] of list) {
        const m = map.get(vi);
        if (m !== undefined && w > 0) perV[m].push([bi, w]);
      }
    }
    const W = perV.map((l) => {
      const top = l.sort((a, b) => b[1] - a[1]).slice(0, 4);
      const s = top.reduce((a, [, w]) => a + w, 0) || 1;
      return top.map(([bi, w]) => [bi, Math.round((w / s) * 1000) / 1000]);
    });

    // Vertex normals (area-weighted) for garment offsets.
    const N = verts.map(() => [0, 0, 0]);
    for (const f of faces) {
      let n = [0, 0, 0];
      for (let i = 0; i < f.length; i++) {
        const a = verts[f[i]], b = verts[f[(i + 1) % f.length]];
        n = addv(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
      }
      for (const i of f) N[i] = addv(N[i], n);
    }
    const NN = N.map(norm);

    // Region of the body by dominant bone families.
    const fam = (vi) => {
      const top = W[vi][0];
      return top ? bones[top[0]].name : '';
    };
    const inFam = (vi, re) => W[vi].reduce((s, [bi, w]) => s + (re.test(bones[bi].name) ? w : 0), 0) > 0.5;
    const headB = bones.find((b) => b.name === 'head');
    const eyeL = bones.find((b) => b.name === 'eye.L');
    const region = (pred) => faces.filter((f) => f.every((vi) => pred(vi)));

    const shirtRe = /^(spine0[1-5]|breast|clavicle|shoulder01|upperarm01|pelvis|special01)/;
    const pantsRe = /^(pelvis|upperleg|lowerleg|root|spine05)/;
    const shoeRe = /^(foot|toe)/;
    const waistZ = bones.find((b) => b.name === 'spine04').head[2];
    const parts = {
      body: { faces, offset: 0 },
      shirt: { faces: region((vi) => inFam(vi, shirtRe) && verts[vi][2] > waistZ - 0.13 && !/^(neck|head)/.test(fam(vi))), offset: 0.011, smooth: 2 },
      pants: { faces: region((vi) => inFam(vi, pantsRe) && verts[vi][2] < waistZ + 0.01 && verts[vi][2] > 0.1), offset: 0.008, smooth: 2 },
      shoes: { faces: region((vi) => inFam(vi, shoeRe) || verts[vi][2] < 0.11), offset: 0.01, smooth: 8 },

    };

    const out = { version: VERSION, gender, licence: 'CC0 1.0 (MakeHuman base mesh, targets, default skeleton and weights)', bones, parts: {} };
    for (const [name, part] of Object.entries(parts)) {
      // Compact the part's own vertex list and carry weights.
      const pm = new Map();
      const ids = [];
      for (const f of part.faces) for (const vi of f) if (!pm.has(vi)) (pm.set(vi, ids.length), ids.push(vi));
      const pf = part.faces.map((f) => f.map((vi) => pm.get(vi)));
      // Neighbours and boundary (edges used once) inside the part.
      const nb = ids.map(() => new Set());
      const edgeUse = new Map();
      for (const f of pf) for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        nb[a].add(b);
        nb[b].add(a);
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      }
      const boundary = new Set();
      for (const [k, n] of edgeUse) if (n === 1) k.split('_').forEach((x) => boundary.add(+x));
      // Edge distance from the boundary: offsets taper to zero at the edge (no visible step).
      const depth = ids.map(() => Infinity);
      let front = [...boundary];
      front.forEach((i) => (depth[i] = 0));
      for (let d = 1; front.length && d < 6; d++) {
        const next = [];
        for (const i of front) for (const j of nb[i]) if (depth[j] === Infinity) (depth[j] = d, next.push(j));
        front = next;
      }
      let pv = ids.map((vi, i) => addv(verts[vi], scl(NN[vi], part.offset * Math.min(1, 0.25 + depth[i] / 4))));
      // Laplacian smoothing (interior only) to soften toes / ears under shoes and hair.
      for (let it = 0; it < (part.smooth ?? 0); it++) {
        pv = pv.map((p, i) => {
          if (boundary.has(i) || !nb[i].size) return p;
          let c = [0, 0, 0];
          for (const j of nb[i]) c = addv(c, pv[j]);
          c = scl(c, 1 / nb[i].size);
          return addv(scl(p, 0.5), scl(c, 0.5));
        });
        // Keep the shell outside the skin: re-inflate along the normal.
        pv = pv.map((p, i) => {
          const base = verts[ids[i]];
          const off = dot(sub(p, base), NN[ids[i]]);
          const min = part.offset * Math.min(1, 0.25 + depth[i] / 4) * 0.8;
          return off < min ? addv(p, scl(NN[ids[i]], min - off)) : p;
        });
      }
      out.parts[name] = {
        mesh: { vertices: pv.map((p) => p.map(r4)), faces: pf, smooth: true },
        weights: ids.map((vi) => W[vi]),
      };
    }
    // Hair: a smooth cap shrink-wrapped onto the scalp (rays from inside the head), with a
    // clean hairline; it follows the head bone rigidly.
    {
      const headTris = [];
      for (const f of faces) {
        if (!f.every((vi) => inFam(vi, /^(head|neck0[23]|special0[3-6]|temporalis|levator|orbicularis|oculi|jaw)/))) continue;
        for (let i = 1; i < f.length - 1; i++) headTris.push([verts[f[0]], verts[f[i]], verts[f[i + 1]]]);
      }
      const c = [0, headB.head[1] + 0.015, eyeL.head[2] + 0.005];
      const cast = (d) => {
        let best = -1;
        for (const [a, b, q] of headTris) {
          const e1 = sub(b, a), e2 = sub(q, a), pv = cross(d, e2), det = dot(e1, pv);
          if (Math.abs(det) < 1e-12) continue;
          const tv = sub(c, a), u = dot(tv, pv) / det;
          if (u < 0 || u > 1) continue;
          const qv = cross(tv, e1), v = dot(d, qv) / det;
          if (v < 0 || u + v > 1) continue;
          const t = dot(e2, qv) / det;
          if (t > 0 && t > best) best = t;
        }
        return best;
      };
      const AZ = 56, EL = 22;
      const hairline = (az) => {
        const f = (1 - Math.cos(az)) / 2; // 0 front … 1 back
        const side = Math.pow(Math.sin(az), 2);
        return (24 - 58 * Math.pow(f, 1.3) - 8 * side) * (Math.PI / 180);
      };
      const grid = [];
      const hv = [];
      for (let j = 0; j <= EL; j++) {
        grid.push([]);
        for (let i = 0; i < AZ; i++) {
          const az = (i / AZ) * 2 * Math.PI;
          const lo = hairline(az);
          const el = lo + (Math.PI / 2 - lo) * (j / EL) * 0.999;
          const d = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
          const t = cast(d);
          if (t <= 0) {
            grid[j].push(-1);
            continue;
          }
          // Thickness: thin at the hairline, fuller on top.
          const thick = 0.004 + 0.01 * Math.min(1, j / 5) + 0.004 * Math.max(0, Math.sin(el));
          grid[j].push(hv.length);
          hv.push(addv(c, scl(d, t + thick)).map(r4));
        }
      }
      const top = hv.length;
      const crown = grid[EL].filter((x) => x >= 0).map((x) => hv[x]);
      const cc = scl(crown.reduce((a, p) => addv(a, p), [0, 0, 0]), 1 / Math.max(1, crown.length));
      hv.push(addv(cc, [0, 0, 0.002]).map(r4));
      const hf = [];
      for (let j = 0; j < EL; j++)
        for (let i = 0; i < AZ; i++) {
          const a = grid[j][i], b = grid[j][(i + 1) % AZ], q = grid[j + 1][(i + 1) % AZ], d = grid[j + 1][i];
          if (a >= 0 && b >= 0 && q >= 0 && d >= 0) hf.push([a, b, q, d]);
        }
      for (let i = 0; i < AZ; i++) {
        const a = grid[EL][i], b = grid[EL][(i + 1) % AZ];
        if (a >= 0 && b >= 0) hf.push([a, b, top]);
      }
      const hi = bones.findIndex((b) => b.name === 'head');
      out.parts.hair = { mesh: { vertices: hv, faces: hf, smooth: true }, weights: hv.map(() => [[hi, 1]]) };
    }
    // Eyes: centre and radius from the eye bones (eyeballs sit at the bone heads).
    out.eyes = ['L', 'R'].map((s) => {
      const b = bones.find((x) => x.name === `eye.${s}`);
      return { bone: b.name, center: b.head, forward: norm(sub(b.tail, b.head)).map(r4) };
    });
    const file = path.join(OUT, `${gender}.json`);
    fs.writeFileSync(file, JSON.stringify(out));
    console.log(`humans/${gender}.json: ${verts.length} body verts, ${faces.length} faces, ${bones.length} bones, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB; parts ${Object.entries(out.parts).map(([k, v]) => `${k} ${v.mesh.faces.length}`).join(', ')}`);
  }
  fs.writeFileSync(path.join(OUT, 'LICENSE.txt'), 'Human presets built from MakeHuman assets (base mesh, macro targets, default skeleton and weights), released under CC0 1.0 by the MakeHuman project: https://github.com/makehumancommunity/makehuman\n');
  fs.writeFileSync(marker, '');
}

main().catch((e) => {
  // Offline builds still work: the human presets are simply unavailable.
  console.warn('humans: skipped —', e.message);
});
