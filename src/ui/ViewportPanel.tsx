import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Viewport } from '../engine/Viewport';
import { useApp, useCtx } from './context';
import { useOpenMenu } from './TopBar';
import { ADD_ITEMS, EMPTY_CONTEXT, OBJECT_CONTEXT } from './Menu';
import type { MenuItem } from './Menu';
import { runAction } from './actions';
import type { ActionId } from './actions';
import { Icon } from './icons';
import type { ToolMode } from '../core/store';

const TOOLS: { mode: ToolMode; label: string; key: string; icon: () => ReactElement }[] = [
  { mode: 'select', label: 'Select', key: 'W', icon: Icon.select },
  { mode: 'move', label: 'Move', key: 'G', icon: Icon.move },
  { mode: 'rotate', label: 'Rotate', key: 'R', icon: Icon.rotate },
  { mode: 'scale', label: 'Scale', key: 'S', icon: Icon.scale },
];

const VIEW_ITEMS: MenuItem[] = ['view.shading', '-', 'view.persp', 'view.front', 'view.back', 'view.right', 'view.left', 'view.top', 'view.bottom', '-', 'view.frameSelected', 'view.frameAll'];

export function ViewportPanel({ onReady }: { onReady: (v: Viewport | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef<Viewport | null>(null);
  const ctx = useCtx();
  const openMenu = useOpenMenu();
  const tool = useApp((s) => s.tool);
  const selName = useApp((s) => (s.selection ? s.doc.objects[s.selection]?.name ?? null : null));
  const count = useApp((s) => s.doc.order.length);
  const shading = useApp((s) => s.shading);

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
    <section className="viewport" aria-label="3D Viewport">
      <canvas ref={canvasRef} className="viewport-canvas" touch-action="none" tabIndex={-1} data-testid="viewport-canvas" />

      <div className="vp-header">
        <span className="vp-mode">Object Mode</span>
        <span className="vp-info">
          {selName ? <b>{selName}</b> : <span className="muted">Nothing selected</span>}
          <span className="muted"> · {count} object{count === 1 ? '' : 's'}</span>
        </span>
      </div>

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
        <div className="tool-sep" />
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
        <button className="tool-btn" title="Duplicate (⇧ D)" aria-label="Duplicate" onClick={() => run('edit.duplicate')}>
          <Icon.dup />
        </button>
        <button className="tool-btn" title="Delete (X)" aria-label="Delete" onClick={() => run('edit.delete')}>
          <Icon.trash />
        </button>
        <div className="tool-sep" />
        <button className="tool-btn" title="Library: real models, materials, skies (⇧ L)" aria-label="Library" data-testid="library-btn" onClick={() => run('add.library')}>
          <Icon.library />
        </button>
        <button className="tool-btn" title={'Run scene script (Ctrl/⌘ R)'} aria-label="Run scene script" data-testid="script-btn" onClick={() => run('file.script')}>
          <Icon.script />
        </button>
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
