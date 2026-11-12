import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { actions, runAction } from './actions';
import type { Action, ActionId } from './actions';
import { useApp, useCtx } from './context';

export type MenuItem = ActionId | '-' | { label: string; items: MenuItem[] };

interface MenuProps {
  title?: string;
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

/** Popup menu used for top-bar menus, the context menu and Shift+A. */
export function Menu({ title, items, x, y, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  useApp((s) => s); // re-render so enabled states stay current

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    setPos({
      x: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // defer so the opening tap doesn't immediately close it
    const t = setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {title && <div className="menu-title">{title}</div>}
      {items.map((item, i) => {
        if (item === '-') return <div key={i} className="menu-sep" />;
        if (typeof item === 'object') {
          return (
            <div key={i} className="menu-sub">
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => setOpen(open === i ? null : i)}
                onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(i)}
              >
                <span>{item.label}</span>
                <span className="menu-kbd">▸</span>
              </button>
              {open === i && (
                <div className="menu-inline">
                  {item.items.map((sub, j) =>
                    sub === '-' || typeof sub === 'object' ? null : <Item key={j} id={sub} onDone={onClose} />,
                  )}
                </div>
              )}
            </div>
          );
        }
        return <Item key={i} id={item} onDone={onClose} />;
      })}
    </div>
  );
}

function Item({ id, onDone }: { id: ActionId; onDone: () => void }) {
  const ctx = useCtx();
  const a: Action = actions[id];
  const enabled = a.enabled ? a.enabled(ctx) : true;
  return (
    <button
      className="menu-item"
      role="menuitem"
      disabled={!enabled}
      data-action={id}
      onClick={() => {
        onDone();
        runAction(ctx, id);
      }}
    >
      <span>{a.label}</span>
      {a.shortcut && <span className="menu-kbd">{a.shortcut}</span>}
    </button>
  );
}

export const ADD_ITEMS: MenuItem[] = [
  'add.library',
  'file.importModel',
  '-',
  'add.cube', 'add.sphere', 'add.cylinder', 'add.cone', 'add.torus', 'add.capsule', 'add.plane',
  { label: 'Curve', items: ['add.curve.bezier', 'add.curve.circle', 'add.curve.path'] },
  '-', 'add.text', 'add.water', 'add.empty',
  { label: 'Force Field', items: ['add.field.blast', 'add.field.push', 'add.field.wind', 'add.field.vortex'] },
  { label: 'Town', items: ['add.town.village', 'add.town.town', 'add.town.city'] },
  { label: 'Light', items: ['add.pointLight', 'add.sunLight', 'add.spotLight'] },
];

export const MESH_ITEMS: MenuItem[] = [
  'mesh.extrude', 'mesh.inset', 'mesh.bevel', 'mesh.loopcut', 'mesh.subdivide', 'mesh.bridge', 'mesh.connect',
  '-', 'edit.duplicate', 'mesh.fill', 'mesh.merge', 'mesh.mergeDistance', 'mesh.separate', 'edit.delete', 'mesh.dissolve',
  { label: 'Deform', items: ['mesh.smoothVerts', 'mesh.shrinkFatten', 'mesh.toSphere'] },
  { label: 'Faces', items: ['mesh.poke', 'mesh.triangulate', 'mesh.trisToQuads'] },
  { label: 'UV', items: ['uv.smartProject', 'uv.clear'] },
  '-', 'mesh.recalc', 'mesh.flip', 'mesh.smooth', 'mesh.flat',
  '-', 'mod.mirrorX', 'mod.subdiv1', 'mod.subdiv2', 'mod.subdiv0', 'mod.apply',
];

export const SELECT_ITEMS: MenuItem[] = ['select.all', 'select.none', 'select.invert', '-', 'select.linked', 'select.loop', 'select.box', '-', 'select.vert', 'select.edge', 'select.face', '-', 'view.xray', 'edit.proportional', 'view.snap'];

export const EDIT_CONTEXT: MenuItem[] = [
  'mesh.extrude', 'mesh.inset', 'mesh.bevel', 'mesh.loopcut', 'mesh.subdivide', 'mesh.bridge', 'mesh.connect',
  '-', 'mesh.fill', 'mesh.merge', 'edit.delete', 'mesh.dissolve',
  { label: 'Deform', items: ['mesh.smoothVerts', 'mesh.shrinkFatten', 'mesh.toSphere'] },
  '-', { label: 'Select', items: SELECT_ITEMS }, 'mode.object',
];

export const OBJECT_CONTEXT: MenuItem[] = [
  'mode.enterEdit',
  '-',
  'anim.insertKey',
  'anim.deleteKey',
  '-',
  'edit.duplicate',
  'edit.delete',
  'edit.hide',
  'object.moveToCollection',
  '-',
  'mesh.smooth',
  'mesh.flat',
  { label: 'Modifiers', items: ['mod.mirrorX', 'mod.subdiv1', 'mod.subdiv2', 'mod.subdiv3', 'mod.subdiv0', 'mod.apply'] },
  { label: 'Quick Effects', items: ['quick.explode', 'quick.fire', 'quick.smoke', 'quick.float'] },
  '-',
  'view.frameSelected',
  '-',
  { label: 'Add', items: ADD_ITEMS },
];

export const EMPTY_CONTEXT: MenuItem[] = [{ label: 'Add', items: ADD_ITEMS }, 'edit.unhideAll', '-', 'view.frameAll', 'edit.undo', 'edit.redo'];
