import { useRef, useState } from 'react';
import { useApp, useCtx } from './context';
import { animationOf } from '../core/animation';
import { downloadBlob } from './actions';

const PRESETS = [
  { id: 'landscape', label: 'Landscape 16:9', sub: 'YouTube', w: 1920, h: 1080 },
  { id: 'vertical', label: 'Vertical 9:16', sub: 'Shorts · TikTok · Reels', w: 1080, h: 1920 },
  { id: 'square', label: 'Square 1:1', sub: 'Feed posts', w: 1080, h: 1080 },
] as const;

/** Render the timeline to an MP4 file, frame by frame. */
export function VideoDialog({ onClose }: { onClose: () => void }) {
  const ctx = useCtx();
  const anim = useApp((s) => s.doc.animation);
  const hasCamera = useApp((s) => !!s.doc.camera || (s.doc.animation?.camera.length ?? 0) > 0);
  const { fps, start, end } = animationOf({ animation: anim });
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('landscape');
  const [draft, setDraft] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ url: string; name: string; size: number; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);
  const t0 = useRef(0);
  const p = PRESETS.find((x) => x.id === preset)!;
  const k = draft ? 2 / 3 : 1; // draft: 720p-class, renders ~2× faster
  const frames = end - start + 1;

  const render = async () => {
    const vp = ctx.viewport();
    if (!vp) return;
    setError(null);
    setResult(null);
    cancel.current = false;
    t0.current = performance.now();
    setProgress({ done: 0, total: frames });
    try {
      const out = await vp.renderVideo({ width: p.w * k, height: p.h * k, start, end, fps, onProgress: (done, total) => setProgress({ done, total }), isCancelled: () => cancel.current });
      if (out) {
        const name = `b3d-${preset}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
        setResult({ url: URL.createObjectURL(out.blob), name, size: out.blob.size, blob: out.blob });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const eta = progress && progress.done > 2 ? ((performance.now() - t0.current) / progress.done) * (progress.total - progress.done) / 1000 : null;

  return (
    <div className="modal-backdrop" onClick={() => !progress && onClose()}>
      <div className="modal video-modal" role="dialog" aria-label="Render video" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Render video</h2>
          {!progress && <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>}
        </div>

        {!progress && !result && (
          <>
            <div className="video-presets" role="radiogroup" aria-label="Format">
              {PRESETS.map((x) => (
                <button key={x.id} role="radio" aria-checked={preset === x.id} className={`video-preset${preset === x.id ? ' active' : ''}`} data-preset={x.id} onClick={() => setPreset(x.id)}>
                  <span className={`video-shape ${x.id}`} aria-hidden />
                  <b>{x.label}</b>
                  <span className="muted">{x.sub}</span>
                </button>
              ))}
            </div>
            <label className="script-clear">
              <input id="video-draft" type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Draft quality ({Math.round(p.w * k)}×{Math.round(p.h * k)}, renders faster)
            </label>
            <p className="help-foot">
              Frames {start}–{end} at {fps} fps: {(frames / fps).toFixed(1)} s of video, {Math.round(p.w * k)}×{Math.round(p.h * k)}.
              {hasCamera ? ' Rendered through the scene camera.' : ' No scene camera yet: the current view is used. Set one with Animation > Key Camera or View > Set Scene Camera.'}
              {' '}Change the length on the timeline (Start / End).
            </p>
            {error && <p className="script-status bad">{error}</p>}
            <div className="prop-actions" style={{ padding: 0 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" data-testid="video-render" onClick={() => void render()}>Render MP4</button>
            </div>
          </>
        )}

        {progress && (
          <div className="video-progress" aria-live="polite">
            <div className="video-bar"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
            <p>
              Frame {progress.done} of {progress.total}
              {eta !== null && ` · about ${eta < 60 ? `${Math.ceil(eta)} s` : `${Math.ceil(eta / 60)} min`} left`}
            </p>
            <p className="help-foot">Keep this tab open while it renders.</p>
            <button className="btn" onClick={() => (cancel.current = true)}>Stop</button>
          </div>
        )}

        {result && (
          <div className="video-result">
            <video src={result.url} controls playsInline muted loop autoPlay className={`video-preview ${preset}`} data-testid="video-preview" />
            <p className="help-foot">{result.name} · {result.size < 1e6 ? `${Math.max(1, Math.round(result.size / 1e3))} KB` : `${(result.size / 1e6).toFixed(1)} MB`}</p>
            <div className="prop-actions" style={{ padding: 0 }}>
              <button className="btn" onClick={() => setResult(null)}>Render again</button>
              <button className="btn primary" data-testid="video-save" onClick={() => downloadBlob(result.name, result.blob)}>Save video</button>
            </div>
            <p className="help-foot">
              Edit it in <a href="film/" target="_blank" rel="noopener">FilmCraft</a> (opens in a new tab): add music, titles and cuts.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
