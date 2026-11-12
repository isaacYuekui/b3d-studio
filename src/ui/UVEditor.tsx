import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCtx } from './context';
import { runAction } from './actions';
import { validUv } from '../core/mesh/uv';
import type { UV } from '../core/mesh/uv';
import { convertMode, flush } from '../core/mesh/select';
import { isUserImage, userImageUrl } from '../engine/userImages';
import type { MeshData } from '../core/types';

/** Point inside a polygon (UV space). */
function inside(p: UV, poly: UV[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

/** Move / scale / rotate the UVs of some faces about their middle. */
export function transformUv(mesh: MeshData, faces: number[], fn: (p: UV, c: UV) => UV): UV[][] {
  const uv = mesh.uv!.map((f) => f.map((p) => [...p] as UV));
  const pts = faces.flatMap((f) => uv[f]);
  const c: UV = pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : [0.5, 0.5];
  for (const f of faces) uv[f] = uv[f].map((p) => {
    const q = fn(p, c);
    return [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5];
  });
  return uv;
}

/**
 * UV Editor (Blender's): the object's UV map over its image. In Edit Mode, tap islands to select
 * their faces, drag to move them, and scale / rotate with the buttons — the texture on the model
 * follows live.
 */
export function UVEditor() {
  const { store } = useCtx();
  const ctx = useCtx();
  const id = useApp((s) => s.edit?.id ?? s.selection);
  const o = useApp((s) => (id ? s.doc.objects[id] : undefined));
  const edit = useApp((s) => (s.edit && s.edit.id === id ? s.edit : null));
  const [img, setImg] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ start: UV; base: MeshData } | null>(null);
  const mesh = o?.mesh;
  const hasUv = !!mesh && validUv(mesh);
  const tex = o?.material.texture ?? null;

  useEffect(() => {
    let live = true;
    if (isUserImage(tex)) void userImageUrl(tex!).then((u) => live && setImg(u));
    else setImg(null);
    return () => {
      live = false;
    };
  }, [tex]);

  const selFaces = useMemo(() => new Set(edit?.sel.faces ?? []), [edit]);
  const S = 1000; // SVG units for the 0..1 square
  const toSvg = (p: UV) => `${(p[0] * S).toFixed(1)},${((1 - p[1]) * S).toFixed(1)}`;
  const fromEvent = (e: React.PointerEvent): UV => {
    const r = svgRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  };

  if (!o || o.type !== 'mesh' || !mesh)
    return (
      <div className="uved" data-testid="uv-editor">
        <p className="prop-hint">UV Editor: select a mesh object.</p>
      </div>
    );

  const apply = (uv: UV[][], commit: boolean) => {
    const cmd = { type: 'setMesh' as const, id: o.id, mesh: { ...mesh, uv } };
    if (commit) store.dispatch(cmd, { select: false });
    else store.preview(cmd);
  };
  const sel = edit ? edit.sel.faces : [];
  const xform = (fn: (p: UV, c: UV) => UV) => sel.length && apply(transformUv(mesh, sel, fn), true);

  return (
    <div className="uved" data-testid="uv-editor">
      <div className="uved-bar">
        <span className="graph-title">UV · {o.name}</span>
        <button className="tl-btn" data-testid="uv-unwrap" onClick={() => runAction(ctx, 'uv.smartProject')}>Smart UV Project</button>
        {hasUv && (
          <button className="tl-btn" onClick={() => runAction(ctx, 'uv.clear')}>
            Clear
          </button>
        )}
        {hasUv && edit && (
          <>
            <button className="tl-btn" disabled={!sel.length} data-testid="uv-scale-up" title="Scale the selected faces' UVs up" onClick={() => xform((p, c) => [c[0] + (p[0] - c[0]) * 1.25, c[1] + (p[1] - c[1]) * 1.25])}>
              ⤢ +
            </button>
            <button className="tl-btn" disabled={!sel.length} data-testid="uv-scale-down" title="Scale the selected faces' UVs down" onClick={() => xform((p, c) => [c[0] + (p[0] - c[0]) * 0.8, c[1] + (p[1] - c[1]) * 0.8])}>
              ⤡ −
            </button>
            <button className="tl-btn" disabled={!sel.length} data-testid="uv-rotate" title="Rotate the selected faces' UVs 90°" onClick={() => xform((p, c) => [c[0] - (p[1] - c[1]), c[1] + (p[0] - c[0])])}>
              ⟳ 90°
            </button>
            <button
              className="tl-btn"
              disabled={!sel.length}
              data-testid="uv-fit"
              title="Stretch the selected faces' UVs over the whole image"
              onClick={() => {
                const pts = sel.flatMap((f) => mesh.uv![f]);
                const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
                const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
                xform((p) => [(p[0] - x0) / Math.max(1e-6, x1 - x0), (p[1] - y0) / Math.max(1e-6, y1 - y0)]);
              }}
            >
              Fit to image
            </button>
          </>
        )}
      </div>
      {!hasUv ? (
        <p className="prop-hint">No UV map yet: the texture is projected from the sides. Press Smart UV Project (or U in Edit Mode) to unwrap.</p>
      ) : (
        <div className="uved-body">
          <svg
            ref={svgRef}
            className="uved-svg"
            viewBox={`0 0 ${S} ${S}`}
            data-testid="uv-canvas"
            onPointerDown={(e) => {
              if (!edit) return;
              const p = fromEvent(e);
              const hitFace = mesh.faces.findIndex((_, f) => inside(p, mesh.uv![f]));
              if (hitFace >= 0 && !selFaces.has(hitFace)) {
                // Tap an island face: select it (Shift / add-select keeps the others).
                const keep = e.shiftKey || store.getState().addSelect ? sel : [];
                const faces = [...keep, hitFace];
                store.setEdit({ ...edit, sel: convertMode(mesh, 'face', edit.mode, flush(mesh, 'face', { verts: [], edges: [], faces })) });
                return;
              }
              if (hitFace >= 0 && sel.length) {
                (e.target as Element).setPointerCapture?.(e.pointerId);
                drag.current = { start: p, base: mesh };
              }
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const p = fromEvent(e);
              const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
              apply(transformUv(d.base, sel, (q) => [q[0] + dx, q[1] + dy]), false);
            }}
            onPointerUp={() => {
              if (!drag.current) return;
              drag.current = null;
              store.commitPreview();
            }}
          >
            {img ? <image href={img} x={0} y={0} width={S} height={S} preserveAspectRatio="none" opacity={0.85} /> : <rect x={0} y={0} width={S} height={S} fill="url(#uv-checker)" />}
            <defs>
              <pattern id="uv-checker" width={S / 8} height={S / 8} patternUnits="userSpaceOnUse">
                <rect width={S / 8} height={S / 8} fill="#3a3a3a" />
                <rect width={S / 16} height={S / 16} fill="#4a4a4a" />
                <rect x={S / 16} y={S / 16} width={S / 16} height={S / 16} fill="#4a4a4a" />
              </pattern>
            </defs>
            <rect x={0} y={0} width={S} height={S} fill="none" stroke="#888" strokeWidth={2} />
            {mesh.faces.map((_, f) => (
              <polygon
                key={f}
                points={mesh.uv![f].map(toSvg).join(' ')}
                className={selFaces.has(f) ? 'uv-face sel' : 'uv-face'}
                data-uv-face={f}
              />
            ))}
          </svg>
          <p className="prop-hint">{edit ? 'Tap faces to select them (Shift adds), drag a selected island to move it.' : 'Tab into Edit Mode to select and move UVs.'}</p>
        </div>
      )}
    </div>
  );
}
