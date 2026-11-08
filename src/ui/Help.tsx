import { MOD } from './actions';

const KEYS: [string, string][] = [
  ['W / G / R / S', 'Select / Move / Rotate / Scale tool'],
  ['⇧ A', 'Add object menu'],
  ['⇧ D', 'Duplicate'],
  ['X or Delete', 'Delete'],
  ['H  ·  ⌥ H', 'Hide selected · reveal all'],
  ['Esc', 'Select none'],
  [`${MOD} Z  ·  ⇧ ${MOD} Z`, 'Undo · redo'],
  [`${MOD} S  ·  ${MOD} O`, 'Save to browser · reload save'],
  [`${MOD} E  ·  ${MOD} I`, 'Export · import project file'],
  ['1 / 3 / 7', 'Front / right / top view (add Ctrl/⌘ for opposite)'],
  ['5', 'Default perspective view'],
  ['0  ·  Ctrl/⌘ ⌥ 0', 'Scene camera view · save current view as scene camera'],
  ['.  ·  Home', 'Frame selected · frame all'],
  ['Space', 'Play / pause timeline'],
  ['Z', 'Toggle Solid / Rendered shading'],
  [`${MOD} R`, 'Run a scene script'],
  ['⇧ L', 'Open the asset library'],
  [`⇧ ${MOD} I`, 'Import a 3D model (GLB, glTF or ZIP)'],
];

const MOUSE: [string, string][] = [
  ['Left click', 'Select'],
  ['Left drag', 'Orbit'],
  ['Middle drag or Ctrl/⌘ + left drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Right click', 'Context menu'],
];

const TOUCH: [string, string][] = [
  ['Tap', 'Select'],
  ['One-finger drag', 'Orbit'],
  ['Two-finger drag / pinch', 'Pan / zoom'],
  ['Long press', 'Context menu'],
  ['Drag a number field', 'Scrub value (tap to type)'],
];

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Shortcuts and help" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Shortcuts &amp; controls</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="help-grid">
          <Table title="Keyboard" rows={KEYS} />
          <div>
            <Table title="Mouse / trackpad" rows={MOUSE} />
            <Table title="Touch (iPad / phone)" rows={TOUCH} />
          </div>
        </div>
        <p className="help-foot">
          B3D Studio v0.1 is an independent project inspired by professional desktop 3D tools. It is not affiliated with or endorsed by the Blender Foundation.
          Coordinates use metres with Z up. Your scene autosaves in this browser.
        </p>
      </div>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="help-table">
      <h3>{title}</h3>
      {rows.map(([k, v]) => (
        <div key={k} className="help-row">
          <kbd>{k}</kbd>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
