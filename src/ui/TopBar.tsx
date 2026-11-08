import { createContext, useContext } from 'react';
import type { MenuItem } from './Menu';
import { ADD_ITEMS, MESH_ITEMS, SELECT_ITEMS } from './Menu';
import { useApp, useCtx } from './context';
import { runAction } from './actions';

export type OpenMenu = (items: MenuItem[], x: number, y: number, title?: string) => void;
export const MenuCtx = createContext<OpenMenu>(() => {});
export const useOpenMenu = () => useContext(MenuCtx);

const MENUS: { label: string; items: MenuItem[] }[] = [
  { label: 'File', items: ['file.new', '-', 'file.script', '-', 'file.save', 'file.load', '-', 'file.importModel', '-', 'file.import', 'file.export', 'file.glb', 'file.video'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.duplicate', 'edit.delete', '-', 'edit.hide', 'edit.unhideAll', 'edit.deselect'] },
  { label: 'Add', items: ADD_ITEMS },
  { label: 'Object', items: ['mode.edit', '-', 'mesh.smooth', 'mesh.flat', '-', 'mod.mirrorX', 'mod.subdiv1', 'mod.subdiv2', 'mod.subdiv3', 'mod.subdiv0', 'mod.apply'] },
  {
    label: 'Animation',
    items: ['anim.play', '-', 'anim.insertKey', 'anim.deleteKey', 'anim.clear', '-', 'anim.cameraKey', 'view.camera', '-', 'anim.prevKey', 'anim.nextKey', '-', 'file.video'],
  },
  {
    label: 'View',
    items: ['view.shading', '-', 'view.camera', 'view.setCamera', '-', 'view.frameSelected', 'view.frameAll', '-', 'view.persp', 'view.front', 'view.back', 'view.right', 'view.left', 'view.top', 'view.bottom'],
  },
];

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const open = useOpenMenu();
  const ctx = useCtx();
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const editing = useApp((s) => !!s.edit);
  // Edit mode swaps Add / Object for Blender's Select and Mesh menus.
  const menus = editing
    ? MENUS.flatMap((m) => (m.label === 'Add' ? [{ label: 'Select', items: SELECT_ITEMS }] : m.label === 'Object' ? [{ label: 'Mesh', items: MESH_ITEMS }] : [m]))
    : MENUS;
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
        {menus.map((m) => (
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
        <button className={`ws-tab${editing ? '' : ' active'}`} role="tab" aria-selected={!editing} data-ws="layout" onClick={() => editing && runAction(ctx, 'mode.object')}>
          Layout
        </button>
        <button className={`ws-tab${editing ? ' active' : ''}`} role="tab" aria-selected={editing} data-ws="modeling" onClick={() => !editing && runAction(ctx, 'mode.enterEdit')}>
          Modeling
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
