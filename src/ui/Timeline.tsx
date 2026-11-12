import { useEffect, useState } from 'react';
import { DopeSheet } from './DopeSheet';
import { GraphEditor } from './GraphEditor';
import { UVEditor } from './UVEditor';
import { useApp, useCtx } from './context';
import { Icon } from './icons';
import { NumberField } from './NumberField';
import { animationOf, keyFrames } from '../core/animation';
import { runAction } from './actions';

/**
 * Timeline: playhead, transport, frame range, and keyframe markers for the selected
 * object (orange) and the scene camera (blue). Playback runs at the scene's fps.
 */
export function Timeline() {
  const ctx = useCtx();
  const { store } = ctx;
  const frame = useApp((s) => s.frame);
  const playing = useApp((s) => s.playing);
  const anim = useApp((s) => s.doc.animation);
  const sel = useApp((s) => s.selection);
  const selName = useApp((s) => (s.selection ? s.doc.objects[s.selection]?.name : null));
  const cameraView = useApp((s) => s.cameraView);
  // Which animation editor shows under the timeline: none, the Dope Sheet or the Graph Editor.
  const [editor, setEditor] = useState<'' | 'sheet' | 'graph' | 'uv'>(() => {
    try {
      const v = localStorage.getItem('b3d.dopesheet');
      return v === '1' ? 'sheet' : v === 'graph' ? 'graph' : v === 'uv' ? 'uv' : '';
    } catch {
      return '';
    }
  });
  const showEditor = (which: 'sheet' | 'graph' | 'uv') => {
    const next = editor === which ? '' : which;
    setEditor(next);
    try {
      localStorage.setItem('b3d.dopesheet', next === 'sheet' ? '1' : next === 'graph' ? 'graph' : next === 'uv' ? 'uv' : '0');
    } catch {
      /* per session only */
    }
  };
  const sheet = editor === 'sheet';
  const graph = editor === 'graph';
  const toggleSheet = () => showEditor('sheet');
  const { fps, start, end, tracks, camera } = animationOf({ animation: anim });

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += now - last;
      last = now;
      const steps = Math.floor(acc / (1000 / fps));
      if (steps > 0) {
        acc -= steps * (1000 / fps);
        const f = store.getState().frame + steps;
        store.setFrame(f > end ? start + ((f - start) % (end - start + 1)) : Math.max(f, start));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, store, fps, start, end]);

  const span = Math.max(1, end - start);
  const pct = (f: number) => `${((Math.min(end, Math.max(start, f)) - start) / span) * 100}%`;
  const step = Math.max(1, Math.round(span / 10 / 5) * 5);
  const ticks: number[] = [];
  for (let f = Math.ceil(start / step) * step; f <= end; f += step) ticks.push(f);
  const objKeys = sel ? tracks[sel] ?? [] : [];
  const setRange = (patch: { start?: number; end?: number; fps?: number }) => store.dispatch({ type: 'setAnimation', ...patch }, { select: false });

  return (
    <div className="timeline">
      <div className="tl-transport">
        <button className="icon-btn" aria-label="Jump to start" onClick={() => store.setFrame(start)}>
          <Icon.first />
        </button>
        <button className="icon-btn" aria-label="Previous keyframe" title="Previous keyframe (↓)" onClick={() => runAction(ctx, 'anim.prevKey')}>◆‹</button>
        <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} data-testid="play" onClick={() => store.setPlaying(!playing)}>
          {playing ? <Icon.pause /> : <Icon.play />}
        </button>
        <button className="icon-btn" aria-label="Next keyframe" title="Next keyframe (↑)" onClick={() => runAction(ctx, 'anim.nextKey')}>›◆</button>
        <button className="icon-btn" aria-label="Jump to end" onClick={() => store.setFrame(end)}>
          <Icon.last />
        </button>
        <span className="tl-frame" aria-live="off">
          <span className="muted">Frame</span> <b>{frame}</b>
        </span>
        <div className="tl-keybtns">
          <button className="tl-btn" disabled={!sel} data-testid="tl-key" title="Insert keyframe for the selected object (I)" onClick={() => runAction(ctx, 'anim.insertKey')}>
            ◆ Key{selName ? ` ${selName}` : ''}
          </button>
          <button className="tl-btn cam" data-testid="tl-camkey" title="Save the current view as a camera keyframe" onClick={() => runAction(ctx, 'anim.cameraKey')}>
            ◆ Camera
          </button>
          <button className={`tl-btn${sheet ? ' on' : ''}`} aria-pressed={sheet} data-testid="tl-dopesheet" title="Dope Sheet: see, move, copy and retime every keyframe" onClick={toggleSheet}>
            ◆◆ Dope Sheet
          </button>
          <button className={`tl-btn${graph ? ' on' : ''}`} aria-pressed={graph} data-testid="tl-graph" title="Graph Editor: the selected object's animation as curves" onClick={() => showEditor('graph')}>
            〰 Graph
          </button>
          <button className={`tl-btn${editor === 'uv' ? ' on' : ''}`} aria-pressed={editor === 'uv'} data-testid="tl-uv" title="UV Editor: the selected mesh's UV map over its image" onClick={() => showEditor('uv')}>
            ▦ UV
          </button>
          <button className={`tl-btn${cameraView ? ' on' : ''}`} aria-pressed={cameraView} data-testid="tl-camview" title="Look through the scene camera (0)" onClick={() => (cameraView ? store.setCameraView(false) : runAction(ctx, 'view.camera'))}>
            🎥 Camera view
          </button>
        </div>
        <div className="tl-range">
          <NumberField label="Start" value={start} step={1} dragRate={0.5} onPreview={() => {}} onCommit={(v) => setRange({ start: Math.round(v) })} onCancel={() => {}} />
          <NumberField label="End" value={end} step={1} dragRate={0.5} onPreview={() => {}} onCommit={(v) => setRange({ end: Math.round(v) })} onCancel={() => {}} />
          <NumberField label="fps" value={fps} step={1} dragRate={0.1} onPreview={() => {}} onCommit={(v) => setRange({ fps: Math.min(240, Math.max(1, Math.round(v))) })} onCancel={() => {}} />
        </div>
      </div>
      <div className="tl-track">
        <div className="tl-ticks" aria-hidden>
          {ticks.map((f) => (
            <span key={f} style={{ left: pct(f) }}>{f}</span>
          ))}
        </div>
        <div className="tl-keys" aria-label="Keyframes">
          {camera.map((k) => (
            <button key={`c${k.frame}`} className="tl-diamond cam" style={{ left: pct(k.frame) }} title={`Camera key, frame ${k.frame}`} onClick={() => store.setFrame(k.frame)} />
          ))}
          {objKeys.map((k) => (
            <button key={`o${k.frame}`} className={`tl-diamond${k.frame === frame ? ' current' : ''}`} style={{ left: pct(k.frame) }} title={`${selName} key, frame ${k.frame}`} data-key-frame={k.frame} onClick={() => store.setFrame(k.frame)} />
          ))}
        </div>
        <input
          type="range"
          className="tl-slider"
          aria-label="Current frame"
          min={start}
          max={end}
          value={Math.min(end, Math.max(start, frame))}
          onChange={(e) => store.setFrame(Number(e.target.value))}
          style={{ ['--pct' as string]: pct(frame) }}
        />
      </div>
      {sheet && <DopeSheet />}
      {graph && <GraphEditor />}
      {editor === 'uv' && <UVEditor />}
      <div className="tl-foot muted">
        {(end - start + 1) / fps < 60 ? `${((end - start + 1) / fps).toFixed(1)} s` : `${Math.floor((end - start + 1) / fps / 60)} min ${Math.round(((end - start + 1) / fps) % 60)} s`} at {fps} fps
        {keyFrames(animationOf({ animation: anim }), null).length ? ` · ${Object.keys(tracks).length} animated object${Object.keys(tracks).length === 1 ? '' : 's'}${camera.length ? ', animated camera' : ''}` : ' · no animation yet: select an object and press ◆ Key'}
      </div>
    </div>
  );
}
