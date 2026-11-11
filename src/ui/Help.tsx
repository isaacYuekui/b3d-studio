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
  ['1 / 3 / 7', 'Front / right / top view (Ctrl/⌘ + numpad for opposite)'],
  ['5', 'Default perspective view'],
  ['0  ·  Ctrl/⌘ ⌥ 0', 'Scene camera view · save current view as scene camera'],
  ['.  ·  Home', 'Frame selected · frame all'],
  ['Space', 'Play / pause timeline'],
  ['I  ·  ⌥ I', 'Insert · delete keyframe at the current frame'],
  ['← →  ·  ⇧ ← →', 'Previous / next frame · start / end'],
  ['↓ ↑', 'Previous / next keyframe'],
  ['Z', 'Toggle Solid / Rendered shading'],
  [`${MOD} R`, 'Run a scene script'],
  ['⇧ L', 'Open the asset library'],
  [`⇧ ${MOD} I`, 'Import a 3D model (GLB, glTF or ZIP)'],
  [`${MOD} 1 / 2 / 3  ·  ${MOD} 0`, 'Subdivision Surface level · remove'],
];

const EDIT_KEYS: [string, string][] = [
  ['Tab', 'Edit Mode ↔ Object Mode'],
  ['1 / 2 / 3', 'Vertex / edge / face select'],
  ['A  ·  ⌥ A  ·  ' + MOD + ' I', 'Select all · none · invert'],
  ['⇧ click  ·  ⌥ click', 'Add to selection · select edge loop'],
  ['B  ·  L', 'Box select · select linked'],
  ['E  ·  I', 'Extrude · inset faces'],
  [`${MOD} B  ·  ${MOD} R`, 'Bevel · loop cut (select an edge first)'],
  ['M  ·  F  ·  X', 'Merge · make face · delete'],
  [`${MOD} X  ·  J`, 'Dissolve (no hole) · connect two vertices'],
  ['⌥ S  ·  ⇧ ⌥ S', 'Shrink/Fatten · To Sphere'],
  [`${MOD} T  ·  ⌥ J`, 'Triangulate · tris to quads'],
  ['⇧ D', 'Duplicate selected faces'],
  ['⇧ N  ·  ⌥ N', 'Recalculate · flip normals'],
  ['⌥ Z', 'X-ray (select through the mesh)'],
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
          <div>
            <Table title="Keyboard" rows={KEYS} />
            <Table title="Edit Mode (modelling)" rows={EDIT_KEYS} />
          </div>
          <div>
            <Table title="Mouse / trackpad" rows={MOUSE} />
            <Table title="Touch (iPad / phone)" rows={TOUCH} />
          </div>
        </div>
        <p className="help-foot">
          B3D Studio is an independent project inspired by professional desktop 3D tools. It is not affiliated with or endorsed by the Blender Foundation.
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
