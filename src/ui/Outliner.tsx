import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCtx } from './context';
import { useOpenMenu } from './TopBar';
import { OBJECT_CONTEXT } from './Menu';
import { Icon, typeIcon } from './icons';
import type { SceneDoc } from '../core/types';
import type { Collection } from '../core/collections';
import { collectionsOf } from '../core/collections';

interface Row {
  id: string;
  depth: number;
  hasChildren: boolean;
}

/** Objects of one collection (null = Scene Collection) as a parent/child tree. */
function flatten(doc: SceneDoc, collapsed: Set<string>, coll: string | null): Row[] {
  const known = new Set(collectionsOf(doc).map((c) => c.id));
  const member = (id: string) => {
    const c = doc.objects[id].collection;
    return (c && known.has(c) ? c : null) === coll;
  };
  const kids = new Map<string | null, string[]>();
  for (const id of doc.order) {
    if (!member(id)) continue;
    const p = doc.objects[id].parentId;
    // A child whose parent is in another collection shows at the top of its own.
    const key = p && member(p) ? p : null;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key)!.push(id);
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

const newCollectionId = () => `coll-${Math.random().toString(36).slice(2, 8)}`;

export function Outliner() {
  const { store } = useCtx();
  const openMenu = useOpenMenu();
  const doc = useApp((s) => s.doc);
  const selection = useApp((s) => s.selection);
  const active = useApp((s) => s.activeCollection);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collMenu, setCollMenu] = useState<{ c: Collection; x: number; y: number } | null>(null);
  const cols = collectionsOf(doc);
  const groups = useMemo(() => [...cols.map((c) => ({ c, rows: flatten(doc, collapsed, c.id) })), { c: null, rows: flatten(doc, collapsed, null) }], [doc, collapsed, cols]);
  const press = useRef<number | undefined>(undefined);
  const activeId = active && cols.some((c) => c.id === active) ? active : null;

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const objectRow = ({ id, depth, hasChildren }: Row, base: number, dim: boolean) => {
    const o = doc.objects[id];
    const TypeIcon = typeIcon[o.type];
    const selected = id === selection;
    return (
      <div
        key={id}
        role="treeitem"
        aria-selected={selected}
        data-outliner-id={id}
        className={`ol-row${selected ? ' selected' : ''}${o.visible && !dim ? '' : ' hidden'}`}
        style={{ paddingLeft: 10 + (depth + base) * 16 }}
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
  };

  return (
    <div className="outliner" role="tree" aria-label="Outliner">
      <div
        className={`ol-row ol-collection${activeId === null ? ' active' : ''}`}
        data-collection-row=""
        onClick={() => store.setActiveCollection(null)}
        title="New objects go into the highlighted collection"
      >
        <Icon.chevron open />
        <span className="ol-coll-icon" aria-hidden>
          ▣
        </span>
        <span>Scene Collection</span>
        <button
          className="ol-eye ol-add"
          aria-label="New collection"
          title="New collection"
          data-testid="collection-add"
          onClick={(e) => {
            e.stopPropagation();
            const id = newCollectionId();
            store.dispatch({ type: 'addCollection', id }, { select: false });
            store.setActiveCollection(id);
          }}
        >
          +
        </button>
      </div>
      {doc.order.length === 0 && !cols.length && <div className="ol-empty">Empty scene — add an object from the + button or ⇧A.</div>}
      {groups.map(({ c, rows }) => {
        if (!c) return rows.map((r) => objectRow(r, 1, false));
        const key = `coll:${c.id}`;
        const open = !collapsed.has(key);
        return (
          <div key={c.id} role="group">
            <div
              className={`ol-row ol-coll-row${activeId === c.id ? ' active' : ''}${c.visible ? '' : ' hidden'}`}
              data-collection-row={c.id}
              style={{ paddingLeft: 26 }}
              onClick={() => store.setActiveCollection(c.id)}
              onDoubleClick={() => setRenaming(key)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCollMenu({ c, x: e.clientX, y: e.clientY });
              }}
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse') return;
                const { clientX, clientY } = e;
                press.current = window.setTimeout(() => setCollMenu({ c, x: clientX, y: clientY }), 550);
              }}
              onPointerUp={() => clearTimeout(press.current)}
              onPointerLeave={() => clearTimeout(press.current)}
              onPointerCancel={() => clearTimeout(press.current)}
            >
              <button
                className="ol-twisty"
                aria-label={open ? 'Collapse' : 'Expand'}
                style={{ visibility: rows.length ? 'visible' : 'hidden' }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(key);
                }}
              >
                <Icon.chevron open={open} />
              </button>
              <span className="ol-coll-icon coll" aria-hidden>
                ▤
              </span>
              {renaming === key ? (
                <input
                  className="ol-rename"
                  autoFocus
                  defaultValue={c.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                    e.stopPropagation();
                  }}
                  onBlur={(e) => {
                    if (renaming) store.dispatch({ type: 'setCollection', id: c.id, name: e.target.value }, { select: false });
                    setRenaming(null);
                  }}
                />
              ) : (
                <span className="ol-name">
                  {c.name} <span className="ol-count">{rows.length ? '' : '(empty)'}</span>
                </span>
              )}
              <button
                className="ol-eye"
                aria-label={c.visible ? `Hide collection ${c.name}` : `Show collection ${c.name}`}
                title={c.visible ? 'Hide in viewport' : 'Show in viewport'}
                data-collection-eye={c.id}
                onClick={(e) => {
                  e.stopPropagation();
                  store.dispatch({ type: 'setCollection', id: c.id, visible: !c.visible }, { select: false });
                }}
              >
                {c.visible ? <Icon.eye /> : <Icon.eyeOff />}
              </button>
              <button
                className={`ol-eye ol-cam${c.render ? '' : ' off'}`}
                aria-label={c.render ? `Leave ${c.name} out of renders` : `Include ${c.name} in renders`}
                title={c.render ? 'In renders (tap to leave out of videos)' : 'Left out of videos'}
                data-collection-render={c.id}
                onClick={(e) => {
                  e.stopPropagation();
                  store.dispatch({ type: 'setCollection', id: c.id, render: !c.render }, { select: false });
                }}
              >
                <CameraGlyph off={!c.render} />
              </button>
            </div>
            {open && rows.map((r) => objectRow(r, 2, !c.visible))}
          </div>
        );
      })}
      {collMenu && <div className="ol-menu-catch" onPointerDown={() => setCollMenu(null)} />}
      {collMenu && (
        <div className="menu" role="menu" style={{ left: Math.min(collMenu.x, window.innerWidth - 220), top: Math.min(collMenu.y, window.innerHeight - 220), position: 'fixed' }}>
          <div className="menu-title">{collMenu.c.name}</div>
          <MenuButton label="Select objects" onClick={() => {
            const first = doc.order.find((id) => doc.objects[id].collection === collMenu.c.id);
            if (first) store.select(first);
            setCollMenu(null);
          }} />
          <MenuButton label="Rename" onClick={() => {
            setRenaming(`coll:${collMenu.c.id}`);
            setCollMenu(null);
          }} />
          <div className="menu-sep" />
          <MenuButton testid="collection-delete" label="Delete (keep objects)" onClick={() => {
            store.dispatch({ type: 'removeCollection', id: collMenu.c.id }, { select: false });
            setCollMenu(null);
          }} />
          <MenuButton label="Delete with objects" onClick={() => {
            store.dispatch({ type: 'removeCollection', id: collMenu.c.id, deleteObjects: true }, { select: false });
            setCollMenu(null);
          }} />
          <MenuButton label="Cancel" onClick={() => setCollMenu(null)} />
        </div>
      )}
    </div>
  );
}

function MenuButton({ label, onClick, testid }: { label: string; onClick: () => void; testid?: string }) {
  return (
    <button className="menu-item" role="menuitem" data-testid={testid} onClick={onClick}>
      <span>{label}</span>
    </button>
  );
}

function CameraGlyph({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="4.5" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 7 L14.5 5 V11 L10.5 9 Z" fill="currentColor" />
      {off && <path d="M2 14 L14 2" stroke="currentColor" strokeWidth="1.4" />}
    </svg>
  );
}

/** Blender's M menu: move the selected object (and its children) to a collection. */
export function MoveToCollectionMenu() {
  const { store } = useCtx();
  const open = useApp((s) => s.moveMenu);
  const doc = useApp((s) => s.doc);
  const sel = useApp((s) => s.selection);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      store.setMoveMenu(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, store]);
  if (!open || !sel || !doc.objects[sel]) return null;
  const close = () => store.setMoveMenu(false);
  const move = (collection: string | null) => {
    store.dispatch({ type: 'moveToCollection', ids: [sel], collection }, { select: false });
    close();
  };
  const cur = doc.objects[sel].collection ?? null;
  return (
    <div className="modal-backdrop move-coll" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="menu move-coll-menu" role="menu" data-testid="move-collection-menu">
        <div className="menu-title">Move “{doc.objects[sel].name}” to collection</div>
        <button className={`menu-item${cur === null ? ' current' : ''}`} role="menuitem" data-move-to="" onClick={() => move(null)}>
          <span>▣ Scene Collection</span>
        </button>
        {collectionsOf(doc).map((c) => (
          <button key={c.id} className={`menu-item${cur === c.id ? ' current' : ''}`} role="menuitem" data-move-to={c.id} onClick={() => move(c.id)}>
            <span>▤ {c.name}</span>
          </button>
        ))}
        <div className="menu-sep" />
        <button
          className="menu-item"
          role="menuitem"
          data-move-to="new"
          onClick={() => {
            const id = newCollectionId();
            store.dispatch({ type: 'batch', commands: [{ type: 'addCollection', id }, { type: 'moveToCollection', ids: [sel], collection: id }] }, { select: false });
            store.setActiveCollection(id);
            close();
          }}
        >
          <span>+ New Collection</span>
        </button>
      </div>
    </div>
  );
}
