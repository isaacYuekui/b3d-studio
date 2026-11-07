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
  'add.cube', 'add.sphere', 'add.cylinder', 'add.cone', 'add.torus', 'add.capsule', 'add.plane',
  '-', 'add.empty',
  { label: 'Light', items: ['add.pointLight', 'add.sunLight', 'add.spotLight'] },
];

export const OBJECT_CONTEXT: MenuItem[] = [
  'edit.duplicate',
  'edit.delete',
  'edit.hide',
  '-',
  'view.frameSelected',
  '-',
  { label: 'Add', items: ADD_ITEMS },
];

export const EMPTY_CONTEXT: MenuItem[] = [{ label: 'Add', items: ADD_ITEMS }, 'edit.unhideAll', '-', 'view.frameAll', 'edit.undo', 'edit.redo'];
