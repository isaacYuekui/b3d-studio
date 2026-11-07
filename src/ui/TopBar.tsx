import { createContext, useContext } from 'react';
import type { MenuItem } from './Menu';
import { ADD_ITEMS } from './Menu';
import { useApp, useCtx } from './context';
import { runAction } from './actions';

export type OpenMenu = (items: MenuItem[], x: number, y: number, title?: string) => void;
export const MenuCtx = createContext<OpenMenu>(() => {});
export const useOpenMenu = () => useContext(MenuCtx);

const MENUS: { label: string; items: MenuItem[] }[] = [
  { label: 'File', items: ['file.new', '-', 'file.save', 'file.load', '-', 'file.import', 'file.export'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.duplicate', 'edit.delete', '-', 'edit.hide', 'edit.unhideAll', 'edit.deselect'] },
  { label: 'Add', items: ADD_ITEMS },
  {
    label: 'View',
    items: ['view.frameSelected', 'view.frameAll', '-', 'view.persp', 'view.front', 'view.back', 'view.right', 'view.left', 'view.top', 'view.bottom'],
  },
];

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const open = useOpenMenu();
  const ctx = useCtx();
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  return (
    <header className="topbar">
      <div className="brand" title="B3D Studio — independent project, not affiliated with Blender">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 20 20" width="16" height="16">
            <path d="M10 1.5 18 6v8l-8 4.5L2 14V6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M2 6l8 4.5L18 6M10 10.5V18.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="brand-name">B3D</span>
      </div>
      <nav className="menubar">
        {MENUS.map((m) => (
          <button
            key={m.label}
            className="menubar-btn"
            data-menu={m.label}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              open(m.items, r.left, r.bottom + 2);
            }}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <div className="workspaces" role="tablist" aria-label="Workspaces">
        <button className="ws-tab active" role="tab" aria-selected="true">
          Layout
        </button>
      </div>
      <div className="topbar-right">
        <button className="icon-btn" aria-label="Undo" title="Undo" disabled={!canUndo} onClick={() => runAction(ctx, 'edit.undo')}>
          <svg viewBox="0 0 20 20" width="18" height="18"><path d="M7 5 3 9l4 4M3.5 9H12a5 5 0 0 1 0 10h-2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="icon-btn" aria-label="Redo" title="Redo" disabled={!canRedo} onClick={() => runAction(ctx, 'edit.redo')}>
          <svg viewBox="0 0 20 20" width="18" height="18"><path d="m13 5 4 4-4 4M16.5 9H8a5 5 0 0 0 0 10h2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="icon-btn" aria-label="Keyboard shortcuts and help" title="Shortcuts & help" onClick={onHelp}>
          ?
        </button>
      </div>
    </header>
  );
}
