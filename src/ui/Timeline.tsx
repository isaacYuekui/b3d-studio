import { useEffect } from 'react';
import { useApp, useCtx } from './context';
import { Icon } from './icons';

export const FRAME_START = 1;
export const FRAME_END = 250;
const FPS = 24;

/**
 * Timeline: frame cursor + playback transport. The scene has no keyframes yet
 * (animation system is a later milestone), so playback moves the playhead only.
 */
export function Timeline() {
  const { store } = useCtx();
  const frame = useApp((s) => s.frame);
  const playing = useApp((s) => s.playing);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += now - last;
      last = now;
      const steps = Math.floor(acc / (1000 / FPS));
      if (steps > 0) {
        acc -= steps * (1000 / FPS);
        const f = store.getState().frame + steps;
        store.setFrame(f > FRAME_END ? FRAME_START + ((f - FRAME_START) % (FRAME_END - FRAME_START + 1)) : f);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, store]);

  const pct = ((frame - FRAME_START) / (FRAME_END - FRAME_START)) * 100;
  const ticks = [];
  for (let f = 0; f <= FRAME_END; f += 25) if (f >= FRAME_START - 1) ticks.push(Math.max(f, FRAME_START));

  return (
    <div className="timeline">
      <div className="tl-transport">
        <button className="icon-btn" aria-label="Jump to start" onClick={() => store.setFrame(FRAME_START)}>
          <Icon.first />
        </button>
        <button className="icon-btn" aria-label={playing ? 'Pause' : 'Play'} data-testid="play" onClick={() => store.setPlaying(!playing)}>
          {playing ? <Icon.pause /> : <Icon.play />}
        </button>
        <button className="icon-btn" aria-label="Jump to end" onClick={() => store.setFrame(FRAME_END)}>
          <Icon.last />
        </button>
        <span className="tl-frame" aria-live="off">
          <span className="muted">Frame</span> <b>{frame}</b>
        </span>
        <span className="tl-range muted">
          {FRAME_START}–{FRAME_END} · {FPS} fps
        </span>
      </div>
      <div className="tl-track">
        <div className="tl-ticks" aria-hidden>
          {ticks.map((f) => (
            <span key={f} style={{ left: `${((f - FRAME_START) / (FRAME_END - FRAME_START)) * 100}%` }}>
              {f}
            </span>
          ))}
        </div>
        <input
          type="range"
          className="tl-slider"
          aria-label="Current frame"
          min={FRAME_START}
          max={FRAME_END}
          value={frame}
          onChange={(e) => store.setFrame(Number(e.target.value))}
          style={{ ['--pct' as string]: `${pct}%` }}
        />
      </div>
    </div>
  );
}
