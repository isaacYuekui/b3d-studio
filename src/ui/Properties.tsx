import { useState } from 'react';
import type { ReactNode } from 'react';
import { useApp, useCtx } from './context';
import { NumberField } from './NumberField';
import { Icon } from './icons';
import { subtree } from '../core/commands';
import type { Command } from '../core/commands';
import type { LightType, Vec3 } from '../core/types';
import { isRenderable } from '../core/types';
import { runAction } from './actions';
import { useCatalog, useUserModels } from './LibraryDialog';
import { guessUnitScale, isUserAsset } from '../engine/userModels';
import { TIMES } from '../core/sky';
import type { TimeOfDay } from '../core/sky';
import { worldOf } from '../core/types';
import { EASINGS, isAnimated, transformAt, transformEdit } from '../core/animation';
import type { Easing } from '../core/animation';
import type { Background } from '../core/types';
import { canEdit, setSmooth, setSubdivision, togglePose } from './editing';
import { poseAt, poseEdit } from '../core/rig';
import { transformVerts } from '../core/mesh/ops';
import { centroid } from '../core/mesh/topology';

const AXES = ['x', 'y', 'z'] as const;

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="prop-section">
      <button className="prop-section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon.chevron open={open} />
        {title}
      </button>
      {open && <div className="prop-section-body">{children}</div>}
    </div>
  );
}

export function Properties() {
  const ctx = useCtx();
  const { store } = ctx;
  const doc = useApp((s) => s.doc);
  const sel = useApp((s) => s.selection);
  const frame = useApp((s) => s.frame);
  const o = sel ? doc.objects[sel] : null;
  const catalog = useCatalog();

  // Every field edit goes through preview+commit so scrubs and typed values are one undo step each.
  const commit = (cmd: Command) => {
    store.preview(cmd);
    store.commitPreview();
  };

  if (!o) {
    return (
      <div className="properties">
        <div className="prop-tabs">
          <span className="prop-tab active">Scene</span>
        </div>
        <Section title="Scene">
          <div className="prop-row"><span>Objects</span><b>{doc.order.length}</b></div>
          <div className="prop-row"><span>Hidden</span><b>{doc.order.filter((id) => !doc.objects[id].visible).length}</b></div>
          <div className="prop-row"><span>Units</span><b>Metres, Z up</b></div>
          <p className="prop-hint">Select an object in the viewport or Outliner to edit its properties.</p>
        </Section>
        <WorldSection />
      </div>
    );
  }

  // Animated objects show (and edit, via auto-key) their pose at the current frame.
  const shown = transformAt(doc, o.id, frame) ?? o.transform;
  const animated = isAnimated(doc, o.id);

  const vecField = (key: 'position' | 'rotation' | 'scale', label: string, opts: { step: number; rate: number; suffix?: string }) => (
    <Section title={label}>
      <div className="vec3">
        {AXES.map((ax, i) => {
          const make = (v: number): Command => {
            const next = [...shown[key]] as Vec3;
            next[i] = v;
            return transformEdit(doc, frame, o.id, { [key]: next });
          };
          return (
            <NumberField
              key={ax}
              axis={ax}
              label={ax.toUpperCase()}
              value={+shown[key][i].toFixed(4)}
              step={opts.step}
              dragRate={opts.rate}
              suffix={opts.suffix}
              onPreview={(v) => store.preview(make(v))}
              onCommit={(v) => commit(make(v))}
              onCancel={() => store.cancelPreview()}
            />
          );
        })}
      </div>
    </Section>
  );

  const scalar = (label: string, value: number, min: number, max: number, make: (v: number) => Command, step = 0.01) => (
    <NumberField
      key={label}
      label={label}
      value={value}
      step={step}
      dragRate={step}
      onPreview={(v) => store.preview(make(Math.min(max, Math.max(min, v))))}
      onCommit={(v) => commit(make(Math.min(max, Math.max(min, v))))}
      onCancel={() => store.cancelPreview()}
    />
  );

  // Valid parents: anything not in this object's own subtree.
  const forbidden = new Set(subtree(doc, o.id));
  const parentOptions = doc.order.filter((id) => !forbidden.has(id));

  return (
    <div className="properties" data-testid="properties">
      <div className="prop-tabs">
        <span className="prop-tab active">Object</span>
      </div>
      <div className="prop-name-row">
        <input
          key={o.id + o.name}
          className="prop-name"
          aria-label="Object name"
          data-testid="prop-name"
          defaultValue={o.name}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) => store.dispatch({ type: 'rename', id: o.id, name: e.target.value })}
        />
      </div>

      <EditSection />

      {vecField('position', 'Location', { step: 0.1, rate: 0.01, suffix: ' m' })}
      {vecField('rotation', 'Rotation', { step: 1, rate: 0.5, suffix: '°' })}
      {vecField('scale', 'Scale', { step: 0.1, rate: 0.005 })}

      <AnimationSection id={o.id} animated={animated} />

      <Section title="Relations">
        <label className="prop-row">
          <span>Parent</span>
          <select
            value={o.parentId ?? ''}
            aria-label="Parent"
            onChange={(e) => store.dispatch({ type: 'setParent', id: o.id, parentId: e.target.value || null }, { select: false })}
          >
            <option value="">None</option>
            {parentOptions.map((id) => (
              <option key={id} value={id}>
                {doc.objects[id].name}
              </option>
            ))}
          </select>
        </label>
      </Section>

      {o.type === 'model' && <ModelSection id={o.id} />}

      {canEdit(o) && <ModifiersSection id={o.id} />}

      {o.type === 'armature' && <PoseSection id={o.id} />}

      {isRenderable(o.type) && o.type !== 'model' && (
        <Section title="Material">
          <label className="prop-row">
            <span>Texture</span>
            <select
              id="mat-texture"
              aria-label="Texture"
              value={o.material.texture ?? ''}
              onChange={(e) =>
                store.dispatch({ type: 'setMaterial', id: o.id, material: e.target.value ? { texture: e.target.value, baseColor: '#ffffff' } : { texture: null } }, { select: false })
              }
            >
              <option value="">None (plain colour)</option>
              {catalog?.textures.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          {o.material.texture && scalar('Repeat', o.material.textureScale, 0.01, 1000, (v) => ({ type: 'setMaterial', id: o.id, material: { textureScale: v } }), 0.1)}
          <label className="prop-row">
            <span>Base Color</span>
            <input
              type="color"
              id="mat-base"
              aria-label="Base color"
              value={o.material.baseColor}
              onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, material: { baseColor: e.target.value } })}
              onBlur={() => store.commitPreview()}
            />
          </label>
          {scalar('Metallic', o.material.metallic, 0, 1, (v) => ({ type: 'setMaterial', id: o.id, material: { metallic: v } }))}
          {scalar('Roughness', o.material.roughness, 0, 1, (v) => ({ type: 'setMaterial', id: o.id, material: { roughness: v } }))}
          {scalar('Alpha', o.material.alpha, 0, 1, (v) => ({ type: 'setMaterial', id: o.id, material: { alpha: v } }))}
          <label className="prop-row">
            <span>Emission</span>
            <input
              type="color"
              id="mat-emission"
              aria-label="Emission color"
              value={o.material.emission}
              onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, material: { emission: e.target.value, emissionStrength: o.material.emissionStrength || 1 } })}
              onBlur={() => store.commitPreview()}
            />
          </label>
          {scalar('Strength', o.material.emissionStrength, 0, 100, (v) => ({ type: 'setMaterial', id: o.id, material: { emissionStrength: v } }), 0.1)}
        </Section>
      )}

      {o.light && (
        <Section title="Light">
          <label className="prop-row">
            <span>Type</span>
            <select id="light-type" aria-label="Light type" value={o.light.type} onChange={(e) => store.dispatch({ type: 'setLight', id: o.id, light: { type: e.target.value as LightType } }, { select: false })}>
              <option value="point">Point</option>
              <option value="sun">Sun</option>
              <option value="spot">Spot</option>
            </select>
          </label>
          <label className="prop-row">
            <span>Color</span>
            <input
              type="color"
              id="light-color"
              aria-label="Light color"
              value={o.light.color}
              onChange={(e) => store.preview({ type: 'setLight', id: o.id, light: { color: e.target.value } })}
              onBlur={() => store.commitPreview()}
            />
          </label>
          {o.light.type === 'sun'
            ? scalar('Strength', o.light.power, 0, 100, (v) => ({ type: 'setLight', id: o.id, light: { power: v } }), 0.1)
            : scalar('Power (W)', o.light.power, 0, 100000, (v) => ({ type: 'setLight', id: o.id, light: { power: v } }), 10)}
          {o.light.type === 'spot' && scalar('Spot Size °', o.light.spotAngle, 1, 179, (v) => ({ type: 'setLight', id: o.id, light: { spotAngle: v } }), 1)}
          <label className="prop-row">
            <span>Shadows</span>
            <input type="checkbox" checked={o.light.shadows} onChange={(e) => store.dispatch({ type: 'setLight', id: o.id, light: { shadows: e.target.checked } }, { select: false })} />
          </label>
          <p className="prop-hint">Lights take effect in Rendered shading (Z). Point lights do not cast shadows yet.</p>
        </Section>
      )}

      <Section title="Object">
        <label className="prop-row">
          <span>Visible</span>
          <input type="checkbox" checked={o.visible} onChange={(e) => store.dispatch({ type: 'setVisible', id: o.id, visible: e.target.checked }, { select: false })} />
        </label>
        <div className="prop-row"><span>Type</span><b style={{ textTransform: 'capitalize' }}>{o.type}</b></div>
        {o.mesh && <div className="prop-row"><span>Geometry</span><b>{o.mesh.vertices.length} verts · {o.mesh.faces.length} faces</b></div>}
      </Section>

      <div className="prop-actions">
        <button className="btn" onClick={() => runAction(ctx, 'edit.duplicate')}>
          <Icon.dup /> Duplicate
        </button>
        <button className="btn danger" onClick={() => runAction(ctx, 'edit.delete')}>
          <Icon.trash /> Delete
        </button>
      </div>
    </div>
  );
}

const TIME_LABEL: Record<TimeOfDay, string> = { sunrise: 'Sunrise', morning: 'Morning', noon: 'Noon', afternoon: 'Late afternoon', sunset: 'Sunset', dusk: 'Dusk', night: 'Night (moon)', overcast: 'Overcast', misty: 'Misty morning' };

/** Scene-wide look for Rendered shading: HDRI sky, exposure, bloom, ambient occlusion. */
function WorldSection() {
  const { store } = useCtx();
  const raw = useApp((s) => s.doc.world); // stable reference; worldOf() fills defaults
  const w = worldOf({ objects: {}, order: [], world: raw });
  const shading = useApp((s) => s.shading);
  const catalog = useCatalog();
  const set = (world: Partial<typeof w>) => store.dispatch({ type: 'setWorld', world }, { select: false });
  const num = (label: string, value: number, min: number, max: number, key: 'strength' | 'rotation' | 'exposure' | 'bloom' | 'fog', step: number) => (
    <NumberField
      key={key}
      label={label}
      value={value}
      step={step}
      dragRate={step}
      onPreview={(v) => store.preview({ type: 'setWorld', world: { [key]: Math.min(max, Math.max(min, v)) } })}
      onCommit={(v) => {
        store.preview({ type: 'setWorld', world: { [key]: Math.min(max, Math.max(min, v)) } });
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  return (
    <Section title="World">
      <label className="prop-row">
        <span>Time of day</span>
        <select
          id="world-time"
          aria-label="Time of day"
          value={w.time ?? ''}
          onChange={(e) => {
            if (!e.target.value) return set({ time: undefined });
            store.dispatch({ type: 'setTimeOfDay', time: e.target.value as TimeOfDay }, { select: false });
            if (store.getState().shading !== 'rendered') store.setShading('rendered');
          }}
        >
          <option value="">Custom</option>
          {TIMES.map((t) => (
            <option key={t} value={t}>{TIME_LABEL[t]}</option>
          ))}
        </select>
      </label>
      <label className="prop-row">
        <span>Sky (HDRI)</span>
        <select id="world-hdri" aria-label="Sky" value={w.hdri ?? ''} onChange={(e) => set({ hdri: e.target.value || null, ...(e.target.value && w.background === 'color' ? { background: 'hdri' as Background } : {}) })}>
          <option value="">Neutral studio</option>
          {catalog?.hdris.map((h) => (
            <option key={h.id} value={h.id}>{h.name}</option>
          ))}
        </select>
      </label>
      {w.hdri && (
        <label className="prop-row">
          <span>Background</span>
          <select id="world-bg" aria-label="Background" value={w.background} onChange={(e) => set({ background: e.target.value as Background })}>
            <option value="hdri">Sky</option>
            <option value="blurred">Blurred sky</option>
            <option value="color">Solid colour</option>
          </select>
        </label>
      )}
      {(!w.hdri || w.background === 'color') && (
        <label className="prop-row">
          <span>Colour</span>
          <input type="color" id="world-color" aria-label="Background colour" value={w.color} onChange={(e) => store.preview({ type: 'setWorld', world: { color: e.target.value } })} onBlur={() => store.commitPreview()} />
        </label>
      )}
      {num('Strength', w.strength, 0, 100, 'strength', 0.05)}
      {w.hdri && num('Rotation °', w.rotation, -3600, 3600, 'rotation', 1)}
      {num('Exposure', w.exposure, 0, 20, 'exposure', 0.05)}
      {num('Bloom', w.bloom, 0, 1, 'bloom', 0.01)}
      {num('Haze (m, 0 = off)', w.fog, 0, 100000, 'fog', 10)}
      <label className="prop-row">
        <span>Ambient occlusion</span>
        <input type="checkbox" checked={w.ao} onChange={(e) => set({ ao: e.target.checked })} />
      </label>
      {shading !== 'rendered' && (
        <button className="btn" onClick={() => store.setShading('rendered')}>Show Rendered view</button>
      )}
    </Section>
  );
}

/** Library or imported model: source, and its real-world size (longest side) as an editable value. */
function ModelSection({ id }: { id: string }) {
  const { store } = useCtx();
  const o = useApp((s) => s.doc.objects[id]);
  const catalog = useCatalog();
  const mine = useUserModels();
  if (!o?.asset) return null;
  const user = isUserAsset(o.asset);
  let base = 0; // longest side in metres at scale 1
  let label = o.asset;
  if (user) {
    const m = mine.find((x) => x.id === o.asset);
    label = m?.name ?? 'Imported model (not on this device)';
    if (m?.min && m.max) {
      const longest = Math.max(...m.max.map((v, i) => v - m.min![i]));
      base = longest * guessUnitScale(longest);
    }
  } else {
    const c = catalog?.models.find((x) => x.id === o.asset);
    if (c) {
      label = c.name;
      base = Math.max(...c.size);
    }
  }
  const k = Math.max(...o.transform.scale.map(Math.abs));
  const ratio = o.transform.scale.map((v) => v / (k || 1)) as Vec3;
  const make = (len: number): Command => {
    const f = Math.max(0.001, len) / base;
    return { type: 'transform', id: o.id, scale: ratio.map((r) => +(r * f).toFixed(5)) as Vec3 };
  };
  return (
    <Section title="Model">
      <div className="prop-row"><span>Source</span><b className="prop-ellipsis" title={label}>{label}</b></div>
      {base > 0 && (
        <NumberField
          label="Size (longest side, m)"
          value={+(base * k).toFixed(3)}
          step={0.05}
          dragRate={0.01}
          onPreview={(v) => store.preview(make(v))}
          onCommit={(v) => {
            store.preview(make(v));
            store.commitPreview();
          }}
          onCancel={() => store.cancelPreview()}
        />
      )}
      <p className="prop-hint">
        {user
          ? 'Imported on this device. Units are converted to metres automatically; type a size above to match the real object (a supercar is about 4.5 m long).'
          : 'A scanned model from the library, with its own photo materials. CC0 from Poly Haven.'}
      </p>
    </Section>
  );
}

const EASING_LABEL: Record<Easing, string> = { linear: 'Linear', ease: 'Ease in & out', easeIn: 'Ease in', easeOut: 'Ease out', constant: 'Hold (jump)' };

/** Keyframes of the selected object: insert/delete at the current frame, and the easing into the next key. */
function AnimationSection({ id, animated }: { id: string; animated: boolean }) {
  const { store } = useCtx();
  const frame = useApp((s) => s.frame);
  const keys = useApp((s) => s.doc.animation?.tracks[id]);
  const key = keys?.find((k) => k.frame === frame);
  return (
    <Section title="Animation" defaultOpen={animated}>
      <div className="prop-row">
        <span>Keyframes</span>
        <b>{keys?.length ? `${keys.length} (frames ${keys[0].frame}–${keys[keys.length - 1].frame})` : 'None'}</b>
      </div>
      {key && (
        <label className="prop-row">
          <span>Easing to next key</span>
          <select id="key-easing" aria-label="Easing to next key" value={key.easing} onChange={(e) => store.dispatch({ type: 'setKeyframe', id, frame, transform: key.transform, easing: e.target.value as Easing }, { select: false })}>
            {EASINGS.map((e) => (
              <option key={e} value={e}>{EASING_LABEL[e]}</option>
            ))}
          </select>
        </label>
      )}
      <div className="prop-actions" style={{ padding: 0 }}>
        <button className="btn" data-testid="insert-key" onClick={() => store.dispatch({ type: 'setKeyframe', id, frame }, { select: false })}>
          ◆ {key ? 'Update' : 'Insert'} key at {frame}
        </button>
        {key && (
          <button className="btn danger" onClick={() => store.dispatch({ type: 'deleteKeyframe', id, frame }, { select: false })}>
            Delete key
          </button>
        )}
      </div>
      <p className="prop-hint">
        {animated
          ? 'Moving this object now saves a key at the current frame automatically.'
          : 'Insert a key, go to another frame, move the object, and insert another key. Play (Space) to see it move.'}
      </p>
    </Section>
  );
}

/** Edit mode: what is selected, and its median point (editable, local coordinates like Blender). */
function EditSection() {
  const { store } = useCtx();
  const edit = useApp((s) => s.edit);
  const mesh = useApp((s) => (s.edit ? s.doc.objects[s.edit.id]?.mesh : undefined));
  if (!edit || !mesh) return null;
  const n = edit.sel.verts.length;
  const median = n ? centroid(mesh.vertices, edit.sel.verts) : null;
  // Moves the selection so its median lands on the typed value (one undo step per edit).
  const moveTo = (axis: number, v: number, base = mesh) => {
    const c = centroid(base.vertices, edit.sel.verts);
    const d = v - c[axis];
    return { type: 'setMesh' as const, id: edit.id, mesh: transformVerts(base, edit.sel.verts, (p) => p.map((x, i) => (i === axis ? x + d : x)) as Vec3) };
  };
  return (
    <Section title="Edit Mode">
      <div className="prop-row"><span>Vertices</span><b data-testid="edit-verts">{n} / {mesh.vertices.length}</b></div>
      <div className="prop-row"><span>Edges</span><b>{edit.sel.edges.length}</b></div>
      <div className="prop-row"><span>Faces</span><b data-testid="edit-faces">{edit.sel.faces.length} / {mesh.faces.length}</b></div>
      {median && (
        <div className="vec3" aria-label="Median of the selection, local coordinates">
          <div className="prop-sub">Median (local)</div>
          {AXES.map((ax, i) => (
            <NumberField
              key={ax}
              label={ax.toUpperCase()}
              axis={ax}
              value={median[i]}
              step={0.1}
              dragRate={0.01}
              suffix=" m"
              onPreview={(v) => store.preview(moveTo(i, v))}
              onCommit={(v) => {
                store.preview(moveTo(i, v));
                store.commitPreview();
              }}
              onCancel={() => store.cancelPreview()}
            />
          ))}
        </div>
      )}
      <p className="prop-hint">Tap to select, Shift or the ⊞ button to add. Move with the gizmo, or use Extrude, Inset, Bevel, Loop Cut on the left.</p>
    </Section>
  );
}

/** Shading and modifiers (Mirror, Subdivision Surface) for shapes and meshes. */
function ModifiersSection({ id }: { id: string }) {
  const { store } = useCtx();
  const o = useApp((s) => s.doc.objects[id]);
  const smooth = o.mesh?.smooth ?? false;
  const mods = o.modifiers ?? {};
  const levels = mods.subdivision?.levels ?? 0;
  const mirror = mods.mirror;
  const setMirror = (axis: 'x' | 'y' | 'z', on: boolean) => {
    const m = { x: false, y: false, z: false, clip: true, ...mirror, [axis]: on };
    store.dispatch({ type: 'setModifiers', id, modifiers: { mirror: m.x || m.y || m.z ? m : null } }, { select: false });
  };
  return (
    <Section title="Shape">
      <div className="prop-row">
        <span>Shading</span>
        <div className="seg-text" role="radiogroup" aria-label="Shading">
          <button role="radio" aria-checked={!smooth} className={!smooth ? 'active' : ''} onClick={() => setSmooth(store, false)}>Flat</button>
          <button role="radio" aria-checked={smooth} className={smooth ? 'active' : ''} data-testid="shade-smooth" onClick={() => setSmooth(store, true)}>Smooth</button>
        </div>
      </div>
      <div className="prop-row">
        <span>Subdivision</span>
        <div className="seg-text" role="radiogroup" aria-label="Subdivision levels">
          {[0, 1, 2, 3].map((n) => (
            <button key={n} role="radio" aria-checked={levels === n} className={levels === n ? 'active' : ''} data-subdiv={n} onClick={() => setSubdivision(store, n)}>
              {n === 0 ? 'Off' : n}
            </button>
          ))}
        </div>
      </div>
      <div className="prop-row">
        <span>Mirror</span>
        <div className="seg-text" role="group" aria-label="Mirror axes">
          {(['x', 'y', 'z'] as const).map((ax) => (
            <button key={ax} aria-pressed={!!mirror?.[ax]} className={mirror?.[ax] ? 'active' : ''} data-mirror={ax} onClick={() => setMirror(ax, !mirror?.[ax])}>
              {ax.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {o.modifiers && (
        <div className="prop-actions">
          <button className="btn" onClick={() => store.dispatch({ type: 'applyModifiers', id }, { select: false })}>Apply modifiers</button>
        </div>
      )}
      <p className="prop-hint">Subdivision rounds the shape off (smooth characters and cars). Mirror X: model one half, the other follows.</p>
    </Section>
  );
}

/** Armature: bones, Pose Mode, the selected bone's rotation (auto-keyed when animated). */
function PoseSection({ id }: { id: string }) {
  const { store } = useCtx();
  const o = useApp((s) => s.doc.objects[id]);
  const doc = useApp((s) => s.doc);
  const frame = useApp((s) => s.frame);
  const pose = useApp((s) => s.pose);
  const inPose = pose?.id === id;
  const bone = inPose ? pose!.bone : null;
  const cur = bone ? poseAt(doc, id, frame)[bone] ?? { rotation: [0, 0, 0] as Vec3 } : null;
  const keyed = bone ? (doc.animation?.poses?.[id]?.[bone]?.length ?? 0) > 0 : false;
  const edit = (axis: number, v: number) => {
    const rotation = [...cur!.rotation] as Vec3;
    rotation[axis] = v;
    return poseEdit(store.getState().doc, frame, id, bone!, { ...cur!, rotation });
  };
  return (
    <Section title="Armature">
      <div className="prop-actions" style={{ padding: 0 }}>
        <button className={`btn${inPose ? ' primary' : ''}`} data-testid="pose-toggle" onClick={() => togglePose(store)}>
          {inPose ? 'Leave Pose Mode' : 'Pose Mode'}
        </button>
      </div>
      <div className="bone-list" role="listbox" aria-label="Bones">
        {o.armature!.bones.map((b) => (
          <button key={b.name} role="option" aria-selected={bone === b.name} className={`bone-item${bone === b.name ? ' active' : ''}`} data-bone={b.name} onClick={() => store.setPose({ id, bone: b.name })}>
            {b.parent ? '· ' : ''}{b.name}
          </button>
        ))}
      </div>
      {bone && cur && (
        <div className="vec3" aria-label={`${bone} rotation`}>
          <div className="prop-sub">{bone} rotation{keyed ? ' · keyed' : ''}</div>
          {AXES.map((ax, i) => (
            <NumberField
              key={ax}
              label={ax.toUpperCase()}
              axis={ax}
              value={cur.rotation[i]}
              step={5}
              dragRate={0.5}
              suffix="°"
              onPreview={(v) => store.preview(edit(i, v))}
              onCommit={(v) => {
                store.preview(edit(i, v));
                store.commitPreview();
              }}
              onCancel={() => store.cancelPreview()}
            />
          ))}
        </div>
      )}
      <p className="prop-hint">Pose Mode: tap a bone, turn it with the gizmo. Press I (or ◆ Key) to keyframe the bone.</p>
    </Section>
  );
}
