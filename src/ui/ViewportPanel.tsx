import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { Viewport } from '../engine/Viewport';
import { useApp, useCtx } from './context';
import { useOpenMenu } from './TopBar';
import { ADD_ITEMS, EDIT_CONTEXT, EMPTY_CONTEXT, OBJECT_CONTEXT } from './Menu';
import type { MenuItem } from './Menu';
import { runAction } from './actions';
import type { ActionId } from './actions';
import { Icon } from './icons';
import type { ToolMode } from '../core/store';
import { adjustLastOp, canEdit, clearLastOp, getLastOp, subscribeLastOp } from './editing';
import type { SelectMode } from '../core/mesh/select';
import { NumberField } from './NumberField';

const SELECT_MODES: { mode: SelectMode; label: string; key: string; icon: () => ReactElement; action: ActionId }[] = [
  { mode: 'vert', label: 'Vertex', key: '1', icon: Icon.vert, action: 'select.vert' },
  { mode: 'edge', label: 'Edge', key: '2', icon: Icon.edge, action: 'select.edge' },
  { mode: 'face', label: 'Face', key: '3', icon: Icon.face, action: 'select.face' },
];

const EDIT_TOOLS: { action: ActionId; label: string; icon: () => ReactElement }[] = [
  { action: 'mesh.extrude', label: 'Extrude (E)', icon: Icon.extrude },
  { action: 'mesh.inset', label: 'Inset Faces (I)', icon: Icon.inset },
  { action: 'mesh.bevel', label: 'Bevel (Ctrl/⌘ B)', icon: Icon.bevel },
  { action: 'mesh.loopcut', label: 'Loop Cut (Ctrl/⌘ R): select an edge first', icon: Icon.loopcut },
  { action: 'mesh.subdivide', label: 'Subdivide', icon: Icon.subdivide },
];

const TOOLS: { mode: ToolMode; label: string; key: string; icon: () => ReactElement }[] = [
  { mode: 'select', label: 'Select', key: 'W', icon: Icon.select },
  { mode: 'move', label: 'Move', key: 'G', icon: Icon.move },
  { mode: 'rotate', label: 'Rotate', key: 'R', icon: Icon.rotate },
  { mode: 'scale', label: 'Scale', key: 'S', icon: Icon.scale },
];

const VIEW_ITEMS: MenuItem[] = ['view.shading', '-', 'view.camera', 'view.setCamera', '-', 'view.persp', 'view.front', 'view.back', 'view.right', 'view.left', 'view.top', 'view.bottom', '-', 'view.frameSelected', 'view.frameAll'];

export function ViewportPanel({ onReady }: { onReady: (v: Viewport | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef<Viewport | null>(null);
  const ctx = useCtx();
  const openMenu = useOpenMenu();
  const tool = useApp((s) => s.tool);
  const selName = useApp((s) => (s.selection ? s.doc.objects[s.selection]?.name ?? null : null));
  const count = useApp((s) => s.doc.order.length);
  const shading = useApp((s) => s.shading);
  const edit = useApp((s) => s.edit);
  const posing = useApp((s) => s.pose);
  const xray = useApp((s) => s.xray);
  const snap = useApp((s) => s.snap);
  const prop = useApp((s) => s.proportional);
  const addSelect = useApp((s) => s.addSelect);
  const boxMode = useApp((s) => s.boxMode);
  const selEditable = useApp((s) => canEdit(s.selection ? s.doc.objects[s.selection] : null));
  const selArmature = useApp((s) => (s.selection ? s.doc.objects[s.selection]?.type === 'armature' : false));
  const counts = useApp((s) => {
    const e = s.edit;
    const m = e ? s.doc.objects[e.id]?.mesh : null;
    return e && m ? `${e.sel.verts.length}/${m.vertices.length} verts · ${e.sel.faces.length}/${m.faces.length} faces` : '';
  });
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let vp: Viewport | null = null;
    try {
      vp = new Viewport(canvas, ctx.store);
    } catch (e) {
      ctx.store.notify(`3D engine failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
    vpRef.current = vp;
    onReady(vp);
    return () => {
      onReady(null);
      vp?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context menu: right-click (mouse) or long-press (touch / pen).
  useEffect(() => {
    const canvas = canvasRef.current!;
    const openAt = (x: number, y: number) => {
      if (ctx.store.getState().edit) {
        openMenu(EDIT_CONTEXT, x, y, 'Mesh');
        return;
      }
      const id = vpRef.current?.pickClient(x, y) ?? null;
      if (id) ctx.store.select(id);
      openMenu(id ? OBJECT_CONTEXT : EMPTY_CONTEXT, x, y, id ? ctx.store.getState().doc.objects[id].name : 'Viewport');
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      openAt(e.clientX, e.clientY);
    };
    let timer: number | undefined;
    let start: { x: number; y: number; id: number } | null = null;
    let touches = 0;
    const cancel = () => {
      clearTimeout(timer);
      start = null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      touches++;
      if (touches > 1) return cancel(); // pinch / two-finger pan
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      timer = window.setTimeout(() => {
        if (start) openAt(start.x, start.y);
        start = null;
      }, 550);
    };
    const onMove = (e: PointerEvent) => {
      if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') touches = Math.max(0, touches - 1);
      cancel();
    };
    canvas.addEventListener('contextmenu', onContext);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      cancel();
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [ctx, openMenu]);

  const run = (id: ActionId) => runAction(ctx, id);

  return (
    <section className={`viewport${edit ? ' editing' : ''}`} aria-label="3D Viewport">
      <canvas ref={canvasRef} className="viewport-canvas" touch-action="none" tabIndex={-1} data-testid="viewport-canvas" />

      <div className="vp-header">
        <button
          className={`vp-mode${edit ? ' editing' : posing ? ' posing' : ''}`}
          data-testid="mode-toggle"
          aria-pressed={!!edit || !!posing}
          disabled={!edit && !posing && !selEditable && !selArmature}
          title={edit ? 'Back to Object Mode (Tab)' : posing ? 'Back to Object Mode (Tab)' : selArmature ? 'Pose Mode: pose the bones (Tab)' : 'Edit Mode: move vertices, edges and faces (Tab)'}
          onClick={() => run('mode.edit')}
        >
          {edit ? 'Edit Mode' : posing ? 'Pose Mode' : 'Object Mode'}
        </button>
        {posing && <span className="vp-info"><b data-testid="pose-bone">{posing.bone ?? 'Tap a bone'}</b></span>}
        {edit ? (
          <>
            <div className="seg" role="radiogroup" aria-label="Select mode">
              {SELECT_MODES.map((m) => (
                <button key={m.mode} role="radio" className={`tool-btn${edit.mode === m.mode ? ' active' : ''}`} aria-checked={edit.mode === m.mode} aria-label={`${m.label} select`} title={`${m.label} select (${m.key})`} data-select-mode={m.mode} onClick={() => run(m.action)}>
                  <m.icon />
                </button>
              ))}
            </div>
            <button className={`tool-btn${addSelect ? ' active' : ''}`} aria-pressed={addSelect} aria-label="Add to selection" title="Taps add to the selection (Shift + click)" data-testid="add-select" onClick={() => ctx.store.setAddSelect(!addSelect)}>
              <Icon.addSel />
            </button>
            <button className={`tool-btn${boxMode ? ' active' : ''}`} aria-pressed={boxMode} aria-label="Box select" title="Box select: drag a rectangle (B)" data-testid="box-select" onClick={() => run('select.box')}>
              <Icon.box />
            </button>
            <button className={`tool-btn${xray ? ' active' : ''}`} aria-pressed={xray} aria-label="X-ray" title="X-ray: see and select through the mesh (⌥ Z)" data-testid="xray" onClick={() => run('view.xray')}>
              <Icon.xray />
            </button>
            <button className={`tool-btn${prop.on ? ' active' : ''}`} aria-pressed={prop.on} aria-label="Proportional editing" title="Proportional editing: nearby vertices follow smoothly (O)" data-testid="proportional" onClick={() => run('edit.proportional')}>
              <Icon.proportional />
            </button>
            {prop.on && (
              <label className="vp-radius" title="How far the effect reaches">
                <span className="muted">Radius</span>
                <input type="number" min={0.01} max={100} step={0.1} value={prop.radius} aria-label="Proportional radius" data-testid="prop-radius" onChange={(e) => ctx.store.setProportional({ ...prop, radius: Number(e.target.value) || prop.radius })} />
              </label>
            )}
            <button className={`tool-btn${snap ? ' active' : ''}`} aria-pressed={snap} aria-label="Snapping" title="Snap: 0.25 m, 15°, 0.1 steps (⇧ Tab)" data-testid="snap" onClick={() => run('view.snap')}>
              <Icon.snap />
            </button>
            <span className="vp-info muted" data-testid="edit-counts">{counts}</span>
          </>
        ) : posing ? null : (
          <>
          <button className={`tool-btn${snap ? ' active' : ''}`} aria-pressed={snap} aria-label="Snapping" title="Snap: 0.25 m, 15°, 0.1 steps (⇧ Tab)" data-testid="snap" onClick={() => run('view.snap')}>
            <Icon.snap />
          </button>
          <span className="vp-info">
            {selName ? <b>{selName}</b> : <span className="muted">Nothing selected</span>}
            <span className="muted"> · {count} object{count === 1 ? '' : 's'}</span>
          </span>
          </>
        )}
      </div>

      {boxMode && edit && (
        <div
          className="box-capture"
          data-testid="box-capture"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
          }}
          onPointerMove={(e) => box && setBox({ ...box, x1: e.clientX, y1: e.clientY })}
          onPointerUp={(e) => {
            if (box) vpRef.current?.boxSelect(box, e.shiftKey || addSelect);
            setBox(null);
            ctx.store.setBoxMode(false);
          }}
          onPointerCancel={() => setBox(null)}
        >
          {box && (
            <div
              className="box-rect"
              style={(() => {
                const r = canvasRef.current!.getBoundingClientRect();
                return { left: Math.min(box.x0, box.x1) - r.left, top: Math.min(box.y0, box.y1) - r.top, width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) };
              })()}
            />
          )}
          {!box && <span className="box-hint">Drag to select</span>}
        </div>
      )}

      <LastOpPanel />

      <div className="toolshelf" role="toolbar" aria-label="Tools" aria-orientation="vertical">
        {TOOLS.map((t) => (
          <button
            key={t.mode}
            className={`tool-btn${tool === t.mode ? ' active' : ''}`}
            title={`${t.label} (${t.key})`}
            aria-label={t.label}
            aria-pressed={tool === t.mode}
            data-tool={t.mode}
            onClick={() => ctx.store.setTool(t.mode)}
          >
            <t.icon />
          </button>
        ))}
        {edit && (
          <>
            <div className="tool-sep" />
            {EDIT_TOOLS.map((t) => (
              <button key={t.action} className="tool-btn" title={t.label} aria-label={t.label.replace(/ \(.*$/, '')} data-edit-tool={t.action} onClick={() => run(t.action)}>
                <t.icon />
              </button>
            ))}
          </>
        )}
        <div className="tool-sep" />
        {!edit && (
        <button
          className="tool-btn"
          title="Add object (⇧ A)"
          aria-label="Add object"
          data-testid="add-btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(ADD_ITEMS, r.right + 6, r.top, 'Add');
          }}
        >
          <Icon.plus />
        </button>
        )}
        <button className="tool-btn" title="Duplicate (⇧ D)" aria-label="Duplicate" onClick={() => run('edit.duplicate')}>
          <Icon.dup />
        </button>
        <button className="tool-btn" title="Delete (X)" aria-label="Delete" onClick={() => run('edit.delete')}>
          <Icon.trash />
        </button>
        {!edit && <div className="tool-sep" />}
        {!edit && <button className="tool-btn" title="Library: real models, materials, skies (⇧ L)" aria-label="Library" data-testid="library-btn" onClick={() => run('add.library')}>
          <Icon.library />
        </button>}
        {!edit && (
          <button className="tool-btn" title={'Run scene script (Ctrl/⌘ R)'} aria-label="Run scene script" data-testid="script-btn" onClick={() => run('file.script')}>
            <Icon.script />
          </button>
        )}
      </div>

      <div className="vp-nav">
        <button
          className={`tool-btn${shading === 'solid' ? ' active' : ''}`}
          title="Solid shading (Z)"
          aria-label="Solid shading"
          aria-pressed={shading === 'solid'}
          data-shading="solid"
          onClick={() => ctx.store.setShading('solid')}
        >
          <Icon.solid />
        </button>
        <button
          className={`tool-btn${shading === 'rendered' ? ' active' : ''}`}
          title="Rendered shading: scene lights, materials, shadows (Z)"
          aria-label="Rendered shading"
          aria-pressed={shading === 'rendered'}
          data-shading="rendered"
          onClick={() => ctx.store.setShading('rendered')}
        >
          <Icon.render />
        </button>
        <div className="tool-sep-v" />
        <button
          className="tool-btn"
          title="Views"
          aria-label="Views"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(VIEW_ITEMS, r.left - 180, r.bottom + 6, 'View');
          }}
        >
          <Icon.views />
        </button>
        <button className="tool-btn" title="Frame selected (.)" aria-label="Frame selected" onClick={() => run('view.frameSelected')}>
          <Icon.frame />
        </button>
      </div>

      <div className="vp-axes" aria-hidden>
        <span className="ax ax-x">X</span>
        <span className="ax ax-y">Y</span>
        <span className="ax ax-z">Z up</span>
      </div>
    </section>
  );
}

/** Blender's "Adjust Last Operation": change the last mesh operator's settings after running it. */
function LastOpPanel() {
  const ctx = useCtx();
  const lo = useSyncExternalStore(subscribeLastOp, getLastOp);
  const doc = useApp((s) => s.doc);
  const editing = useApp((s) => !!s.edit);
  const [open, setOpen] = useState(true);
  if (!lo || !editing || doc !== lo.doc || !lo.op.params.length) return null;
  return (
    <div className="lastop" role="group" aria-label={`Adjust ${lo.op.label}`} data-testid="lastop">
      <button className="lastop-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon.chevron open={open} />
        <span>{lo.op.label}</span>
        <span className="lastop-x" role="button" aria-label="Close" onClick={(e) => (e.stopPropagation(), clearLastOp())}>✕</span>
      </button>
      {open &&
        lo.op.params.map((p) =>
          p.kind === 'bool' ? (
            <label key={p.key} className="lastop-check">
              <input type="checkbox" checked={!!lo.params[p.key]} data-param={p.key} onChange={(e) => adjustLastOp(ctx.store, { [p.key]: e.target.checked })} />
              {p.label}
            </label>
          ) : (
            <NumberField
              key={p.key}
              label={p.label}
              value={Number(lo.params[p.key])}
              step={p.step}
              dragRate={(p.step ?? 0.01) / (p.kind === 'int' ? 8 : 2)}
              suffix={p.suffix}
              onPreview={(v) => adjustLastOp(ctx.store, { [p.key]: clampParam(p, v) })}
              onCommit={(v) => adjustLastOp(ctx.store, { [p.key]: clampParam(p, v) })}
              onCancel={() => {}}
            />
          ),
        )}
    </div>
  );
}

function clampParam(p: { kind: string; min?: number; max?: number }, v: number) {
  let x = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
  if (p.kind === 'int') x = Math.round(x);
  return x;
}
