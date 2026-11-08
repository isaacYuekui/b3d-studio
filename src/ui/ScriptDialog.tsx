import { useMemo, useState } from 'react';
import { parseScript } from '../core/serialize';
import type { Command } from '../core/commands';
import { prepareCommands } from './prepare';
import { useCtx } from './context';
import { pickFile } from './actions';

/** Bundled example scenes, loaded on demand (each is its own small chunk). */
const EXAMPLES: { id: string; label: string; load: () => Promise<{ default: string }> }[] = [
  { id: 'living-room', label: 'Living room: two people', load: () => import('../../examples/living-room.b3d-script.json?raw') },
  { id: 'character-walk', label: 'Mannequin walk cycle', load: () => import('../../examples/character-walk.b3d-script.json?raw') },
  { id: 'coffee-mug', label: 'Coffee mug (modelled)', load: () => import('../../examples/coffee-mug.b3d-script.json?raw') },
  { id: 'forest-supercar', label: 'Supercar in the pines', load: () => import('../../examples/forest-supercar.b3d-script.json?raw') },
  { id: 'car-studio', label: 'Supercar studio', load: () => import('../../examples/car-studio.b3d-script.json?raw') },
  { id: 'still-life', label: 'Morning still life', load: () => import('../../examples/still-life.b3d-script.json?raw') },
  { id: 'robot-studio', label: 'Robot in the studio', load: () => import('../../examples/robot-studio.b3d-script.json?raw') },
];

/**
 * Run Scene Script: paste (or open) a JSON script that Claude wrote in chat.
 * The whole script runs as one undoable step, and nothing changes if any command is invalid.
 */
export function ScriptDialog({ onClose }: { onClose: () => void }) {
  const ctx = useCtx();
  const [text, setText] = useState('');
  const [clear, setClear] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return { ok: true as const, value: parseScript(text) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [text]);

  const run = async () => {
    if (!parsed?.ok) return;
    const { store } = ctx;
    const script = parsed.value.command as { type: 'batch'; commands: Command[] };
    await prepareCommands(script.commands);
    const commands: Command[] = clear && store.getState().doc.order.length ? [{ type: 'delete', ids: [...store.getState().doc.order] }, ...script.commands] : script.commands;
    const before = store.getState().doc;
    store.dispatch({ type: 'batch', commands }, { select: false });
    if (store.getState().doc === before) {
      setRunError(store.getState().notice ?? 'The script did not change the scene.');
      return;
    }
    store.select(null);
    store.notify(`Ran script${parsed.value.title ? ` “${parsed.value.title}”` : ''}: ${parsed.value.count} commands (one undo step)`);
    onClose();
    // Frame once library models have loaded, so the shot includes them.
    const vp = ctx.viewport();
    void vp?.settle().then(() => vp.viewCamera() || vp.frame(true));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal script-modal" role="dialog" aria-label="Run scene script" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Run scene script</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="help-foot" style={{ marginTop: 0 }}>
          Paste a script Claude wrote for you in chat, or open a script file. It runs as one step, so a single Undo reverts it.
        </p>
        <div className="script-examples" role="group" aria-label="Examples">
          <span className="muted">Examples:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.id} className="chip" data-example={ex.id} onClick={async () => setText((await ex.load()).default)}>
              {ex.label}
            </button>
          ))}
        </div>
        <textarea
          id="script-text"
          className="script-text"
          data-testid="script-text"
          placeholder='{"format": "b3d-studio-script", "version": 1, "commands": [ … ]}'
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRunError(null);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className={`script-status${parsed && !parsed.ok ? ' bad' : ''}`} aria-live="polite">
          {!parsed && 'Waiting for a script.'}
          {parsed?.ok && `Ready: ${parsed.value.title ? `“${parsed.value.title}”, ` : ''}${parsed.value.count} commands.`}
          {parsed && !parsed.ok && parsed.error}
          {runError && <div className="bad">{runError}</div>}
        </div>
        <label className="script-clear">
          <input id="script-clear" type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} />
          Start from an empty scene
        </label>
        <div className="prop-actions">
          <button
            className="btn"
            onClick={async () => {
              const f = await pickFile();
              if (f) setText(await f.text());
            }}
          >
            Open file…
          </button>
          <button className="btn primary" data-testid="script-run" disabled={!parsed?.ok} onClick={() => void run()}>
            Run script
          </button>
        </div>
      </div>
    </div>
  );
}
