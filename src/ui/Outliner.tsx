import { useMemo, useRef, useState } from 'react';
import { useApp, useCtx } from './context';
import { useOpenMenu } from './TopBar';
import { OBJECT_CONTEXT } from './Menu';
import { Icon, typeIcon } from './icons';
import type { SceneDoc } from '../core/types';

interface Row {
  id: string;
  depth: number;
  hasChildren: boolean;
}

function flatten(doc: SceneDoc, collapsed: Set<string>): Row[] {
  const kids = new Map<string | null, string[]>();
  for (const id of doc.order) {
    const p = doc.objects[id].parentId;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(id);
  }
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const id of kids.get(parent) ?? []) {
      const hasChildren = (kids.get(id)?.length ?? 0) > 0;
      out.push({ id, depth, hasChildren });
      if (hasChildren && !collapsed.has(id)) walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function Outliner() {
  const { store } = useCtx();
  const openMenu = useOpenMenu();
  const doc = useApp((s) => s.doc);
  const selection = useApp((s) => s.selection);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const rows = useMemo(() => flatten(doc, collapsed), [doc, collapsed]);
  const press = useRef<number | undefined>(undefined);

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="outliner" role="tree" aria-label="Outliner">
      <div className="ol-row ol-collection">
        <Icon.chevron open />
        <span className="ol-coll-icon" aria-hidden>▣</span>
        <span>Scene Collection</span>
      </div>
      {rows.length === 0 && <div className="ol-empty">Empty scene — add an object from the + button or ⇧A.</div>}
      {rows.map(({ id, depth, hasChildren }) => {
        const o = doc.objects[id];
        const TypeIcon = typeIcon[o.type];
        const selected = id === selection;
        return (
          <div
            key={id}
            role="treeitem"
            aria-selected={selected}
            data-outliner-id={id}
            className={`ol-row${selected ? ' selected' : ''}${o.visible ? '' : ' hidden'}`}
            style={{ paddingLeft: 10 + (depth + 1) * 16 }}
            onClick={() => store.select(id)}
            onDoubleClick={() => setRenaming(id)}
            onContextMenu={(e) => {
              e.preventDefault();
              store.select(id);
              openMenu(OBJECT_CONTEXT, e.clientX, e.clientY, o.name);
            }}
            onPointerDown={(e) => {
              if (e.pointerType === 'mouse') return;
              const { clientX, clientY } = e;
              press.current = window.setTimeout(() => {
                store.select(id);
                openMenu(OBJECT_CONTEXT, clientX, clientY, o.name);
              }, 550);
            }}
            onPointerUp={() => clearTimeout(press.current)}
            onPointerLeave={() => clearTimeout(press.current)}
            onPointerCancel={() => clearTimeout(press.current)}
          >
            <button
              className="ol-twisty"
              aria-label={hasChildren ? (collapsed.has(id) ? 'Expand' : 'Collapse') : undefined}
              style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
              onClick={(e) => {
                e.stopPropagation();
                toggle(id);
              }}
            >
              <Icon.chevron open={!collapsed.has(id)} />
            </button>
            <span className="ol-type">
              <TypeIcon />
            </span>
            {renaming === id ? (
              <input
                className="ol-rename"
                autoFocus
                defaultValue={o.name}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                  e.stopPropagation();
                }}
                onBlur={(e) => {
                  if (renaming) store.dispatch({ type: 'rename', id, name: e.target.value });
                  setRenaming(null);
                }}
              />
            ) : (
              <span className="ol-name">{o.name}</span>
            )}
            <button
              className="ol-eye"
              aria-label={o.visible ? `Hide ${o.name}` : `Show ${o.name}`}
              title={o.visible ? 'Hide' : 'Show'}
              onClick={(e) => {
                e.stopPropagation();
                store.dispatch({ type: 'setVisible', id, visible: !o.visible }, { select: false });
              }}
            >
              {o.visible ? <Icon.eye /> : <Icon.eyeOff />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
