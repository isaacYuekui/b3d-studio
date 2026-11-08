import { useEffect, useMemo, useState } from 'react';
import { loadCatalog, thumbUrl } from '../engine/library';
import { deleteUserModel, listUserModels, onUserModelsChanged } from '../engine/userModels';
import type { UserModelMeta } from '../engine/userModels';
import { Icon } from './icons';
import { runAction } from './actions';
import type { Catalog } from '../engine/library';
import { useCtx } from './context';
import { isRenderable } from '../core/types';

type Tab = 'mine' | 'models' | 'textures' | 'hdris';

export function useUserModels(): UserModelMeta[] {
  const [list, setList] = useState<UserModelMeta[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void listUserModels().then((l) => live && setList(l));
    load();
    const off = onUserModelsChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return list;
}

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

const TAB_LABEL: Record<Tab, string> = { models: 'Models', mine: 'My Models', textures: 'Materials', hdris: 'Skies' };

/** Browse the CC0 asset library: add models, apply photo materials, set the sky. */
export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const ctx = useCtx();
  const catalog = useCatalog();
  const mine = useUserModels();
  const [tab, setTab] = useState<Tab>('models');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const items = useMemo(() => {
    if (tab === 'mine') {
      const needle = q.trim().toLowerCase();
      return mine.filter((m) => !needle || m.name.toLowerCase().includes(needle)).map((m) => ({ id: m.id, name: m.name, categories: [] as string[] }));
    }
    if (!catalog) return [];
    const list = catalog[tab] as { id: string; name: string; categories: string[] }[];
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((a) => a.name.toLowerCase().includes(needle) || a.categories.some((c) => c.includes(needle))) : list;
  }, [catalog, tab, q, mine]);

  const pick = (id: string) => {
    const { store } = ctx;
    if (tab === 'models' || tab === 'mine') {
      const name = tab === 'mine' ? mine.find((m) => m.id === id)?.name : undefined;
      store.dispatch({ type: 'add', primitive: 'model', asset: id, ...(name ? { name } : {}) });
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
                {t === 'mine' ? <span className="muted"> {mine.length}</span> : catalog && <span className="muted"> {catalog[t].length}</span>}
              </button>
            ))}
          </div>
          <input id="lib-search" className="lib-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        {tab === 'textures' && <p className="help-foot lib-hint">Select a shape in the scene first, then tap a material to apply it.</p>}
        {tab === 'mine' && (
          <div className="lib-import">
            <p className="help-foot lib-hint">Models you import are stored on this device. Get free models from sites like Sketchfab (download as GLB, or glTF as a ZIP), then import the file here.</p>
            <button
              className="btn primary"
              data-testid="import-model-btn"
              onClick={() => {
                onClose();
                runAction(ctx, 'file.importModel');
              }}
            >
              Import 3D model…
            </button>
          </div>
        )}
        <div className="lib-grid" data-testid="lib-grid">
          {!catalog && <p className="muted">Loading library…</p>}
          {tab === 'mine' && items.length === 0 && <p className="muted">No imported models yet.</p>}
          {tab !== 'mine' && catalog && items.length === 0 && <p className="muted">{catalog[tab].length ? 'Nothing matches that search.' : 'The library is not installed in this build.'}</p>}
          {items.map((a) =>
            tab === 'mine' ? (
              <div key={a.id} className="lib-item lib-mine">
                <button className="lib-mine-add" data-asset={a.id} onClick={() => pick(a.id)} title={`Add ${a.name}`}>
                  <span className="lib-mine-icon"><Icon.model /></span>
                  <span>{a.name}</span>
                </button>
                {confirmDelete === a.id ? (
                  <button className="lib-mine-del confirm" onClick={() => void deleteUserModel(a.id).then(() => setConfirmDelete(null))}>Delete?</button>
                ) : (
                  <button className="lib-mine-del" aria-label={`Remove ${a.name} from this device`} onClick={() => setConfirmDelete(a.id)}>
                    <Icon.trash />
                  </button>
                )}
              </div>
            ) : (
              <button key={a.id} className="lib-item" data-asset={a.id} onClick={() => pick(a.id)} title={a.name}>
                <img src={thumbUrl(a.id)} alt="" loading="lazy" width={96} height={96} />
                <span>{a.name}</span>
              </button>
            ),
          )}
        </div>
        <p className="help-foot">{tab === 'mine' ? 'Check each model’s licence on the site you downloaded it from; many free models require crediting the artist.' : 'All library assets are CC0 from Poly Haven (polyhaven.com).'}</p>
      </div>
    </div>
  );
}
