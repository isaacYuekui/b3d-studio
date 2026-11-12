import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Store } from './core/store';
import { loadLocal, parseScript, saveLocal } from './core/serialize';
import type { Viewport } from './engine/Viewport';
import { AppCtx, useApp } from './ui/context';
import { TopBar, MenuCtx } from './ui/TopBar';
import type { OpenMenu } from './ui/TopBar';
import { Menu, ADD_ITEMS } from './ui/Menu';
import type { MenuItem } from './ui/Menu';
import { ViewportPanel } from './ui/ViewportPanel';
import { MoveToCollectionMenu, Outliner } from './ui/Outliner';
import { Properties } from './ui/Properties';
import { Timeline } from './ui/Timeline';
import { Help } from './ui/Help';
import { ScriptDialog } from './ui/ScriptDialog';
import { LibraryDialog } from './ui/LibraryDialog';
import { VideoDialog } from './ui/VideoDialog';
import { WhatsNew } from './ui/WhatsNew';
import { Icon } from './ui/icons';
import { prepareCommands } from './ui/prepare';
import { runAction, shortcutFor } from './ui/actions';
import type { Ctx } from './ui/actions';

// ---------------------------------------------------------------- small helpers

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`b3d-ui:${key}`);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem(`b3d-ui:${key}`, JSON.stringify(nv));
      } catch {
        /* storage blocked */
      }
    },
    [key],
  );
  return [v, set];
}

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/** Drag handle that reports pixel deltas. */
function Resizer({ dir, onDelta, label }: { dir: 'v' | 'h'; onDelta: (d: number) => void; label: string }) {
  const last = useRef<number | null>(null);
  return (
    <div
      className={`resizer resizer-${dir}`}
      role="separator"
      aria-label={label}
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = dir === 'v' ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const cur = dir === 'v' ? e.clientX : e.clientY;
        onDelta(cur - last.current);
        last.current = cur;
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
    />
  );
}

function Panel({ title, open, onToggle, children, className, style }: { title: string; open: boolean; onToggle: () => void; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <section className={`panel ${className ?? ''}${open ? '' : ' collapsed'}`} style={open ? style : undefined}>
      <button className="panel-head" aria-expanded={open} onClick={onToggle}>
        <Icon.chevron open={open} />
        <span>{title}</span>
      </button>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}

function StatusBar() {
  const notice = useApp((s) => s.notice);
  const count = useApp((s) => s.doc.order.length);
  const tool = useApp((s) => s.tool);
  return (
    <footer className="statusbar" aria-live="polite">
      <span className="status-notice">{notice ?? `Tool: ${tool[0].toUpperCase()}${tool.slice(1)}`}</span>
      <span className="muted">{count} objects · autosaves in this browser · B3D Studio v3.20</span>
    </footer>
  );
}

// ---------------------------------------------------------------- app

type SheetTab = 'outliner' | 'properties' | 'timeline';

export function App() {
  const [hadSaved] = useState(() => {
    try {
      return !!localStorage.getItem('b3d-studio:autosave:v1');
    } catch {
      return false;
    }
  });
  const store = useMemo(() => {
    const saved = loadLocal();
    const s = new Store(saved ?? undefined);
    if (saved) s.notify('Restored your last session');
    return s;
  }, []);
  const vpRef = useRef<Viewport | null>(null);
  const [ask, setAsk] = useState<{ message: string; ok: string; resolve: (v: boolean) => void } | null>(null);
  const [script, setScript] = useState(false);
  const [library, setLibrary] = useState(false);
  const [video, setVideo] = useState(false);
  const ctx: Ctx = useMemo(
    () => ({
      store,
      viewport: () => vpRef.current,
      confirm: (message, ok) => new Promise<boolean>((resolve) => setAsk({ message, ok, resolve })),
      openScript: () => setScript(true),
      openLibrary: () => setLibrary(true),
      openVideo: () => setVideo(true),
    }),
    [store],
  );
  // Test/debug hook, only with ?debug in the URL.
  useEffect(() => {
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__b3d = {
        ...ctx,
        prepare: prepareCommands,
        parseScript,
        /** The video soundtrack for the timeline as a WAV blob (debug / tests). */
        soundtrack: async () => {
          const [{ soundEvents }, { renderSoundtrack, encodeWav }] = await Promise.all([import('./core/sound'), import('./engine/soundSynth')]);
          const doc = ctx.store.getState().doc;
          const a = doc.animation ?? { fps: 24, start: 1, end: 120 };
          const events = soundEvents(doc, a.start, a.end, a.fps);
          const buf = await renderSoundtrack(events, (a.end - a.start + 1) / a.fps);
          return { events, wav: buf ? encodeWav(buf) : null };
        },
      };
  }, [ctx]);
  const answer = (v: boolean) => {
    ask?.resolve(v);
    setAsk(null);
  };

  const compact = useMedia('(max-width: 759px)');
  const [sideW, setSideW] = usePersisted('sideW', 300);
  const [olH, setOlH] = usePersisted('olH', 220);
  const [olOpen, setOlOpen] = usePersisted('olOpen', true);
  const [propOpen, setPropOpen] = usePersisted('propOpen', true);
  const [tlOpen, setTlOpen] = usePersisted('tlOpen', true);
  const [sheet, setSheet] = useState<SheetTab | null>(null);
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number; title?: string } | null>(null);
  const [help, setHelp] = useState(false);
  const pointer = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

  const openMenu: OpenMenu = useCallback((items, x, y, title) => setMenu({ items, x, y, title }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Autosave (debounced) + notice auto-clear
  useEffect(() => {
    let saveT: number | undefined;
    let noticeT: number | undefined;
    let lastDoc = store.getState().doc;
    let lastNotice = store.getState().notice;
    if (lastNotice) noticeT = window.setTimeout(() => store.notify(null), 3500);
    return store.subscribe(() => {
      const s = store.getState();
      if (s.doc !== lastDoc) {
        lastDoc = s.doc;
        clearTimeout(saveT);
        saveT = window.setTimeout(() => saveLocal(store.getState().doc), 800);
      }
      if (s.notice !== lastNotice) {
        lastNotice = s.notice;
        clearTimeout(noticeT);
        if (s.notice) noticeT = window.setTimeout(() => store.notify(null), 3500);
      }
    });
  }, [store]);

  // Keyboard shortcuts
  useEffect(() => {
    const onMove = (e: PointerEvent) => (pointer.current = { x: e.clientX, y: e.clientY });
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.repeat && !['KeyZ', 'KeyY'].includes(e.code)) return;
      if (menu || ask || script || library || video) return; // menus/dialogs handle their own keys
      if (e.shiftKey && e.code === 'KeyA' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openMenu(ADD_ITEMS, pointer.current.x, pointer.current.y, 'Add');
        return;
      }
      if (e.key === '?' || e.code === 'F1') {
        setHelp((h) => !h);
        return;
      }
      if (help && e.key === 'Escape') {
        setHelp(false);
        return;
      }
      const id = shortcutFor(e, !!store.getState().edit);
      if (!id) return;
      e.preventDefault();
      runAction(ctx, id);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctx, menu, help, ask, script, library, video, openMenu]);

  const clampSide = (w: number) => Math.max(220, Math.min(w, Math.min(560, window.innerWidth - 320)));

  return (
    <AppCtx.Provider value={ctx}>
      <MenuCtx.Provider value={openMenu}>
        <div className={`app ${compact ? 'compact' : 'wide'}`}>
          <TopBar onHelp={() => setHelp(true)} />

          <div className="main">
            <ViewportPanel onReady={(v) => (vpRef.current = v)} />
            {!compact && (
              <>
                <Resizer dir="v" label="Resize sidebar" onDelta={(d) => setSideW(clampSide(sideW - d))} />
                <aside className="sidebar" style={{ width: clampSide(sideW) }}>
                  <Panel title="Outliner" open={olOpen} onToggle={() => setOlOpen(!olOpen)} className="panel-outliner" style={propOpen ? { height: olH, flex: 'none' } : undefined}>
                    <Outliner />
                  </Panel>
                  {olOpen && propOpen && <Resizer dir="h" label="Resize outliner" onDelta={(d) => setOlH(Math.max(90, Math.min(olH + d, window.innerHeight - 300)))} />}
                  <Panel title="Properties" open={propOpen} onToggle={() => setPropOpen(!propOpen)} className="panel-properties">
                    <Properties />
                  </Panel>
                </aside>
              </>
            )}
          </div>

          {!compact && (
            <Panel title="Timeline" open={tlOpen} onToggle={() => setTlOpen(!tlOpen)} className="panel-timeline">
              <Timeline />
            </Panel>
          )}

          {compact && (
            <>
              {sheet && (
                <div className="sheet" data-testid="sheet">
                  <div className="sheet-grip" onClick={() => setSheet(null)} aria-label="Close panel" role="button" />
                  <div className="sheet-body">
                    {sheet === 'outliner' && <Outliner />}
                    {sheet === 'properties' && <Properties />}
                    {sheet === 'timeline' && <Timeline />}
                  </div>
                </div>
              )}
              <nav className="tabbar" aria-label="Panels">
                {(['outliner', 'properties', 'timeline'] as SheetTab[]).map((t) => (
                  <button key={t} className={`tab${sheet === t ? ' active' : ''}`} data-tab={t} aria-pressed={sheet === t} onClick={() => setSheet(sheet === t ? null : t)}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </nav>
            </>
          )}

          <StatusBar />
          {menu && <Menu {...menu} onClose={closeMenu} />}
          {help && <Help onClose={() => setHelp(false)} />}
          <WhatsNew hasSavedWork={hadSaved} />
          {script && <ScriptDialog onClose={() => setScript(false)} />}
          {library && <LibraryDialog onClose={() => setLibrary(false)} />}
          {video && <VideoDialog onClose={() => setVideo(false)} />}
          <MoveToCollectionMenu />
          {ask && (
            <div className="modal-backdrop" onClick={() => answer(false)}>
              <div className="modal confirm" role="alertdialog" aria-label="Confirm" onClick={(e) => e.stopPropagation()}>
                <p>{ask.message}</p>
                <div className="prop-actions">
                  <button className="btn" autoFocus onClick={() => answer(false)}>Cancel</button>
                  <button className="btn primary" data-testid="confirm-ok" onClick={() => answer(true)}>{ask.ok}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </MenuCtx.Provider>
    </AppCtx.Provider>
  );
}
