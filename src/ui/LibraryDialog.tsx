import { useEffect, useMemo, useState } from 'react';
import { loadCatalog, thumbUrl } from '../engine/library';
import type { Catalog } from '../engine/library';
import { useCtx } from './context';
import { isRenderable } from '../core/types';

type Tab = 'models' | 'textures' | 'hdris';

export function useCatalog(): Catalog | null {
  const [c, setC] = useState<Catalog | null>(null);
  useEffect(() => {
    let live = true;
    void loadCatalog().then((cat) => live && setC(cat));
    return () => {
      live = false;
    };
  }, []);
  return c;
}

const TAB_LABEL: Record<Tab, string> = { models: 'Models', textures: 'Materials', hdris: 'Skies' };

/** Browse the CC0 asset library: add models, apply photo materials, set the sky. */
export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const ctx = useCtx();
  const catalog = useCatalog();
  const [tab, setTab] = useState<Tab>('models');
  const [q, setQ] = useState('');

  const items = useMemo(() => {
    if (!catalog) return [];
    const list = catalog[tab] as { id: string; name: string; categories: string[] }[];
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((a) => a.name.toLowerCase().includes(needle) || a.categories.some((c) => c.includes(needle))) : list;
  }, [catalog, tab, q]);

  const pick = (id: string) => {
    const { store } = ctx;
    if (tab === 'models') {
      store.dispatch({ type: 'add', primitive: 'model', asset: id });
      onClose();
      return;
    }
    if (tab === 'hdris') {
      store.dispatch({ type: 'setWorld', world: { hdri: id, background: 'hdri' } });
      store.setShading('rendered');
      store.notify('Sky applied — showing Rendered view');
      onClose();
      return;
    }
    const sel = store.getState().selection;
    const o = sel ? store.getState().doc.objects[sel] : null;
    if (!o || !isRenderable(o.type) || o.type === 'model') {
      store.notify('Select a shape first (cube, plane, sphere…), then choose a material.');
      return;
    }
    store.dispatch({ type: 'setMaterial', id: o.id, material: { texture: id, baseColor: '#ffffff' } }, { select: false });
    store.setShading('rendered');
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal library-modal" role="dialog" aria-label="Asset library" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Library</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="lib-bar">
          <div className="lib-tabs" role="tablist">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`lib-tab${tab === t ? ' active' : ''}`} data-lib-tab={t} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
                {catalog && <span className="muted"> {catalog[t].length}</span>}
              </button>
            ))}
          </div>
          <input id="lib-search" className="lib-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        {tab === 'textures' && <p className="help-foot lib-hint">Select a shape in the scene first, then tap a material to apply it.</p>}
        <div className="lib-grid" data-testid="lib-grid">
          {!catalog && <p className="muted">Loading library…</p>}
          {catalog && items.length === 0 && <p className="muted">{catalog[tab].length ? 'Nothing matches that search.' : 'The library is not installed in this build.'}</p>}
          {items.map((a) => (
            <button key={a.id} className="lib-item" data-asset={a.id} onClick={() => pick(a.id)} title={a.name}>
              <img src={thumbUrl(a.id)} alt="" loading="lazy" width={96} height={96} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
        <p className="help-foot">All assets are CC0 from Poly Haven (polyhaven.com).</p>
      </div>
    </div>
  );
}
