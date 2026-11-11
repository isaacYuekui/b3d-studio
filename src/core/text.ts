// 3D text (Blender's Text object): letters from a font outline, filled front and back, with
// straight sides — "Extrude" in Blender. Pure geometry; fonts are parsed elsewhere and
// registered here (opentype.js Font objects), so tests can register them from disk.

import earcut from 'earcut';
import type { Font } from 'opentype.js';
import type { MeshData, Vec3 } from './types';

export const FONTS = ['sans', 'serif', 'display'] as const;
export type FontId = (typeof FONTS)[number];
export const FONT_LABEL: Record<FontId, string> = { sans: 'Sans (Inter Bold)', serif: 'Serif (Playfair Display Bold)', display: 'Display (Bebas Neue)' };
export const ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof ALIGNS)[number];

export interface TextData {
  body: string;
  font: FontId;
  /** Letter height in metres (the font's em size, like Blender's Size). */
  size: number;
  /** Thickness in metres (Blender's Extrude × 2). 0 = flat letters. */
  depth: number;
  align: TextAlign;
  /** Distance between lines, in multiples of size. */
  lineHeight?: number;
}

export const DEFAULT_TEXT: TextData = { body: 'Text', font: 'sans', size: 1, depth: 0.2, align: 'center' };
export const MAX_TEXT_LENGTH = 500;

const fonts = new Map<FontId, Font>();
export const registerFont = (id: FontId, font: Font) => void fonts.set(id, font);
export const isFontLoaded = (id: FontId) => fonts.has(id);

export class TextError extends Error {}

type P = [number, number];

/** Outline contours of a string (y up, metres), flattening curves into short lines. */
function contours(font: Font, t: TextData): P[][] {
  const out: P[][] = [];
  const lines = t.body.split('\n');
  const lh = (t.lineHeight ?? 1.2) * t.size;
  // Curve detail grows with size so big letters stay round, small ones stay light.
  const segs = Math.max(4, Math.min(16, Math.round(6 * Math.sqrt(t.size))));
  lines.forEach((raw, li) => {
    // Characters the font has no letter for are left out (instead of drawing empty boxes).
    const line = [...raw].filter((ch) => font.charToGlyphIndex(ch) > 0 || ch === ' ').join('');
    if (!line.trim()) return;
    const width = font.getAdvanceWidth(line, t.size, { kerning: true });
    const x0 = t.align === 'left' ? 0 : t.align === 'center' ? -width / 2 : -width;
    const path = font.getPath(line, x0, li * lh, t.size, { kerning: true });
    let cur: P[] = [];
    let last: P = [0, 0];
    const push = (p: P) => {
      const prev = cur[cur.length - 1];
      if (!prev || Math.hypot(prev[0] - p[0], prev[1] - p[1]) > 1e-7) cur.push(p);
      last = p;
    };
    const flip = (x: number, y: number): P => [x, -y];
    const close = () => {
      if (cur.length > 1) {
        const a = cur[0], b = cur[cur.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) cur.pop();
      }
      if (cur.length >= 3) out.push(cur);
      cur = [];
    };
    for (const c of path.commands) {
      if (c.type === 'M') {
        close();
        push(flip(c.x, c.y));
      } else if (c.type === 'L') push(flip(c.x, c.y));
      else if (c.type === 'Q') {
        const [x0q, y0q] = last;
        const [x1, y1] = flip(c.x1, c.y1), [x2, y2] = flip(c.x, c.y);
        for (let i = 1; i <= segs; i++) {
          const s = i / segs, u = 1 - s;
          push([u * u * x0q + 2 * u * s * x1 + s * s * x2, u * u * y0q + 2 * u * s * y1 + s * s * y2]);
        }
      } else if (c.type === 'C') {
        const [xa, ya] = last;
        const [x1, y1] = flip(c.x1, c.y1), [x2, y2] = flip(c.x2, c.y2), [x3, y3] = flip(c.x, c.y);
        for (let i = 1; i <= segs; i++) {
          const s = i / segs, u = 1 - s;
          push([u * u * u * xa + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3, u * u * u * ya + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3]);
        }
      } else if (c.type === 'Z') close();
    }
    close();
  });
  return out;
}

const area = (c: P[]) => {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

function inside(p: P, poly: P[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

const bbox = (c: P[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of c) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};

/** Characters in the text that the font can't draw (they're left out). */
export function missingChars(t: Pick<TextData, 'body' | 'font'>): string[] {
  const font = fonts.get(t.font);
  if (!font) return [];
  return [...new Set([...t.body].filter((ch) => !/\s/.test(ch) && font.charToGlyphIndex(ch) <= 0))];
}

/** The text as a closed mesh in the object's XY plane (readable from +Z), thickness along Z. */
export function textMesh(t: TextData): MeshData {
  const font = fonts.get(t.font);
  if (!font) throw new TextError(`The ${t.font} font isn't loaded yet`);
  const cs = contours(font, t).filter((c) => Math.abs(area(c)) > 1e-10);
  if (!cs.length) throw new TextError('No letters to make: this font draws Latin letters, digits and punctuation');
  // Nesting depth decides fill: outlines at even depth are solid, odd depth are holes (the inside of an O).
  const boxes = cs.map(bbox);
  const depthOf = cs.map((c, i) => {
    let d = 0;
    for (let j = 0; j < cs.length; j++) {
      if (i === j) continue;
      const a = boxes[i], b = boxes[j];
      if (a.x0 < b.x0 || a.x1 > b.x1 || a.y0 < b.y0 || a.y1 > b.y1) continue;
      if (inside(c[0], cs[j])) d++;
    }
    return d;
  });
  // Solid outlines counter-clockwise, holes clockwise (seen from +Z).
  const ring = cs.map((c, i) => ((area(c) > 0) === (depthOf[i] % 2 === 0) ? c : [...c].reverse()));

  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  const half = t.depth / 2;
  const flat = t.depth <= 1e-6;
  // Every outline point gets a front vertex (and a back one when extruded), shared by caps and sides.
  const front: number[][] = [], back: number[][] = [];
  ring.forEach((c, i) => {
    front[i] = c.map(([x, y]) => vertices.push([x, y, flat ? 0 : half]) - 1);
    back[i] = flat ? front[i] : c.map(([x, y]) => vertices.push([x, y, -half]) - 1);
  });
  for (let i = 0; i < ring.length; i++) {
    if (depthOf[i] % 2 !== 0) continue;
    // Direct holes of this solid outline.
    const holes = ring.map((_, j) => j).filter((j) => depthOf[j] === depthOf[i] + 1 && boxes[j].x0 >= boxes[i].x0 && boxes[j].x1 <= boxes[i].x1 && boxes[j].y0 >= boxes[i].y0 && boxes[j].y1 <= boxes[i].y1 && inside(ring[j][0], ring[i]));
    const parts = [i, ...holes];
    const coords: number[] = [];
    const holeIdx: number[] = [];
    const map: number[] = [];
    for (const [n, k] of parts.entries()) {
      if (n > 0) holeIdx.push(coords.length / 2);
      ring[k].forEach((p, m) => {
        coords.push(p[0], p[1]);
        map.push(k * 1e6 + m);
      });
    }
    const tris = earcut(coords, holeIdx);
    const vid = (side: number[][], idx: number) => side[Math.floor(map[idx] / 1e6)][map[idx] % 1e6];
    for (let k = 0; k < tris.length; k += 3) {
      const [a, b, c] = [tris[k], tris[k + 1], tris[k + 2]];
      const ccw = (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]) > 0;
      const [p, q, r] = ccw ? [a, b, c] : [a, c, b];
      faces.push([vid(front, p), vid(front, q), vid(front, r)]);
      if (!flat) faces.push([vid(back, p), vid(back, r), vid(back, q)]);
    }
  }
  if (!flat)
    ring.forEach((c, i) => {
      for (let m = 0; m < c.length; m++) {
        const n = (m + 1) % c.length;
        faces.push([front[i][m], back[i][m], back[i][n], front[i][n]]);
      }
    });
  // Round to 0.1 mm so saved projects stay small.
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return { vertices: vertices.map((v) => [r(v[0]), r(v[1]), r(v[2])] as Vec3), faces, smooth: false };
}
