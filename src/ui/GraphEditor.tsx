import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { useApp, useCtx } from './context';
import { NumberField } from './NumberField';
import { animationOf, EASINGS } from '../core/animation';
import type { Easing } from '../core/animation';
import { changingChannels, easingCmd, graphChannels, graphKeys, moveKeyCmd, sampleCurves, setKeyValue, valueRange } from '../core/graph';
import type { GraphTarget } from '../core/graph';
import type { SceneDoc } from '../core/types';

const EASING_LABEL: Record<Easing, string> = { constant: 'Constant', linear: 'Linear', ease: 'Bézier (ease in & out)', easeIn: 'Ease in', easeOut: 'Ease out' };
const H = 200;
const PAD = { l: 40, r: 12, t: 10, b: 20 };

interface Drag {
  frame: number;
  ch: number;
  x0: number;
  y0: number;
  v0: number;
  doc0: SceneDoc;
  axis: 'time' | 'value' | null;
  offset: number;
}

/**
 * Graph Editor: the selected object's animation (or, with nothing selected, the camera's) as
 * curves, one per channel. Drag a key sideways to retime it, up or down to change that channel's
 * value; pick how the curve leaves a key (Constant, Linear, Bézier, ease in / out).
 */
export function GraphEditor() {
  const { store } = useCtx();
  const doc = useApp((s) => s.doc);
  const frame = useApp((s) => s.frame);
  const selection = useApp((s) => s.selection);
  const anim = animationOf(doc);
  const target: GraphTarget | null = selection ? (anim.tracks[selection]?.length ? { kind: 'object', id: selection } : null) : anim.camera.length ? { kind: 'camera' } : null;
  const tKey = target ? (target.kind === 'camera' ? 'camera' : target.id) : '';

  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [tKey]);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [normalize, setNormalize] = useState(true);
  const [sel, setSel] = useState<{ frame: number; ch: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const chans = target ? graphChannels(target) : [];
  const keys = useMemo(() => (target ? graphKeys(doc, target) : []), [doc, tKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const moving = changingChannels(keys);
  const isShown = (i: number) => shown[`${tKey}:${chans[i].key}`] ?? (moving.some(Boolean) ? moving[i] : i < 3);
  const visible = chans.map((_, i) => i).filter(isShown);
  const visKey = visible.join(',');

  const f0 = Math.min(anim.start, keys[0]?.frame ?? anim.start);
  const f1 = Math.max(anim.end, keys[keys.length - 1]?.frame ?? anim.end, f0 + 1);
  const curves = useMemo(() => (target ? sampleCurves(doc, target, visible, f0, f1, Math.min(600, Math.max(100, w))) : []), [doc, tKey, visKey, f0, f1, w]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) {
    return (
      <div className="ds-empty muted" data-testid="graph-empty">
        {selection ? 'This object has no keyframes yet: move it and press ◆ Key at two frames to make a curve.' : 'Select an animated object to see its curves (with nothing selected, the camera’s curves show).'}
      </div>
    );
  }

  // Per-channel normalisation to −1…1 (Blender's Normalize), so metres, degrees and scale fit together.
  const norms = visible.map((c, i) => {
    const vals = [...curves[i].map(([, v]) => v), ...keys.map((k) => k.values[c])];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const half = (hi - lo) / 2;
    return { mid: (hi + lo) / 2, half: half > 1e-9 ? half : 0 };
  });
  const toN = (i: number, v: number) => (normalize ? (norms[i].half ? (v - norms[i].mid) / norms[i].half : 0) : v);
  const [ylo, yhi] = normalize ? [-1.15, 1.15] : valueRange(curves);
  const pw = Math.max(50, w - PAD.l - PAD.r), ph = H - PAD.t - PAD.b;
  const X = (f: number) => PAD.l + ((f - f0) / (f1 - f0)) * pw;
  const Y = (n: number) => PAD.t + (1 - (n - ylo) / (yhi - ylo)) * ph;
  const framesPerPx = (f1 - f0) / pw;
  const valuePerPx = (i: number) => ((yhi - ylo) / ph) * (normalize ? norms[i].half || 1 : 1);

  const onKeyDown = (e: RPointerEvent, kf: number, ch: number) => {
    e.stopPropagation();
    ((e.currentTarget as SVGGraphicsElement).ownerSVGElement ?? e.currentTarget).setPointerCapture?.(e.pointerId);
    const k = keys.find((x) => x.frame === kf)!;
    setSel({ frame: kf, ch });
    drag.current = { frame: kf, ch, x0: e.clientX, y0: e.clientY, v0: k.values[ch], doc0: store.getState().doc, axis: null, offset: 0 };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? 'time' : 'value';
    }
    const i = visible.indexOf(d.ch);
    if (d.axis === 'time') {
      const offset = Math.round(dx * framesPerPx);
      d.offset = offset;
      if (offset) store.preview(moveKeyCmd(target, d.frame, offset));
      else store.cancelPreview();
      setHint(`${offset > 0 ? '+' : ''}${offset} frames → ${d.frame + offset}`);
    } else {
      const v = Math.round((d.v0 - dy * valuePerPx(i)) * 1000) / 1000;
      const cmd = setKeyValue(d.doc0, target, d.frame, d.ch, v);
      if (cmd) store.preview(cmd);
      setHint(`${chans[d.ch].label}: ${v}${chans[d.ch].unit}`);
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setHint(null);
    if (!d) return;
    if (!d.axis) {
      store.setFrame(d.frame);
      return;
    }
    store.commitPreview();
    if (d.axis === 'time') setSel({ frame: d.frame + d.offset, ch: d.ch });
  };
  const onBgDown = (e: RPointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    store.setFrame(Math.round(f0 + (e.clientX - r.left - PAD.l) * framesPerPx));
    setSel(null);
  };

  const selKey = sel ? keys.find((k) => k.frame === sel.frame) : undefined;
  const ticks: number[] = [];
  const stepF = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000].find((s) => (s / (f1 - f0)) * pw >= 48) ?? 1000;
  for (let f = Math.ceil(f0 / stepF) * stepF; f <= f1; f += stepF) ticks.push(f);
  const gridVals = normalize ? [-1, 0, 1] : [ylo + (yhi - ylo) * 0.1, (ylo + yhi) / 2, yhi - (yhi - ylo) * 0.1];
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  const toggle = (i: number) => setShown({ ...shown, [`${tKey}:${chans[i].key}`]: !isShown(i) });
  const name = target.kind === 'camera' ? 'Camera' : doc.objects[target.id]?.name ?? '';

  return (
    <div className="graph" data-testid="graph">
      <div className="ds-tools">
        <span className="graph-title">{name}</span>
        <button className={`tl-btn${normalize ? ' on' : ''}`} aria-pressed={normalize} data-testid="graph-normalize" title="Scale every curve to −1…1 so they fit together" onClick={() => setNormalize(!normalize)}>
          Normalize
        </button>
        {selKey && sel ? (
          <>
            <span className="ds-count muted">Frame {sel.frame}</span>
            <div className="graph-value">
              <NumberField
                label={chans[sel.ch].label}
                value={Math.round(selKey.values[sel.ch] * 1000) / 1000}
                step={chans[sel.ch].unit === '°' ? 5 : 0.1}
                dragRate={chans[sel.ch].unit === '°' ? 0.5 : 0.01}
                suffix={chans[sel.ch].unit}
                onPreview={(v) => {
                  const c = setKeyValue(store.getState().doc, target, sel.frame, sel.ch, v);
                  if (c) store.preview(c);
                }}
                onCommit={(v) => {
                  const c = setKeyValue(store.getState().doc, target, sel.frame, sel.ch, v);
                  if (c) {
                    store.preview(c);
                    store.commitPreview();
                  }
                }}
                onCancel={() => store.cancelPreview()}
              />
            </div>
            <select aria-label="Interpolation after this key" data-testid="graph-easing" value={selKey.easing} onChange={(e) => store.dispatch(easingCmd(target, sel.frame, e.target.value as Easing), { select: false })}>
              {EASINGS.map((k) => (
                <option key={k} value={k}>{EASING_LABEL[k]}</option>
              ))}
            </select>
          </>
        ) : (
          <span className="ds-count muted">Tap a key ● · drag sideways to retime, up/down to change the value</span>
        )}
      </div>
      <div className="graph-body">
        <div className="graph-channels" role="group" aria-label="Curves shown">
          {chans.map((c, i) => (
            <button key={c.key} className={`graph-ch${isShown(i) ? ' on' : ''}`} aria-pressed={isShown(i)} data-graph-ch={c.key} onClick={() => toggle(i)} title={moving[i] ? `${c.label} changes` : `${c.label} stays the same`}>
              <i style={{ background: c.color }} />
              {c.label}
              {!moving[i] && <span className="muted"> ·</span>}
            </button>
          ))}
        </div>
        <div className="graph-plot" ref={box}>
          <svg width={w} height={H} onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => (store.cancelPreview(), (drag.current = null), setHint(null))} data-testid="graph-svg">
            <rect x={X(anim.start)} y={PAD.t} width={Math.max(0, X(anim.end) - X(anim.start))} height={ph} className="graph-range" />
            {ticks.map((f) => (
              <g key={f}>
                <line x1={X(f)} x2={X(f)} y1={PAD.t} y2={PAD.t + ph} className="graph-grid" />
                <text x={X(f)} y={H - 5} className="graph-tick" textAnchor="middle">{f}</text>
              </g>
            ))}
            {gridVals.map((v) => (
              <g key={v}>
                <line x1={PAD.l} x2={PAD.l + pw} y1={Y(v)} y2={Y(v)} className={`graph-grid${normalize && v === 0 ? ' zero' : ''}`} />
                <text x={PAD.l - 4} y={Y(v) + 3} className="graph-tick" textAnchor="end">{fmt(v)}</text>
              </g>
            ))}
            {visible.map((c, i) => (
              <polyline key={c} points={curves[i].map(([f, v]) => `${X(f).toFixed(1)},${Y(toN(i, v)).toFixed(1)}`).join(' ')} fill="none" stroke={chans[c].color} strokeWidth={sel?.ch === c ? 2.2 : 1.4} opacity={sel && sel.ch !== c ? 0.55 : 0.95} />
            ))}
            <line x1={X(frame)} x2={X(frame)} y1={PAD.t} y2={PAD.t + ph} className="graph-playhead" />
            {visible.map((c, i) =>
              keys.map((k) => {
                const on = sel?.frame === k.frame && sel.ch === c;
                return (
                  <g key={`${c}@${k.frame}`} className="graph-key" onPointerDown={(e) => onKeyDown(e, k.frame, c)} data-graph-key={`${chans[c].key}@${k.frame}`}>
                    <circle cx={X(k.frame)} cy={Y(toN(i, k.values[c]))} r={13} fill="transparent" />
                    <circle cx={X(k.frame)} cy={Y(toN(i, k.values[c]))} r={on ? 6 : 4.5} fill={on ? '#ffe680' : '#f2f2f2'} stroke={chans[c].color} strokeWidth={2} />
                  </g>
                );
              }),
            )}
          </svg>
          {hint && <div className="ds-hint">{hint}</div>}
        </div>
      </div>
    </div>
  );
}
