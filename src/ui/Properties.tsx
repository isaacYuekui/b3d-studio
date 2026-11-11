import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp, useCtx } from './context';
import { NumberField } from './NumberField';
import { Icon } from './icons';
import { subtree } from '../core/commands';
import type { Command, ModifierPatch } from '../core/commands';
import type { LightType, Material as SceneMaterial, Vec3 } from '../core/types';
import { isRenderable } from '../core/types';
import { runAction } from './actions';
import { useCatalog, useUserModels } from './LibraryDialog';
import { guessUnitScale, isUserAsset } from '../engine/userModels';
import { TIMES } from '../core/sky';
import { FOCAL_PRESETS, FSTOP_PRESETS } from '../core/lens';
import { ALIGNS, FONTS, FONT_LABEL, MAX_TEXT_LENGTH, isFontLoaded, missingChars } from '../core/text';
import type { FontId, TextData } from '../core/text';
import { loadFont } from '../engine/fonts';
import { RIGID_SHAPES, RIGID_TYPES } from '../core/physics';
import { PARTICLE_PRESETS, PARTICLE_SHAPES } from '../core/particles';
import type { ParticleSettings } from '../core/particles';
import type { RigidBody } from '../core/physics';
import { bakePhysics, freePhysics } from './physicsUi';
import { prepareBooleans } from './prepare';
import type { Quality } from '../core/store';
import { PATTERNS } from '../core/patterns';
import type { Pattern, PatternType } from '../core/patterns';
import type { TimeOfDay } from '../core/sky';
import { worldOf } from '../core/types';
import { EASINGS, animationOf, isAnimated, transformAt, transformEdit } from '../core/animation';
import type { Easing } from '../core/animation';
import type { Background } from '../core/types';
import { canEdit, setSmooth, setSubdivision, togglePose } from './editing';
import { poseAt, poseEdit } from '../core/rig';
import { transformVerts } from '../core/mesh/ops';
import { centroid } from '../core/mesh/topology';

const AXES = ['x', 'y', 'z'] as const;

const PATTERN_LABEL: Record<PatternType, string> = { noise: 'Noise', voronoi: 'Voronoi (cells)', checker: 'Checker', bricks: 'Bricks', wood: 'Wood', marble: 'Marble', gradient: 'Gradient' };
const PATTERN_DEFAULTS: Record<PatternType, Pattern> = {
  noise: { type: 'noise', colorA: '#3b3f44', colorB: '#a9adb2', scale: 1, bump: 0.25 },
  voronoi: { type: 'voronoi', colorA: '#20252b', colorB: '#8a939c', scale: 1, bump: 0.4 },
  checker: { type: 'checker', colorA: '#1d1d1d', colorB: '#e8e8e8', scale: 1, bump: 0 },
  bricks: { type: 'bricks', colorA: '#c9c2b4', colorB: '#8e3b2a', scale: 0.8, bump: 0.6 },
  wood: { type: 'wood', colorA: '#5a3418', colorB: '#b07a45', scale: 0.6, bump: 0.15 },
  marble: { type: 'marble', colorA: '#ebe8e2', colorB: '#4d4f55', scale: 0.4, bump: 0 },
  gradient: { type: 'gradient', colorA: '#1b2a49', colorB: '#f2a65a', scale: 1, bump: 0 },
};
const EXTRA_LABEL = { clearcoat: 'Clearcoat', clearcoatRoughness: 'Coat roughness', transmission: 'Transmission (glass)', sheen: 'Sheen (fabric)', subsurface: 'Subsurface (skin)', anisotropy: 'Anisotropy (brushed)' } as const;
/** One-tap looks, Blender-style Principled settings. */
const MATERIAL_PRESETS: { name: string; material: Partial<SceneMaterial> }[] = [
  { name: 'Car paint', material: { baseColor: '#9c1414', metallic: 0.6, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03, transmission: 0, sheen: 0, subsurface: 0, anisotropy: 0, alpha: 1 } },
  { name: 'Glass', material: { baseColor: '#e6f2f2', metallic: 0, roughness: 0.02, transmission: 1, ior: 1.5, clearcoat: 0, sheen: 0, subsurface: 0, anisotropy: 0, alpha: 1 } },
  { name: 'Brushed metal', material: { baseColor: '#c8ccd0', metallic: 1, roughness: 0.3, anisotropy: 0.8, clearcoat: 0, transmission: 0, sheen: 0, subsurface: 0, alpha: 1 } },
  { name: 'Velvet', material: { baseColor: '#4b1640', metallic: 0, roughness: 0.8, sheen: 1, sheenColor: '#ff9be8', clearcoat: 0, transmission: 0, subsurface: 0, anisotropy: 0, alpha: 1 } },
  { name: 'Skin', material: { baseColor: '#d8a08a', metallic: 0, roughness: 0.5, subsurface: 0.6, subsurfaceColor: '#ff5a3c', clearcoat: 0, transmission: 0, sheen: 0, anisotropy: 0, alpha: 1 } },
  { name: 'Plain', material: { clearcoat: 0, sheen: 0, transmission: 0, subsurface: 0, anisotropy: 0 } },
];

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
  const [tab, setTabState] = useState<PropTab>(() => {
    try {
      return (localStorage.getItem('b3d.propTab') as PropTab | null) ?? 'object';
    } catch {
      return 'object';
    }
  });
  const setTab = (t: PropTab) => {
    setTabState(t);
    try {
      localStorage.setItem('b3d.propTab', t);
    } catch {
      /* per session only */
    }
  };
  // Entering Pose Mode shows the bones (Armature tab); Edit Mode shows the mesh tools (Object tab).
  const poseId = useApp((s) => s.pose?.id ?? null);
  const editId = useApp((s) => s.edit?.id ?? null);
  useEffect(() => {
    if (poseId) setTabState('data');
  }, [poseId]);
  useEffect(() => {
    if (editId) setTabState('object');
  }, [editId]);

  // Every field edit goes through preview+commit so scrubs and typed values are one undo step each.
  const commit = (cmd: Command) => {
    store.preview(cmd);
    store.commitPreview();
  };

  if (!o) {
    return (
      <div className="properties">
        <PropTabs tabs={[['scene', 'Scene']]} cur="scene" onPick={() => {}} />
        <SceneTab />
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

  // Tabs like Blender's Properties editor: only the ones this kind of object has.
  const tabs: [PropTab, string][] = [['scene', 'Scene'], ['object', 'Object']];
  if (canEdit(o)) tabs.push(['modifiers', 'Modifiers'], ['physics', 'Physics']);
  const dataLabel = o.text ? 'Text' : o.light ? 'Light' : o.type === 'model' ? 'Model' : o.type === 'armature' ? 'Armature' : null;
  if (dataLabel) tabs.push(['data', dataLabel]);
  if (isRenderable(o.type) && o.type !== 'model') tabs.push(['material', 'Material']);
  const cur: PropTab = tabs.some(([t]) => t === tab) ? tab : 'object';

  return (
    <div className="properties" data-testid="properties">
      <PropTabs tabs={tabs} cur={cur} onPick={setTab} />
      {cur === 'scene' && <SceneTab />}
      {cur !== 'scene' && (
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
      )}

      {cur === 'object' && (
      <>
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

      <Section title="Object">
        <label className="prop-row">
          <span>Visible</span>
          <input type="checkbox" checked={o.visible} onChange={(e) => store.dispatch({ type: 'setVisible', id: o.id, visible: e.target.checked }, { select: false })} />
        </label>
        <div className="prop-row"><span>Type</span><b style={{ textTransform: 'capitalize' }}>{o.text ? 'Text' : o.type}</b></div>
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
      </>
      )}

      {cur === 'data' && o.type === 'model' && <ModelSection id={o.id} />}
      {cur === 'data' && o.text && <TextSection id={o.id} />}
      {cur === 'modifiers' && <ModifiersSection id={o.id} />}
      {cur === 'physics' && <PhysicsSection id={o.id} />}
      {cur === 'data' && o.type === 'armature' && <PoseSection id={o.id} />}

      {cur === 'material' && (
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
          {!o.material.texture && (
            <label className="prop-row">
              <span>Pattern</span>
              <select
                id="mat-pattern"
                aria-label="Procedural pattern"
                value={o.material.pattern?.type ?? ''}
                onChange={(e) => {
                  const t = e.target.value as PatternType | '';
                  store.dispatch({ type: 'setMaterial', id: o.id, material: { pattern: t ? { ...PATTERN_DEFAULTS[t], ...(o.material.pattern ? { colorA: o.material.pattern.colorA, colorB: o.material.pattern.colorB } : {}), type: t } : null } }, { select: false });
                }}
              >
                <option value="">None</option>
                {PATTERNS.map((t) => (
                  <option key={t} value={t}>{PATTERN_LABEL[t]}</option>
                ))}
              </select>
            </label>
          )}
          {!o.material.texture && o.material.pattern && (() => {
            const p = o.material.pattern;
            const setP = (patch: Partial<Pattern>): Command => ({ type: 'setMaterial', id: o.id, material: { pattern: { ...p, ...patch } } });
            return (
              <>
                <label className="prop-row">
                  <span>Colours</span>
                  <span className="pair">
                    <input type="color" aria-label="Pattern colour A" value={p.colorA} onChange={(e) => store.preview(setP({ colorA: e.target.value }))} onBlur={() => store.commitPreview()} />
                    <input type="color" aria-label="Pattern colour B" value={p.colorB} onChange={(e) => store.preview(setP({ colorB: e.target.value }))} onBlur={() => store.commitPreview()} />
                  </span>
                </label>
                {scalar('Scale', p.scale, 0.01, 100, (v) => setP({ scale: v }), 0.1)}
                {scalar('Bump', p.bump, 0, 1, (v) => setP({ bump: v }))}
              </>
            );
          })()}
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
          <details className="mat-more" open={!!(o.material.clearcoat || o.material.sheen || o.material.transmission || o.material.subsurface || o.material.anisotropy)}>
            <summary>More: clearcoat, glass, sheen, skin…</summary>
            {(['clearcoat', 'clearcoatRoughness', 'transmission', 'sheen', 'subsurface', 'anisotropy'] as const).map((k) =>
              scalar(EXTRA_LABEL[k], o.material[k] ?? (k === 'clearcoatRoughness' ? 0.03 : 0), 0, 1, (v) => ({ type: 'setMaterial', id: o.id, material: { [k]: v } })),
            )}
            {(o.material.transmission ?? 0) > 0 && scalar('IOR', o.material.ior ?? 1.5, 1, 3, (v) => ({ type: 'setMaterial', id: o.id, material: { ior: v } }))}
            {(o.material.sheen ?? 0) > 0 && (
              <label className="prop-row">
                <span>Sheen colour</span>
                <input type="color" aria-label="Sheen colour" value={o.material.sheenColor ?? '#ffffff'} onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, material: { sheenColor: e.target.value } })} onBlur={() => store.commitPreview()} />
              </label>
            )}
            {(o.material.subsurface ?? 0) > 0 && (
              <label className="prop-row">
                <span>Subsurface colour</span>
                <input type="color" aria-label="Subsurface colour" value={o.material.subsurfaceColor ?? '#ff6040'} onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, material: { subsurfaceColor: e.target.value } })} onBlur={() => store.commitPreview()} />
              </label>
            )}
            <div className="mat-presets">
              {MATERIAL_PRESETS.map((pr) => (
                <button key={pr.name} className="btn" data-mat-preset={pr.name} onClick={() => store.dispatch({ type: 'setMaterial', id: o.id, material: pr.material }, { select: false })}>{pr.name}</button>
              ))}
            </div>
          </details>
        </Section>
      )}

      {cur === 'data' && o.light && (
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

    </div>
  );
}

type PropTab = 'scene' | 'object' | 'modifiers' | 'physics' | 'data' | 'material';

function PropTabs({ tabs, cur, onPick }: { tabs: [PropTab, string][]; cur: PropTab; onPick: (t: PropTab) => void }) {
  return (
    <div className="prop-tabs" role="tablist" aria-label="Properties">
      {tabs.map(([t, label]) => (
        <button key={t} role="tab" aria-selected={cur === t} className={`prop-tab${cur === t ? ' active' : ''}`} data-prop-tab={t} onClick={() => onPick(t)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Scene tab: scene facts, camera lens, physics world and the world (sky, light, look). */
function SceneTab() {
  const doc = useApp((s) => s.doc);
  return (
    <>
      <Section title="Scene">
        <div className="prop-row"><span>Objects</span><b>{doc.order.length}</b></div>
        <div className="prop-row"><span>Hidden</span><b>{doc.order.filter((id) => !doc.objects[id].visible).length}</b></div>
        <div className="prop-row"><span>Units</span><b>Metres, Z up</b></div>
        <p className="prop-hint">Select an object in the viewport or Outliner to edit its properties.</p>
      </Section>
      <CameraSection />
      <ScenePhysicsSection />
      <WorldSection />
    </>
  );
}

const TIME_LABEL: Record<TimeOfDay, string> = { sunrise: 'Sunrise', morning: 'Morning', noon: 'Noon', afternoon: 'Late afternoon', sunset: 'Sunset', dusk: 'Dusk', night: 'Night (moon)', overcast: 'Overcast', misty: 'Misty morning' };

/** Scene-wide look for Rendered shading: HDRI sky, exposure, bloom, ambient occlusion. */
/** Scene camera lens (Blender's camera data): focal length and depth of field. */
function CameraSection() {
  const { store } = useCtx();
  const lens = useApp((s) => s.doc.lens);
  const hasCam = useApp((s) => !!s.doc.camera || (s.doc.animation?.camera.length ?? 0) > 0);
  const set = (l: Extract<Command, { type: 'setLens' }>['lens']) => store.dispatch({ type: 'setLens', lens: l }, { select: false });
  const preview = (l: Extract<Command, { type: 'setLens' }>['lens']) => store.preview({ type: 'setLens', lens: l });
  const commit = (l: Extract<Command, { type: 'setLens' }>['lens']) => {
    store.preview({ type: 'setLens', lens: l });
    store.commitPreview();
  };
  const focal = lens?.focal;
  const clampF = (v: number) => Math.max(1, Math.min(5000, Math.round(v)));
  return (
    <Section title="Camera" defaultOpen={!!lens}>
      <label className="prop-row">
        <span>Lens</span>
        <select data-testid="lens-focal" value={focal && (FOCAL_PRESETS as readonly number[]).includes(focal) ? String(focal) : focal ? 'custom' : ''} onChange={(e) => e.target.value !== 'custom' && set({ focal: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Default (wide)</option>
          {FOCAL_PRESETS.map((f) => (
            <option key={f} value={f}>
              {f} mm{f === 50 ? ' (normal)' : f >= 85 ? ' (portrait)' : f <= 24 ? ' (wide)' : ''}
            </option>
          ))}
          {focal && !(FOCAL_PRESETS as readonly number[]).includes(focal) && <option value="custom">{focal} mm</option>}
        </select>
      </label>
      {focal && <NumberField label="Focal length" value={focal} step={1} dragRate={0.2} suffix=" mm" onPreview={(v) => preview({ focal: clampF(v) })} onCommit={(v) => commit({ focal: clampF(v) })} onCancel={() => store.cancelPreview()} />}
      <label className="prop-row">
        <span>Depth of field</span>
        <input type="checkbox" data-testid="lens-dof" checked={!!lens?.dof} onChange={(e) => set({ dof: e.target.checked ? true : null })} />
      </label>
      {lens?.dof && (
        <>
          <div className="prop-row">
            <span>F-stop</span>
            <div className="seg-text" role="radiogroup" aria-label="F-stop">
              {FSTOP_PRESETS.map((f) => {
                const on = (lens.fStop ?? 2.8) === f;
                return (
                  <button key={f} role="radio" aria-checked={on} className={on ? 'active' : ''} data-fstop={f} onClick={() => set({ fStop: f })}>
                    f/{f}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="prop-row">
            <span>Focus on camera target</span>
            <input type="checkbox" checked={lens.focus === undefined} onChange={(e) => set({ focus: e.target.checked ? null : 5 })} />
          </label>
          {lens.focus !== undefined && (
            <NumberField label="Focus distance" value={lens.focus} step={0.5} dragRate={0.05} suffix=" m" onPreview={(v) => preview({ focus: Math.max(0.01, v) })} onCommit={(v) => commit({ focus: Math.max(0.01, v) })} onCancel={() => store.cancelPreview()} />
          )}
        </>
      )}
      <p className="prop-hint">
        Used when you look through the scene camera (Camera view) and in videos, in Rendered shading. 50 mm sees like your eye; 85–135 mm zooms in and flattens like a portrait lens; 18–24 mm is wide. Depth of field blurs what isn't at
        the focus distance: f/1.4 a lot, f/11 hardly at all.{!hasCam && ' Set a scene camera first: View → Set Camera to View.'}
      </p>
    </Section>
  );
}

function WorldSection() {
  const { store } = useCtx();
  const raw = useApp((s) => s.doc.world); // stable reference; worldOf() fills defaults
  const w = worldOf({ objects: {}, order: [], world: raw });
  const shading = useApp((s) => s.shading);
  const quality = useApp((s) => s.quality);
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
      <label className="prop-row">
        <span>Quality (this device)</span>
        <select id="quality" aria-label="Quality on this device" value={quality} onChange={(e) => store.setQuality(e.target.value as Quality)}>
          <option value="fast">Fast: smooth on phones</option>
          <option value="balanced">Balanced</option>
          <option value="best">Best: sharpest, soft shadows</option>
        </select>
      </label>
      <p className="prop-hint">Videos always render at Best. Fast turns off ambient occlusion and bloom and draws fewer pixels.</p>
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

/** Physics → Rigid Body for one object (Blender's Physics properties). */
function PhysicsSection({ id }: { id: string }) {
  const ctx = useCtx();
  const { store } = ctx;
  const o = useApp((s) => s.doc.objects[id]);
  const r = o.rigid;
  const set = (rigid: Partial<RigidBody> | null) => store.dispatch({ type: 'setRigidBody', id, rigid }, { select: false });
  const num = (key: 'mass' | 'friction' | 'bounce', label: string, lo: number, hi: number, step: number, suffix = '') => (
    <NumberField
      label={label}
      value={r![key]}
      step={step}
      dragRate={step / 10}
      suffix={suffix}
      onPreview={(v) => store.preview({ type: 'setRigidBody', id, rigid: { [key]: Math.max(lo, Math.min(hi, v)) } })}
      onCommit={(v) => {
        store.preview({ type: 'setRigidBody', id, rigid: { [key]: Math.max(lo, Math.min(hi, v)) } });
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  return (
    <>
    <Section title="Physics" defaultOpen={!!r}>
      <label className="prop-row">
        <span>Rigid body</span>
        <input type="checkbox" data-testid="rigid-toggle" checked={!!r} onChange={(e) => set(e.target.checked ? {} : null)} />
      </label>
      {r && (
        <>
          <div className="prop-row">
            <span>Type</span>
            <div className="seg-text" role="radiogroup" aria-label="Rigid body type">
              {RIGID_TYPES.map((t) => (
                <button key={t} role="radio" aria-checked={r.type === t} className={r.type === t ? 'active' : ''} data-rigid-type={t} onClick={() => set({ type: t })}>
                  {t === 'active' ? 'Active (falls)' : 'Passive (stays)'}
                </button>
              ))}
            </div>
          </div>
          <label className="prop-row">
            <span>Shape</span>
            <select value={r.shape} onChange={(e) => set({ shape: e.target.value as RigidBody['shape'] })}>
              {RIGID_SHAPES.map((sh) => (
                <option key={sh} value={sh}>{sh === 'auto' ? 'Auto (from the object)' : sh === 'hull' ? 'Convex hull' : sh[0].toUpperCase() + sh.slice(1)}</option>
              ))}
            </select>
          </label>
          {r.type === 'active' && num('mass', 'Mass', 0.001, 100000, 0.5, ' kg')}
          {num('friction', 'Friction', 0, 1, 0.05)}
          {num('bounce', 'Bounciness', 0, 1, 0.05)}
          {o.parentId && <p className="prop-hint warn">Parented objects aren't simulated — clear the parent first.</p>}
          <div className="prop-actions">
            <button className="btn primary" data-testid="physics-bake" onClick={() => void bakePhysics(store)}>
              Bake physics
            </button>
            <button className="btn" onClick={() => freePhysics(store)}>
              Free bake
            </button>
          </div>
          <p className="prop-hint">
            Active objects fall and collide; passive ones (floor, walls, ramps) stay put. Bake runs the simulation over the animation range and saves it as keyframes, so it plays, scrubs and goes into videos. Move things
            and bake again to redo it.
          </p>
        </>
      )}
    </Section>
    <FractureSection id={id} />
    <ParticlesSection id={id} />
    </>
  );
}

/** Particle system (Blender's Particles tab, Emitter): settings and one-tap presets. */
function ParticlesSection({ id }: { id: string }) {
  const { store } = useCtx();
  const p = useApp((s) => s.doc.objects[id].particles);
  const set = (particles: Partial<ParticleSettings> | null) => store.dispatch({ type: 'setParticles', id, particles }, { select: false });
  const num = (key: 'count' | 'start' | 'end' | 'lifetime' | 'speed' | 'random' | 'gravity' | 'size' | 'sizeRandom' | 'glow', label: string, lo: number, hi: number, step: number, suffix = '', int = false) => (
    <NumberField
      label={label}
      value={p![key]}
      step={step}
      dragRate={step / 10}
      suffix={suffix}
      onPreview={(v) => store.preview({ type: 'setParticles', id, particles: { [key]: clampN(v, lo, hi, int) } })}
      onCommit={(v) => {
        store.preview({ type: 'setParticles', id, particles: { [key]: clampN(v, lo, hi, int) } });
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  return (
    <Section title="Particles" defaultOpen={!!p}>
      <label className="prop-row">
        <span>Emit particles</span>
        <input type="checkbox" data-testid="particles-toggle" checked={!!p} onChange={(e) => set(e.target.checked ? {} : null)} />
      </label>
      <div className="prop-row wrap">
        <span>Presets</span>
        <div className="seg-text" role="group" aria-label="Particle presets">
          {PARTICLE_PRESETS.map((pr) => (
            <button key={pr.id} data-particle-preset={pr.id} onClick={() => set(pr.settings)}>
              {pr.label}
            </button>
          ))}
        </div>
      </div>
      {p && (
        <>
          {num('count', 'Number', 1, 20000, 50, '', true)}
          {num('start', 'Start frame', -100000, 100000, 1, '', true)}
          {num('end', 'End frame', -100000, 100000, 1, '', true)}
          {num('lifetime', 'Lifetime', 1, 10000, 1, ' fr')}
          {num('speed', 'Speed (normal)', -1000, 1000, 0.5, ' m/s')}
          {num('random', 'Random speed', 0, 1000, 0.5, ' m/s')}
          {num('gravity', 'Gravity', -10, 10, 0.1, ' ×')}
          {num('size', 'Size', 0.001, 100, 0.01, ' m')}
          {num('sizeRandom', 'Size variation', 0, 1, 0.05)}
          <label className="prop-row">
            <span>Shape</span>
            <select value={p.shape} onChange={(e) => set({ shape: e.target.value as ParticleSettings['shape'] })}>
              {PARTICLE_SHAPES.map((sh) => (
                <option key={sh} value={sh}>{sh === 'drop' ? 'Drop (stretched)' : sh[0].toUpperCase() + sh.slice(1)}</option>
              ))}
            </select>
          </label>
          <label className="prop-row">
            <span>Colour</span>
            <input type="color" value={p.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
          {num('glow', 'Glow', 0, 1, 0.1)}
          <label className="prop-row">
            <span>At the ground</span>
            <select value={p.ground} onChange={(e) => set({ ground: e.target.value as ParticleSettings['ground'] })}>
              <option value="none">Pass through</option>
              <option value="stop">Land and stay</option>
            </select>
          </label>
          <label className="prop-row">
            <span>Hide emitter in renders</span>
            <input type="checkbox" checked={p.hideEmitter} onChange={(e) => set({ hideEmitter: e.target.checked })} />
          </label>
          <div className="prop-actions">
            <button className="btn" onClick={() => set({ seed: (p.seed + 1) % 100000 })}>New pattern</button>
          </div>
        </>
      )}
      <p className="prop-hint">Particles fly off the object's surface, fall with gravity and vanish after their lifetime — sparks, fountains, rain, snow, debris. No baking: scrub and play. For rain or snow, use a big plane high up as the emitter.</p>
    </Section>
  );
}

const clampN = (v: number, lo: number, hi: number, int: boolean) => {
  const c = Math.max(lo, Math.min(hi, v));
  return int ? Math.round(c) : c;
};

/** Cell Fracture: break the object into rigid pieces (Blender's Cell Fracture add-on). */
function FractureSection({ id }: { id: string }) {
  const { store } = useCtx();
  const [pieces, setPieces] = useState(16);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await prepareBooleans();
      store.dispatch({ type: 'fracture', id, pieces, seed: 1 + Math.floor(Math.random() * 9999) });
    } catch {
      store.notify("Couldn't load the fracture engine — check the connection and try again");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Fracture" defaultOpen={false}>
      <div className="prop-row">
        <span>Pieces</span>
        <div className="seg-text" role="radiogroup" aria-label="Pieces">
          {[8, 16, 32, 64].map((n) => (
            <button key={n} role="radio" aria-checked={pieces === n} className={pieces === n ? 'active' : ''} data-pieces={n} onClick={() => setPieces(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="prop-actions">
        <button className="btn primary" data-testid="fracture" disabled={busy} onClick={() => void run()}>
          {busy ? 'Breaking…' : 'Break into pieces'}
        </button>
      </div>
      <p className="prop-hint">
        Splits the object into random chunks (Voronoi cells, like Blender's Cell Fracture), each an active rigid body with a convex-hull shape. Then add something to hit it and Bake physics. Needs a closed solid; one undo
        puts it back.
      </p>
    </Section>
  );
}

/** Scene-wide rigid body world: what will be simulated, and the bake. */
function ScenePhysicsSection() {
  const { store } = useCtx();
  const doc = useApp((s) => s.doc);
  const rigid = Object.values(doc.objects).filter((o) => o.rigid);
  const active = rigid.filter((o) => o.rigid!.type === 'active').length;
  const { start, end } = animationOf(doc);
  return (
    <Section title="Physics" defaultOpen={rigid.length > 0}>
      <div className="prop-row"><span>Rigid bodies</span><b>{active} active · {rigid.length - active} passive</b></div>
      <div className="prop-row"><span>Frames</span><b>{start}–{end}</b></div>
      <div className="prop-actions">
        <button className="btn primary" disabled={!active} onClick={() => void bakePhysics(store)}>Bake physics</button>
        <button className="btn" disabled={!active} onClick={() => freePhysics(store)}>Free bake</button>
      </div>
      <p className="prop-hint">Gravity 9.81 m/s² down. Turn on Physics → Rigid body on each object first. Freeing the bake removes the keyframes of the active objects.</p>
    </Section>
  );
}

/** Text objects: the words, font, size, thickness and alignment (Blender's Text properties). */
function TextSection({ id }: { id: string }) {
  const { store } = useCtx();
  const text = useApp((s) => s.doc.objects[id].text)!;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Fonts load on demand; a change waits for its font, then rebuilds the letters.
  const apply = async (patch: Partial<TextData>, mode: 'set' | 'preview' | 'commit' = 'set') => {
    const font = patch.font ?? text.font;
    if (!isFontLoaded(font)) {
      setBusy(true);
      try {
        await loadFont(font);
      } catch {
        store.notify("Couldn't load the font — check the connection and try again");
        return;
      } finally {
        setBusy(false);
      }
    }
    const cmd: Command = { type: 'setText', id, text: patch };
    if (mode === 'set') store.dispatch(cmd, { select: false });
    else store.preview(cmd);
    if (mode === 'commit') store.commitPreview();
  };
  const body = draft ?? text.body;
  const missing = missingChars({ body, font: text.font });
  return (
    <Section title="Text">
      <textarea
        className="text-body"
        data-testid="text-body"
        aria-label="Text"
        rows={Math.min(5, body.split('\n').length + 1)}
        maxLength={MAX_TEXT_LENGTH}
        value={body}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value.trim()) void apply({ body: e.target.value }, 'preview');
        }}
        onBlur={() => {
          if (draft !== null && draft.trim()) void apply({ body: draft }, 'commit');
          else store.cancelPreview();
          setDraft(null);
        }}
      />
      <label className="prop-row">
        <span>Font</span>
        <select data-testid="text-font" value={text.font} disabled={busy} onChange={(e) => void apply({ font: e.target.value as FontId })}>
          {FONTS.map((f) => (
            <option key={f} value={f}>{FONT_LABEL[f]}</option>
          ))}
        </select>
      </label>
      <NumberField label="Size" value={text.size} step={0.1} dragRate={0.01} suffix=" m" onPreview={(v) => void apply({ size: Math.max(0.01, Math.min(100, v)) }, 'preview')} onCommit={(v) => void apply({ size: Math.max(0.01, Math.min(100, v)) }, 'commit')} onCancel={() => store.cancelPreview()} />
      <NumberField label="Thickness" value={text.depth} step={0.05} dragRate={0.005} suffix=" m" onPreview={(v) => void apply({ depth: Math.max(0, Math.min(100, v)) }, 'preview')} onCommit={(v) => void apply({ depth: Math.max(0, Math.min(100, v)) }, 'commit')} onCancel={() => store.cancelPreview()} />
      <div className="prop-row">
        <span>Align</span>
        <div className="seg-text" role="radiogroup" aria-label="Alignment">
          {ALIGNS.map((a) => (
            <button key={a} role="radio" aria-checked={text.align === a} className={text.align === a ? 'active' : ''} onClick={() => void apply({ align: a })}>
              {a[0].toUpperCase() + a.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {missing.length > 0 && <p className="prop-hint warn">This font can't draw {missing.slice(0, 6).join(' ')}{missing.length > 6 ? '…' : ''} — those are left out (Latin letters, digits and punctuation only for now).</p>}
      <p className="prop-hint">Bevel (Shape panel) rounds the letter edges. Edit Mode or Sculpt turns the text into a plain mesh, like Blender's Convert to Mesh.</p>
    </Section>
  );
}

/** Shading and modifiers (Mirror, Bevel, Subdivision Surface) for shapes and meshes. */
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
      {levels > 0 && (
        <label className="prop-row">
          <span>Keep sharp edges</span>
          <input
            type="checkbox"
            data-testid="subdiv-sharp"
            checked={mods.subdivision?.sharpAngle !== undefined}
            onChange={(e) => store.dispatch({ type: 'setModifiers', id, modifiers: { subdivision: e.target.checked ? { levels, sharpAngle: 30 } : { levels } } }, { select: false })}
          />
        </label>
      )}
      <div className="prop-row">
        <span>Bevel</span>
        <div className="seg-text" role="radiogroup" aria-label="Bevel width">
          {[0, 0.01, 0.03, 0.08].map((w) => {
            const on = (mods.bevel?.width ?? 0) === w;
            return (
              <button
                key={w}
                role="radio"
                aria-checked={on}
                className={on ? 'active' : ''}
                data-bevel={w}
                onClick={() => store.dispatch({ type: 'setModifiers', id, modifiers: { bevel: w ? { width: w, segments: mods.bevel?.segments ?? 2, angle: mods.bevel?.angle ?? 30 } : null } }, { select: false })}
              >
                {w === 0 ? 'Off' : `${Math.round(w * 100)} cm`}
              </button>
            );
          })}
        </div>
      </div>
      {mods.bevel && (
        <div className="prop-row">
          <span>Bevel segments</span>
          <div className="seg-text" role="radiogroup" aria-label="Bevel segments">
            {[1, 2, 3].map((n) => (
              <button key={n} role="radio" aria-checked={mods.bevel!.segments === n} className={mods.bevel!.segments === n ? 'active' : ''} onClick={() => store.dispatch({ type: 'setModifiers', id, modifiers: { bevel: { ...mods.bevel!, segments: n } } }, { select: false })}>
                {n}
              </button>
            ))}
          </div>
        </div>
      )}
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
      <ArrayRows id={id} />
      <SolidifyRows id={id} />
      <DisplaceRows id={id} />
      {o.modifiers && (
        <div className="prop-actions">
          <button className="btn" onClick={() => store.dispatch({ type: 'applyModifiers', id }, { select: false })}>Apply modifiers</button>
        </div>
      )}
      <BooleanRow id={id} />
      <JoinRow id={id} />
      <p className="prop-hint">
        Subdivision rounds the shape off; Keep sharp edges makes hard-surface parts (armour, cars) curved but crisp. Bevel rounds every edge sharper than 30° so it catches the light. Mirror X: model one half, the
        other follows. Array repeats it (fences, stairs, chains); Solidify gives a flat surface thickness (walls, shells); Displace adds bumps (rocks, terrain) — subdivide first for finer bumps.
      </p>
    </Section>
  );
}

function useSetModifiers(id: string) {
  const { store } = useCtx();
  return {
    set: (patch: ModifierPatch) => store.dispatch({ type: 'setModifiers', id, modifiers: patch }, { select: false }),
    preview: (patch: ModifierPatch) => store.preview({ type: 'setModifiers', id, modifiers: patch }),
    commit: (patch: ModifierPatch) => {
      store.preview({ type: 'setModifiers', id, modifiers: patch });
      store.commitPreview();
    },
    cancel: () => store.cancelPreview(),
  };
}

/** Array modifier: copies, direction and the gap between copies. */
function ArrayRows({ id }: { id: string }) {
  const arr = useApp((s) => s.doc.objects[id].modifiers?.array);
  const m = useSetModifiers(id);
  const rel = arr?.relative ?? [1, 0, 0];
  const axis = [0, 1, 2].reduce((best, k) => (Math.abs(rel[k]) > Math.abs(rel[best]) ? k : best), 0);
  const gap = arr?.constant?.[axis] ?? 0;
  const along = (k: number, g: number): ModifierPatch => {
    const relative = [0, 0, 0] as Vec3;
    const constant = [0, 0, 0] as Vec3;
    relative[k] = 1;
    constant[k] = g;
    return { array: { relative, constant } };
  };
  return (
    <>
      <div className="prop-row">
        <span>Array</span>
        <div className="seg-text" role="radiogroup" aria-label="Array copies">
          {[1, 2, 3, 5, 10].map((n) => {
            const on = (arr?.count ?? 1) === n || (n === 1 && !arr);
            return (
              <button key={n} role="radio" aria-checked={on} className={on ? 'active' : ''} data-array={n} onClick={() => m.set({ array: n === 1 ? null : { ...(arr ? {} : along(0, 0).array), count: n } })}>
                {n === 1 ? 'Off' : `×${n}`}
              </button>
            );
          })}
        </div>
      </div>
      {arr && (
        <>
          <div className="prop-row">
            <span>Direction</span>
            <div className="seg-text" role="radiogroup" aria-label="Array direction">
              {AXES.map((ax, k) => (
                <button key={ax} role="radio" aria-checked={axis === k} className={axis === k ? 'active' : ''} data-array-axis={ax} onClick={() => m.set(along(k, gap))}>
                  {ax.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <NumberField label="Gap" value={gap} step={0.1} dragRate={0.01} suffix=" m" onPreview={(v) => m.preview(along(axis, v))} onCommit={(v) => m.commit(along(axis, v))} onCancel={m.cancel} />
          <NumberField
            label="Count"
            value={arr.count}
            step={1}
            dragRate={0.1}
            onPreview={(v) => m.preview({ array: { count: Math.max(1, Math.min(100, Math.round(v))) } })}
            onCommit={(v) => m.commit({ array: { count: Math.max(1, Math.min(100, Math.round(v))) } })}
            onCancel={m.cancel}
          />
        </>
      )}
    </>
  );
}

/** Solidify modifier: thickness for flat surfaces. */
function SolidifyRows({ id }: { id: string }) {
  const so = useApp((s) => s.doc.objects[id].modifiers?.solidify);
  const m = useSetModifiers(id);
  const t = so?.thickness ?? 0;
  const clampT = (v: number) => Math.max(-10, Math.min(10, v));
  return (
    <>
      <div className="prop-row">
        <span>Solidify</span>
        <div className="seg-text" role="radiogroup" aria-label="Solidify thickness">
          {[0, 0.01, 0.05, 0.2].map((w) => {
            const on = t === w;
            return (
              <button key={w} role="radio" aria-checked={on} className={on ? 'active' : ''} data-solidify={w} onClick={() => m.set({ solidify: w ? { thickness: w } : null })}>
                {w === 0 ? 'Off' : `${Math.round(w * 100)} cm`}
              </button>
            );
          })}
        </div>
      </div>
      {so && <NumberField label="Thickness" value={t} step={0.01} dragRate={0.002} suffix=" m" onPreview={(v) => m.preview({ solidify: { thickness: clampT(v) } })} onCommit={(v) => m.commit({ solidify: { thickness: clampT(v) } })} onCancel={m.cancel} />}
    </>
  );
}

/** Displace modifier: noise bumps along the surface. */
function DisplaceRows({ id }: { id: string }) {
  const d = useApp((s) => s.doc.objects[id].modifiers?.displace);
  const m = useSetModifiers(id);
  const levels: [string, number][] = [['Off', 0], ['Low', 0.03], ['Medium', 0.1], ['High', 0.3]];
  const clampS = (v: number) => Math.max(0.01, Math.min(100, v));
  return (
    <>
      <div className="prop-row">
        <span>Displace</span>
        <div className="seg-text" role="radiogroup" aria-label="Displace strength">
          {levels.map(([label, v]) => {
            const on = (d?.strength ?? 0) === v;
            return (
              <button key={label} role="radio" aria-checked={on} className={on ? 'active' : ''} data-displace={v} onClick={() => m.set({ displace: v ? { strength: v, ...(d ? {} : { scale: 0.5 }) } : null })}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {d && (
        <>
          <NumberField label="Bump size" value={d.scale} step={0.1} dragRate={0.01} suffix=" m" onPreview={(v) => m.preview({ displace: { scale: clampS(v) } })} onCommit={(v) => m.commit({ displace: { scale: clampS(v) } })} onCancel={m.cancel} />
          <div className="prop-actions">
            <button className="btn" data-testid="displace-seed" onClick={() => m.set({ displace: { seed: ((d.seed ?? 0) + 1) % 100000 } })}>
              New pattern
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Boolean: cut, join or intersect another solid into this one (applied, like Blender's Apply). */
function BooleanRow({ id }: { id: string }) {
  const { store } = useCtx();
  const objects = useApp((s) => s.doc.objects);
  const order = useApp((s) => s.doc.order);
  const [cutter, setCutter] = useState('');
  const [op, setOp] = useState<'difference' | 'union' | 'intersect'>('difference');
  const [busy, setBusy] = useState(false);
  const solids = order.filter((k) => k !== id && objects[k] && (objects[k].type === 'mesh' || ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule'].includes(objects[k].type)));
  if (!solids.length) return null;
  const run = async () => {
    if (!cutter) return;
    setBusy(true);
    try {
      await prepareBooleans();
      store.dispatch({ type: 'boolean', id, cutter, op }, { select: false });
    } catch (e) {
      store.notify(`Boolean failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="prop-row">
        <span>Boolean</span>
        <div className="seg-text" role="radiogroup" aria-label="Boolean operation">
          {(['difference', 'union', 'intersect'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={op === k} className={op === k ? 'active' : ''} data-bool-op={k} onClick={() => setOp(k)}>
              {k === 'difference' ? 'Cut' : k === 'union' ? 'Union' : 'Intersect'}
            </button>
          ))}
        </div>
      </div>
      <label className="prop-row">
        <span>with</span>
        <select id="bool-cutter" aria-label="Boolean cutter" value={cutter} onChange={(e) => setCutter(e.target.value)}>
          <option value="">Choose an object…</option>
          {solids.map((k) => (
            <option key={k} value={k}>{objects[k].name}</option>
          ))}
        </select>
      </label>
      <div className="prop-actions">
        <button className="btn" data-testid="bool-apply" disabled={!cutter || busy} onClick={() => void run()}>
          {busy ? 'Working…' : 'Apply boolean'}
        </button>
      </div>
    </>
  );
}

/** Join: pull another object into this one (one object, shapes untouched), like Ctrl J. */
function JoinRow({ id }: { id: string }) {
  const { store } = useCtx();
  const objects = useApp((s) => s.doc.objects);
  const order = useApp((s) => s.doc.order);
  const [other, setOther] = useState('');
  const meshes = order.filter((k) => k !== id && objects[k] && (objects[k].type === 'mesh' || ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane'].includes(objects[k].type)) && !order.some((c) => objects[c]?.parentId === k));
  if (!meshes.length) return null;
  return (
    <label className="prop-row">
      <span>Join</span>
      <span className="join-pick">
        <select id="join-other" aria-label="Object to join into this one" value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">Pick an object…</option>
          {meshes.map((k) => (
            <option key={k} value={k}>{objects[k].name}</option>
          ))}
        </select>
        <button className="btn" data-testid="join-apply" disabled={!other} onClick={() => {
          try {
            store.dispatch({ type: 'join', id, others: [other] }, { select: false });
            setOther('');
            store.notify('Joined into one object (Separate by Loose Parts splits it again)');
          } catch (e) {
            store.notify(e instanceof Error ? e.message : String(e));
          }
        }}>Join</button>
      </span>
    </label>
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
