import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { useApp, useCtx } from './context';
import { animationOf, EASINGS } from '../core/animation';
import type { Easing } from '../core/animation';
import { channels } from '../core/dopesheet';
import type { KeyRef } from '../core/dopesheet';

const EASING_LABEL: Record<Easing, string> = { linear: 'Linear', ease: 'Ease in & out', easeIn: 'Ease in', easeOut: 'Ease out', constant: 'Constant (hold)' };
const id = (r: KeyRef) => `${r.channel}@${r.frame}`;
const parse = (s: string): KeyRef => {
  const at = s.lastIndexOf('@');
  return { channel: s.slice(0, at), frame: Number(s.slice(at + 1)) };
};

/**
 * Dope Sheet: every keyframe in the scene, one row per channel (Summary, Camera, objects,
 * armature poses). Tap a diamond to select it (or turn on "Add" to pick several), drag to
 * move, and use the buttons to duplicate, retime, delete or change easing.
 */
export function DopeSheet() {
  const { store } = useCtx();
  const doc = useApp((s) => s.doc);
  const frame = useApp((s) => s.frame);
  const { start, end } = animationOf(doc);
  const rows = useMemo(() => channels(doc), [doc]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [add, setAdd] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; offset: number; moved: boolean; hit: string; was: boolean } | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  // Forget selected keys that no longer exist (after undo, delete, another edit…).
  const live = useMemo(() => {
    const all = new Set(rows.flatMap((r) => r.frames.map((f) => `${r.key}@${f}`)));
    return new Set([...sel].filter((k) => all.has(k)));
  }, [rows, sel]);

  const span = Math.max(1, end - start);
  const lo = Math.min(start, ...rows.flatMap((r) => r.frames));
  const hi = Math.max(end, ...rows.flatMap((r) => r.frames));
  const vStart = Math.min(start, lo), vSpan = Math.max(span, hi - vStart);
  const pct = (f: number) => `${((f - vStart) / vSpan) * 100}%`;
  const framesPerPx = () => vSpan / Math.max(1, (grid.current?.clientWidth ?? 600) - 18);

  const edit = (cmd: Record<string, unknown>, keys = [...live].map(parse)) => {
    if (!keys.length) return;
    store.dispatch({ type: 'editKeys', keys, ...cmd } as never, { select: false });
  };
  const moveSel = (offset: number) => {
    if (!offset) return;
    edit({ op: 'move', offset });
    setSel(new Set([...live].map((k) => { const r = parse(k); return id({ ...r, frame: r.frame + offset }); })));
  };

  const onDiamondDown = (e: RPointerEvent, key: string) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const extend = add || e.shiftKey;
    const was = live.has(key);
    if (!was) setSel(extend ? new Set([...live, key]) : new Set([key]));
    setDrag({ x0: e.clientX, offset: 0, moved: false, hit: key, was });
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const offset = Math.round((e.clientX - drag.x0) * framesPerPx());
    if (offset !== drag.offset || (!drag.moved && Math.abs(e.clientX - drag.x0) > 4)) setDrag({ ...drag, offset, moved: drag.moved || Math.abs(e.clientX - drag.x0) > 4 });
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.moved && d.offset) moveSel(d.offset);
    else if (!d.moved) {
      // A tap: jump to the key; without "Add", a tap on a selected key selects just it, a tap
      // with "Add" on a selected key unselects it.
      store.setFrame(parse(d.hit).frame);
      if (add && d.was) {
        const n = new Set(live);
        n.delete(d.hit);
        setSel(n);
      } else if (!add) setSel(new Set([d.hit]));
    }
  };
  const onGridDown = (e: RPointerEvent) => {
    // Empty space: move the playhead there and (without Add) clear the selection.
    const r = grid.current!.getBoundingClientRect();
    const f = Math.round(vStart + ((e.clientX - r.left - 9) / (r.width - 18)) * vSpan);
    store.setFrame(Math.max(-100000, f));
    if (!add) setSel(new Set());
  };

  if (!rows.length) return <div className="ds-empty muted">No keyframes yet. Select an object, move it, and press ◆ Key at different frames.</div>;

  const n = live.size;
  const first = n ? Math.min(...[...live].map((k) => parse(k).frame)) : 0;
  const easings = new Set([...live].map((k) => {
    const r = parse(k);
    const a = doc.animation!;
    if (r.channel === 'camera') return a.camera.find((x) => x.frame === r.frame)?.easing;
    if (r.channel.startsWith('obj:')) return a.tracks[r.channel.slice(4)]?.find((x) => x.frame === r.frame)?.easing;
    return undefined;
  }).filter(Boolean));

  return (
    <div className="dopesheet" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
      <div className="ds-tools">
        <button className={`tl-btn${add ? ' on' : ''}`} aria-pressed={add} data-testid="ds-add" title="Tap several keys to select them together" onClick={() => setAdd(!add)}>＋ Add</button>
        <button className="tl-btn" data-testid="ds-all" onClick={() => setSel(new Set(rows.filter((r) => r.kind !== 'summary').flatMap((r) => r.frames.map((f) => `${r.key}@${f}`))))}>All</button>
        <span className="ds-count muted">{n ? `${n} selected` : 'Tap a ◆'}</span>
        <select
          aria-label="Easing of selected keys"
          data-testid="ds-easing"
          disabled={!n}
          value={easings.size === 1 ? [...easings][0] : ''}
          onChange={(e) => edit({ op: 'easing', easing: e.target.value })}
        >
          <option value="" disabled>Easing…</option>
          {EASINGS.map((k) => (
            <option key={k} value={k}>{EASING_LABEL[k]}</option>
          ))}
        </select>
        <button className="tl-btn" disabled={!n} data-testid="ds-dup" title="Copy the selected keys so the first one lands on the playhead" onClick={() => {
          const offset = frame - first;
          if (!offset) return store.notify('Move the playhead to where the copy should start');
          edit({ op: 'duplicate', offset });
          setSel(new Set([...live].map((k) => { const r = parse(k); return id({ ...r, frame: r.frame + offset }); })));
        }}>Copy to playhead</button>
        <button className="tl-btn" disabled={!n} title="Move the selected keys one frame earlier" onClick={() => moveSel(-1)}>−1</button>
        <button className="tl-btn" disabled={!n} title="Move the selected keys one frame later" onClick={() => moveSel(1)}>+1</button>
        <button className="tl-btn" disabled={n < 2} data-testid="ds-slower" title="Stretch the selected keys: twice as slow" onClick={() => edit({ op: 'scale', factor: 2, pivot: first })}>Slower ×2</button>
        <button className="tl-btn" disabled={n < 2} title="Squash the selected keys: twice as fast" onClick={() => edit({ op: 'scale', factor: 0.5, pivot: first })}>Faster ×½</button>
        <button className="tl-btn danger" disabled={!n} data-testid="ds-delete" onClick={() => { edit({ op: 'delete' }); setSel(new Set()); }}>Delete</button>
      </div>
      <div className="ds-body">
        <div className="ds-labels">
          {rows.map((r) => (
            <div key={r.key} className={`ds-label ${r.kind}`} title={r.label}>{r.label}</div>
          ))}
        </div>
        <div className="ds-grid" ref={grid} onPointerDown={onGridDown} data-testid="ds-grid">
          <div className="ds-playhead" style={{ left: `calc(9px + (100% - 18px) * ${(frame - vStart) / vSpan})` }} />
          {start > vStart && <div className="ds-out" style={{ left: 0, width: `calc(9px + (100% - 18px) * ${(start - vStart) / vSpan})` }} />}
          {rows.map((r) => (
            <div key={r.key} className={`ds-row ${r.kind}`}>
              {r.frames.map((f) => {
                const k = `${r.key}@${f}`;
                const selected = live.has(k) || (r.kind === 'summary' && rows.some((o) => o.kind !== 'summary' && live.has(`${o.key}@${f}`)));
                const shift = drag?.moved && live.has(k) ? drag.offset : 0;
                return (
                  <button
                    key={f}
                    className={`ds-key${selected ? ' sel' : ''}${f === frame ? ' current' : ''}`}
                    style={{ left: pct(f + shift) }}
                    data-ds-key={k}
                    aria-label={`${r.label} key at frame ${f}${selected ? ', selected' : ''}`}
                    aria-pressed={selected}
                    onPointerDown={(e) => onDiamondDown(e, k)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {drag?.moved && drag.offset !== 0 && <div className="ds-hint">{drag.offset > 0 ? '+' : ''}{drag.offset} frames</div>}
    </div>
  );
}
