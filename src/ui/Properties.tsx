import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp, useCtx } from './context';
import { NumberField } from './NumberField';
import { Icon } from './icons';
import { subtree } from '../core/commands';
import type { Command, ModifierPatch } from '../core/commands';
import type { FollowPath, LightType, Material as SceneMaterial, SceneObject, Vec3 } from '../core/types';
import type { CameraFollow } from '../core/animation';
import { evaluateValue } from '../core/animation';
import { CONSTRAINT_LABELS, CONSTRAINT_TYPES, MAX_CONSTRAINTS, TRACK_AXES } from '../core/constraints';
import type { Constraint, ConstraintType, TrackAxis } from '../core/constraints';
import { CHANNELS, CHANNEL_LABELS, MAX_DRIVERS, MAX_DRIVER_VARS, channelOf, driverProblem, driverValue, isVarName } from '../core/drivers';
import type { Channel, Driver } from '../core/drivers';
import { MAX_EXPR } from '../core/expr';
import { isRenderable } from '../core/types';
import { pickFile, runAction } from './actions';
import { useCatalog, useUserModels } from './LibraryDialog';
import { guessUnitScale, isUserAsset } from '../engine/userModels';
import { isUserImage, listUserImages, onUserImagesChanged, saveUserImage } from '../engine/userImages';
import type { UserImageMeta } from '../engine/userImages';
import { TIMES } from '../core/sky';
import { FOCAL_PRESETS, FSTOP_PRESETS } from '../core/lens';
import { ALIGNS, FONTS, FONT_LABEL, MAX_TEXT_LENGTH, isFontLoaded, missingChars } from '../core/text';
import type { FontId, TextData } from '../core/text';
import { loadFont } from '../engine/fonts';
import { RIGID_SHAPES, RIGID_TYPES } from '../core/physics';
import { PARTICLE_PRESETS, PARTICLE_SHAPES, crestFrames } from '../core/particles';
import type { ParticleSettings } from '../core/particles';
import type { Surge, WaterSettings } from '../core/ocean';
import { DEFAULT_SURGE } from '../core/ocean';
import { SHAKE_PRESETS } from '../core/shake';
import { DEFAULT_FLASH_COLOR, FIELD_PRESETS, FIELD_TYPES } from '../core/fields';
import type { ForceField } from '../core/fields';
import type { RigidBody } from '../core/physics';
import { bakePhysics, freePhysics } from './physicsUi';
import { prepareBooleans } from './prepare';
import type { Quality, Store } from '../core/store';
import { DEFAULT_GLOW_COLOR, PATTERNS } from '../core/patterns';
import type { Pattern, PatternType } from '../core/patterns';
import type { TimeOfDay } from '../core/sky';
import { worldOf } from '../core/types';
import { EASINGS, animationOf, baseTransformAt, isAnimated, transformAt, transformEdit } from '../core/animation';
import type { Easing } from '../core/animation';
import type { Background } from '../core/types';
import { canEdit, setSmooth, setSubdivision, togglePose } from './editing';
import { poseAt, poseEdit } from '../core/rig';
import { transformVerts } from '../core/mesh/ops';
import { centroid } from '../core/mesh/topology';
import { MAX_SLOTS, slotOf } from '../core/mesh/materialIndex';
import { convertMode, flush } from '../core/mesh/select';

const AXES = ['x', 'y', 'z'] as const;

const PATTERN_LABEL: Record<PatternType, string> = { noise: 'Noise', voronoi: 'Voronoi (cells)', checker: 'Checker', bricks: 'Bricks', wood: 'Wood', marble: 'Marble', gradient: 'Gradient', windows: 'Windows (building)' };
const PATTERN_DEFAULTS: Record<PatternType, Pattern> = {
  noise: { type: 'noise', colorA: '#3b3f44', colorB: '#a9adb2', scale: 1, bump: 0.25 },
  voronoi: { type: 'voronoi', colorA: '#20252b', colorB: '#8a939c', scale: 1, bump: 0.4 },
  checker: { type: 'checker', colorA: '#1d1d1d', colorB: '#e8e8e8', scale: 1, bump: 0 },
  bricks: { type: 'bricks', colorA: '#c9c2b4', colorB: '#8e3b2a', scale: 0.8, bump: 0.6 },
  wood: { type: 'wood', colorA: '#5a3418', colorB: '#b07a45', scale: 0.6, bump: 0.15 },
  marble: { type: 'marble', colorA: '#ebe8e2', colorB: '#4d4f55', scale: 0.4, bump: 0 },
  gradient: { type: 'gradient', colorA: '#1b2a49', colorB: '#f2a65a', scale: 1, bump: 0 },
  windows: { type: 'windows', colorA: '#2b3a48', colorB: '#d8cdb8', scale: 0.333, bump: 0.5 },
};
/** What carries over when switching pattern type: the colours and any glow. */
const keepPatternLook = (p: Pattern): Partial<Pattern> => ({ colorA: p.colorA, colorB: p.colorB, ...(p.glow ? { glow: p.glow, glowColor: p.glowColor } : {}) });
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
  const images = useUserImages();
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
    // (Stays on the Mesh tab: shaping a shape key happens there.)
    if (editId) setTabState((t) => (t === 'data' ? t : 'object'));
  }, [editId]);

  // Material slot shown in the Material tab (0 = main material).
  const [matSlot, setMatSlot] = useState(0);

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

  // The material being edited: the main one, or a slot (2, 3… in Blender's list).
  const slot = Math.min(matSlot, o.materialSlots?.length ?? 0);
  const mat = slot ? o.materialSlots![slot - 1] : o.material;

  // Animated objects show (and edit, via auto-key) their pose at the current frame.
  const shown = baseTransformAt(doc, o.id, frame) ?? o.transform;
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
  const tabs: [PropTab, string][] = [['scene', 'Scene'], ['object', 'Object'], ['constraints', 'Constraints']];
  if (canEdit(o)) tabs.push(['modifiers', 'Modifiers'], ['physics', 'Physics']);
  else if (o.type === 'empty') tabs.push(['physics', 'Physics']);
  const dataLabel = o.text ? 'Text' : o.water ? 'Water' : o.light ? 'Light' : o.type === 'model' ? 'Model' : o.type === 'armature' ? 'Armature' : o.modifiers?.curve ? 'Curve' : canEdit(o) && !o.terrain ? 'Mesh' : null;
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

      {!o.modifiers?.curve && <FollowSection id={o.id} />}
      <DriversSection id={o.id} />

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
      {cur === 'data' && o.modifiers?.curve && <CurveSection id={o.id} />}
      {cur === 'data' && o.water && <WaterSection id={o.id} />}
      {cur === 'constraints' && <ConstraintsSection id={o.id} />}
      {cur === 'data' && canEdit(o) && !o.modifiers?.curve && !o.text && !o.water && !o.terrain && <VertexGroupsSection id={o.id} />}
      {cur === 'data' && canEdit(o) && !o.modifiers?.curve && !o.text && !o.water && !o.terrain && <ShapeKeysSection id={o.id} />}
      {cur === 'modifiers' && <ModifiersSection id={o.id} />}
      {cur === 'physics' && o.type === 'empty' && <FieldSection id={o.id} />}
      {cur === 'physics' && o.type !== 'empty' && <PhysicsSection id={o.id} />}
      {cur === 'physics' && !o.water && o.type !== 'empty' && <FloatSection id={o.id} />}
      {cur === 'data' && o.type === 'armature' && <PoseSection id={o.id} />}

      {cur === 'material' && (
        <Section title="Material">
          {o.type === 'mesh' && <SlotsBar o={o} slot={slot} setSlot={setMatSlot} />}
          <label className="prop-row">
            <span>Texture</span>
            <select
              id="mat-texture"
              aria-label="Texture"
              value={mat.texture ?? ''}
              onChange={async (e) => {
                const v = e.target.value;
                if (v === '__upload') {
                  const id = await uploadImage(store);
                  if (id) store.dispatch({ type: 'setMaterial', id: o.id, slot, material: { texture: id, baseColor: '#ffffff', textureScale: 1, pattern: null } }, { select: false });
                  return;
                }
                // Your images map once onto a UV map (or 1 per metre without one); library textures keep their repeat.
                store.dispatch({ type: 'setMaterial', id: o.id, slot, material: v ? { texture: v, baseColor: '#ffffff', ...(isUserImage(v) ? { textureScale: 1 } : {}) } : { texture: null } }, { select: false });
              }}
            >
              <option value="">None (plain colour)</option>
              {images.length > 0 && (
                <optgroup label="Your images">
                  {images.map((im) => (
                    <option key={im.id} value={im.id}>{im.name}</option>
                  ))}
                </optgroup>
              )}
              <option value="__upload">Upload an image…</option>
              <optgroup label="Library">
                {catalog?.textures.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </optgroup>
            </select>
          </label>
          {isUserImage(mat.texture) && o.type === 'mesh' && !o.mesh?.uv && (
            <p className="prop-hint">
              The picture is projected from the sides in metres. For it to fit the model, unwrap it:{' '}
              <button className="link-btn" data-testid="mat-unwrap" onClick={() => store.dispatch({ type: 'unwrap', id: o.id }, { select: false })}>Smart UV Project</button>
            </p>
          )}
          {mat.texture && scalar('Repeat', mat.textureScale, 0.01, 1000, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { textureScale: v } }), 0.1)}
          {!mat.texture && (
            <label className="prop-row">
              <span>Pattern</span>
              <select
                id="mat-pattern"
                aria-label="Procedural pattern"
                value={mat.pattern?.type ?? ''}
                onChange={(e) => {
                  const t = e.target.value as PatternType | '';
                  store.dispatch({ type: 'setMaterial', id: o.id, slot, material: { pattern: t ? { ...PATTERN_DEFAULTS[t], ...(mat.pattern ? keepPatternLook(mat.pattern) : {}), type: t } : null } }, { select: false });
                }}
              >
                <option value="">None</option>
                {PATTERNS.map((t) => (
                  <option key={t} value={t}>{PATTERN_LABEL[t]}</option>
                ))}
              </select>
            </label>
          )}
          {!mat.texture && mat.pattern && (() => {
            const p = mat.pattern;
            const setP = (patch: Partial<Pattern>): Command => ({ type: 'setMaterial', id: o.id, slot, material: { pattern: { ...p, ...patch } } });
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
                {scalar('Glow', p.glow ?? 0, 0, 100, (v) => setP({ glow: v }), 0.1)}
                {!!p.glow && (
                  <label className="prop-row">
                    <span>Glow colour</span>
                    <input type="color" aria-label="Pattern glow colour" value={p.glowColor ?? DEFAULT_GLOW_COLOR} onChange={(e) => store.preview(setP({ glowColor: e.target.value }))} onBlur={() => store.commitPreview()} />
                  </label>
                )}
              </>
            );
          })()}
          <label className="prop-row">
            <span>Base Color</span>
            <input
              type="color"
              id="mat-base"
              aria-label="Base color"
              value={mat.baseColor}
              onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, slot, material: { baseColor: e.target.value } })}
              onBlur={() => store.commitPreview()}
            />
          </label>
          {scalar('Metallic', mat.metallic, 0, 1, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { metallic: v } }))}
          {scalar('Roughness', mat.roughness, 0, 1, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { roughness: v } }))}
          {scalar('Alpha', mat.alpha, 0, 1, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { alpha: v } }))}
          <label className="prop-row">
            <span>Emission</span>
            <input
              type="color"
              id="mat-emission"
              aria-label="Emission color"
              value={mat.emission}
              onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, slot, material: { emission: e.target.value, emissionStrength: mat.emissionStrength || 1 } })}
              onBlur={() => store.commitPreview()}
            />
          </label>
          {scalar('Strength', mat.emissionStrength, 0, 100, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { emissionStrength: v } }), 0.1)}
          <details className="mat-more" open={!!(mat.clearcoat || mat.sheen || mat.transmission || mat.subsurface || mat.anisotropy)}>
            <summary>More: clearcoat, glass, sheen, skin…</summary>
            {(['clearcoat', 'clearcoatRoughness', 'transmission', 'sheen', 'subsurface', 'anisotropy'] as const).map((k) =>
              scalar(EXTRA_LABEL[k], mat[k] ?? (k === 'clearcoatRoughness' ? 0.03 : 0), 0, 1, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { [k]: v } })),
            )}
            {(mat.transmission ?? 0) > 0 && scalar('IOR', mat.ior ?? 1.5, 1, 3, (v) => ({ type: 'setMaterial', id: o.id, slot, material: { ior: v } }))}
            {(mat.sheen ?? 0) > 0 && (
              <label className="prop-row">
                <span>Sheen colour</span>
                <input type="color" aria-label="Sheen colour" value={mat.sheenColor ?? '#ffffff'} onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, slot, material: { sheenColor: e.target.value } })} onBlur={() => store.commitPreview()} />
              </label>
            )}
            {(mat.subsurface ?? 0) > 0 && (
              <label className="prop-row">
                <span>Subsurface colour</span>
                <input type="color" aria-label="Subsurface colour" value={mat.subsurfaceColor ?? '#ff6040'} onChange={(e) => store.preview({ type: 'setMaterial', id: o.id, slot, material: { subsurfaceColor: e.target.value } })} onBlur={() => store.commitPreview()} />
              </label>
            )}
            <div className="mat-presets">
              {MATERIAL_PRESETS.map((pr) => (
                <button key={pr.name} className="btn" data-mat-preset={pr.name} onClick={() => store.dispatch({ type: 'setMaterial', id: o.id, slot, material: pr.material }, { select: false })}>{pr.name}</button>
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

type PropTab = 'scene' | 'object' | 'constraints' | 'modifiers' | 'physics' | 'data' | 'material';

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
      <ShakeSection />
      <ScenePhysicsSection />
      <WorldSection />
    </>
  );
}

const TIME_LABEL: Record<TimeOfDay, string> = { sunrise: 'Sunrise', morning: 'Morning', noon: 'Noon', afternoon: 'Late afternoon', sunset: 'Sunset', dusk: 'Dusk', night: 'Night (moon)', overcast: 'Overcast', misty: 'Misty morning' };

/** Scene-wide look for Rendered shading: HDRI sky, exposure, bloom, ambient occlusion. */
/** Camera shake bursts (impacts, explosions, earthquakes) on top of the camera's motion. */
function ShakeSection() {
  const { store } = useCtx();
  const anim = useApp((s) => s.doc.animation);
  const frame = useApp((s) => s.frame);
  const { fps } = animationOf({ animation: anim });
  const shakes = anim?.shakes ?? [];
  return (
    <Section title="Camera shake" defaultOpen={shakes.length > 0}>
      <div className="prop-row">
        <span>Add at frame {frame}</span>
      </div>
      <div className="seg-text" role="group" aria-label="Camera shake presets">
        {SHAKE_PRESETS.map((p) => (
          <button key={p.id} data-shake={p.id} onClick={() => store.dispatch({ type: 'addCameraShake', start: frame, end: frame + Math.round(p.seconds * fps), ...p.shake }, { select: false })}>
            {p.label}
          </button>
        ))}
      </div>
      {shakes.map((s) => (
        <div className="prop-row" key={s.start} data-shake-item={s.start}>
          <span>
            Frames {s.start}–{s.end} · {s.strength} m{s.frequency ? ` · ${s.frequency}/s` : ''}
          </span>
          <button className="btn" aria-label={`Remove the shake at frame ${s.start}`} onClick={() => store.dispatch({ type: 'removeCameraShake', start: s.start }, { select: false })}>
            ✕
          </button>
        </div>
      ))}
      <p className="prop-hint">Shakes the scene camera from the current frame: a sharp hit that dies away. Seen through the camera (Camera view) and in videos — for impacts, explosions and earthquakes.</p>
    </Section>
  );
}

/** Scene camera lens (Blender's camera data): focal length and depth of field. */
/** The scene camera flies along a curve (fly-throughs). */
function CameraFollowRows() {
  const { store } = useCtx();
  const doc = useApp((s) => s.doc);
  const cf = doc.animation?.cameraFollow;
  const curves = doc.order.filter((x) => doc.objects[x]?.modifiers?.curve);
  if (!curves.length && !cf) return null;
  const { start, end } = animationOf(doc);
  const set = (patch: Partial<CameraFollow> | null) => store.dispatch({ type: 'setCameraFollow', follow: patch === null ? null : ({ ...(cf ?? { curve: '', start, end, look: 'ahead', height: 1.6 }), ...patch } as CameraFollow) }, { select: false });
  return (
    <>
      <label className="prop-row">
        <span>Follow path</span>
        <select aria-label="Camera follow curve" value={cf?.curve ?? ''} onChange={(e) => set(e.target.value ? { curve: e.target.value } : null)}>
          <option value="">None (keys)</option>
          {curves.map((x) => (
            <option key={x} value={x}>
              {doc.objects[x].name}
            </option>
          ))}
        </select>
      </label>
      {cf && (
        <>
          <label className="prop-row">
            <span>Look at</span>
            <select aria-label="Camera look at" value={cf.look} onChange={(e) => set({ look: e.target.value })}>
              <option value="ahead">Along the path</option>
              {doc.order.filter((x) => !doc.objects[x]?.modifiers?.curve).map((x) => (
                <option key={x} value={x}>
                  {doc.objects[x].name}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Height above path" value={cf.height ?? 0} step={0.1} dragRate={0.02} suffix=" m" onPreview={() => {}} onCommit={(v) => set({ height: v })} onCancel={() => {}} />
          <NumberField label="From frame" value={cf.start} step={1} dragRate={0.2} onPreview={() => {}} onCommit={(v) => set({ start: Math.round(Math.min(v, cf.end - 1)) })} onCancel={() => {}} />
          <NumberField label="To frame" value={cf.end} step={1} dragRate={0.2} onPreview={() => {}} onCommit={(v) => set({ end: Math.round(Math.max(v, cf.start + 1)) })} onCancel={() => {}} />
        </>
      )}
    </>
  );
}

/** Curve objects (Blender: Object Data → Shape / Geometry): the tube, smoothness, closed loop. */
/** Vertex Groups (Blender's Object Data → Vertex Groups): the list, + / −, rename, Weight Paint. */
function VertexGroupsSection({ id }: { id: string }) {
  const ctx = useCtx();
  const { store } = ctx;
  const vg = useApp((s) => s.doc.objects[id]?.vertexGroups);
  const skinned = useApp((s) => !!s.doc.objects[id]?.skin);
  const painting = useApp((s) => s.weightPaint?.id === id);
  const run = (cmd: Command) => store.dispatch(cmd, { select: false });
  return (
    <Section title="Vertex Groups" defaultOpen={!!vg || skinned}>
      {vg && (
        <div className="sk-list" data-testid="vertex-groups">
          {vg.groups.map((g, i) => (
            <div key={i} className={`sk-row${vg.active === i ? ' active' : ''}`} data-vg={i}>
              <input type="radio" name={`vg-${id}`} aria-label={`Use ${g.name}`} checked={vg.active === i} onChange={() => run({ type: 'setActiveVertexGroup', id, index: i })} />
              <input
                className="sk-name"
                aria-label="Vertex group name"
                defaultValue={g.name}
                key={g.name}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== g.name && run({ type: 'setVertexGroup', id, index: i, name: e.target.value.trim().slice(0, 64) })}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            </div>
          ))}
        </div>
      )}
      <div className="prop-actions">
        <button className="btn" data-testid="vg-add" onClick={() => run({ type: 'addVertexGroup', id })}>+ Group</button>
        {vg && (
          <button className="btn" data-testid="vg-remove" onClick={() => run({ type: 'removeVertexGroup', id, index: vg.active })}>
            − Group
          </button>
        )}
        <button className="btn" data-testid="vg-paint" onClick={() => runAction(ctx, 'mode.weight')}>{painting ? 'Stop painting' : 'Weight Paint'}</button>
      </div>
      <p className="prop-hint">
        {skinned
          ? 'Groups named after bones decide how much each bone moves each part (red 1 = fully, blue 0 = not at all). Weight Paint starts from the automatic weights.'
          : 'A vertex group is a weight 0..1 on every point. Name groups after an armature’s bones to skin this mesh by hand.'}
      </p>
    </Section>
  );
}

/**
 * Shape Keys (Blender's Object Data → Shape Keys): the list with the active key, each key's
 * value slider (◆ keyframes it at this frame), + / − and the edit hint.
 */
function ShapeKeysSection({ id }: { id: string }) {
  const { store } = useCtx();
  const sk = useApp((s) => s.doc.objects[id]?.shapeKeys);
  const tracks = useApp((s) => s.doc.animation?.shapes?.[id]);
  const frame = useApp((s) => s.frame);
  const editing = useApp((s) => s.edit?.id === id);
  const run = (cmd: Command) => store.dispatch(cmd, { select: false });
  const valueNow = (i: number) => {
    const k = sk!.keys[i];
    const t = tracks?.[k.name];
    return t?.length ? (evaluateValue(t, frame) ?? k.value) : k.value;
  };
  const setValue = (i: number, v: number, preview: boolean) => {
    const k = sk!.keys[i];
    const val = Math.max(k.min ?? 0, Math.min(k.max ?? 1, Math.round(v * 1000) / 1000));
    // Animated values: changing it keys it at this frame (auto-key), like transforms.
    const cmd: Command = tracks?.[k.name]?.length ? { type: 'keyShape', id, key: k.name, frame, value: val } : { type: 'setShapeKey', id, index: i, value: val };
    if (preview) store.preview(cmd);
    else run(cmd);
  };
  return (
    <Section title="Shape Keys">
      {sk && (
        <div className="sk-list" data-testid="shape-keys">
          {sk.keys.map((k, i) => {
            const keyed = !!tracks?.[k.name]?.some((x) => x.frame === frame);
            return (
              <div key={i} className={`sk-row${sk.active === i ? ' active' : ''}`} data-sk={i}>
                <input type="radio" name={`sk-${id}`} aria-label={`Edit ${k.name}`} checked={sk.active === i} onChange={() => run({ type: 'setActiveShapeKey', id, index: i })} />
                <input
                  className="sk-name"
                  aria-label="Shape key name"
                  defaultValue={k.name}
                  key={k.name}
                  onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== k.name && run({ type: 'setShapeKey', id, index: i, name: e.target.value.trim().slice(0, 64) })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                {i > 0 && (
                  <>
                    <input
                      type="range"
                      className="sk-slider"
                      aria-label={`${k.name} value`}
                      min={k.min ?? 0}
                      max={k.max ?? 1}
                      step={0.01}
                      value={valueNow(i)}
                      onChange={(e) => setValue(i, Number(e.target.value), true)}
                      onPointerUp={() => store.commitPreview()}
                      onKeyUp={() => store.commitPreview()}
                      onBlur={() => store.commitPreview()}
                    />
                    <span className="sk-val">{valueNow(i).toFixed(2)}</span>
                    <button
                      className={`sk-key${keyed ? ' on' : tracks?.[k.name]?.length ? ' anim' : ''}`}
                      aria-label={`Keyframe ${k.name}`}
                      title={keyed ? 'Remove the keyframe at this frame' : 'Insert a keyframe at this frame'}
                      onClick={() => run(keyed ? { type: 'unkeyShape', id, key: k.name, frame } : { type: 'keyShape', id, key: k.name, frame, value: valueNow(i) })}
                    >
                      ◆
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="prop-actions">
        <button className="btn" data-testid="sk-add" title="Add a shape key (the first one is the Basis)" onClick={() => run({ type: 'addShapeKey', id })}>
          + {sk ? 'Shape key' : 'Add Basis'}
        </button>
        {sk && sk.keys.length > 1 && (
          <button className="btn" data-testid="sk-from-mix" title="A new key from the current mix of keys" onClick={() => run({ type: 'addShapeKey', id, fromMix: true })}>
            New from Mix
          </button>
        )}
        {sk && (
          <button className="btn" data-testid="sk-remove" title={sk.active === 0 ? 'Remove all shape keys (keeps the Basis shape)' : 'Remove the active shape key'} onClick={() => run({ type: 'removeShapeKey', id, index: sk.active })}>
            − {sk.active === 0 ? 'All' : 'Key'}
          </button>
        )}
      </div>
      <p className="prop-hint">
        {!sk
          ? 'Shape keys store other shapes of this mesh (a smile, a blink, a squash) and blend them in with a slider you can animate.'
          : sk.active === 0
            ? 'Editing the Basis: changes here move every key with it. Pick a key above, then Tab (or Sculpt) to shape it.'
            : editing
              ? `Editing “${sk.keys[sk.active].name}”: move points to make this shape. Adding or removing points needs the Basis.`
              : `Tab (or Sculpt) to shape “${sk.keys[sk.active].name}”. Slide its value to blend it in; ◆ keyframes the value.`}
      </p>
    </Section>
  );
}

function CurveSection({ id }: { id: string }) {
  const { store } = useCtx();
  const c = useApp((s) => s.doc.objects[id]?.modifiers?.curve);
  const n = useApp((s) => s.doc.objects[id]?.mesh?.vertices.length ?? 0);
  if (!c) return null;
  const set = (patch: Record<string, unknown>, preview = false) => {
    const cmd: Command = { type: 'setModifiers', id, modifiers: { curve: patch } } as Command;
    if (preview) store.preview(cmd);
    else store.dispatch(cmd, { select: false });
  };
  const num = (key: 'bevel' | 'resolution' | 'sides', label: string, lo: number, hi: number, step: number, suffix = '', int = false) => (
    <NumberField
      label={label}
      value={c[key]}
      step={step}
      dragRate={step / 4}
      suffix={suffix}
      onPreview={(v) => set({ [key]: Math.max(lo, Math.min(hi, int ? Math.round(v) : v)) }, true)}
      onCommit={(v) => {
        set({ [key]: Math.max(lo, Math.min(hi, int ? Math.round(v) : v)) }, true);
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  return (
    <Section title="Curve">
      <div className="prop-row"><span>Points</span><b>{n}</b></div>
      {num('bevel', 'Bevel depth (tube radius)', 0, 20, 0.01, ' m')}
      {num('resolution', 'Resolution', 1, 64, 1, '', true)}
      {num('sides', 'Sides', 3, 32, 1, '', true)}
      <label className="prop-row">
        <span>Cyclic (closed)</span>
        <input type="checkbox" aria-label="Cyclic" checked={c.cyclic} onChange={(e) => set({ cyclic: e.target.checked })} />
      </label>
      <p className="prop-hint">Tab to move the points; E adds a point past an end, X deletes. Other objects (and the camera) can follow this curve.</p>
      <div className="prop-actions">
        <button className="btn" data-testid="curve-convert" title="Turn the tube into an editable mesh (Blender: Convert → Mesh)" onClick={() => store.dispatch({ type: 'applyModifiers', id }, { select: false })}>
          Convert to Mesh
        </button>
      </div>
    </Section>
  );
}

/** Follow Path (Blender's constraint): move along a curve between two frames. */
/**
 * Object Constraints (Blender's constraint tab): a stack run top to bottom after keyframes and
 * Follow Path. Each has a target, its own settings and an Influence.
 */
function ConstraintsSection({ id }: { id: string }) {
  const { store } = useCtx();
  const list = useApp((s) => s.doc.objects[id]?.constraints);
  const doc = useApp((s) => s.doc);
  const others = doc.order.filter((x) => x !== id);
  const run = (cmd: Command) => store.dispatch(cmd, { select: false });
  const set = (index: number, patch: Partial<Constraint>) => run({ type: 'setConstraint', id, index, patch });
  const firstTarget = others.find((x) => doc.objects[x].type !== 'armature') ?? others[0];
  return (
    <>
      <div className="prop-actions con-add">
        <select
          aria-label="Add Object Constraint"
          data-testid="con-add"
          value=""
          disabled={!firstTarget || (list?.length ?? 0) >= MAX_CONSTRAINTS}
          onChange={(e) => e.target.value && firstTarget && run({ type: 'addConstraint', id, constraint: { type: e.target.value as ConstraintType, target: firstTarget } })}
        >
          <option value="">+ Add Object Constraint</option>
          {CONSTRAINT_TYPES.map((t) => (
            <option key={t} value={t}>
              {CONSTRAINT_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      {!firstTarget && <p className="prop-hint">Constraints need another object to look at or copy from. Add one first.</p>}
      {list?.map((c, i) => (
        <div key={i} className={`con-card${c.mute ? ' muted' : ''}`} data-con={i}>
          <div className="con-head">
            <span className="con-title">{CONSTRAINT_LABELS[c.type]}</span>
            <button className="icon-btn" aria-label={c.mute ? 'Turn on' : 'Turn off'} title={c.mute ? 'Turn on' : 'Turn off'} onClick={() => set(i, { mute: !c.mute })}>
              {c.mute ? '◌' : '●'}
            </button>
            <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => run({ type: 'moveConstraint', id, index: i, to: i - 1 })}>↑</button>
            <button className="icon-btn" aria-label="Move down" disabled={i === list.length - 1} onClick={() => run({ type: 'moveConstraint', id, index: i, to: i + 1 })}>↓</button>
            <button className="icon-btn" aria-label="Remove constraint" onClick={() => run({ type: 'removeConstraint', id, index: i })}>✕</button>
          </div>
          <label className="prop-row">
            <span>Target</span>
            <select aria-label="Constraint target" value={c.target} onChange={(e) => set(i, { target: e.target.value })}>
              {others.map((x) => (
                <option key={x} value={x}>
                  {doc.objects[x].name}
                </option>
              ))}
            </select>
          </label>
          {c.type === 'trackTo' && (
            <label className="prop-row">
              <span>Track axis</span>
              <select aria-label="Track axis" value={c.axis ?? 'Y'} onChange={(e) => set(i, { axis: e.target.value as TrackAxis })}>
                {TRACK_AXES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(c.type === 'copyLocation' || c.type === 'copyScale') && (
            <div className="prop-row con-axes">
              <span>Axes</span>
              {(['x', 'y', 'z'] as const).map((k) => (
                <label key={k} className="con-axis">
                  <input type="checkbox" aria-label={`Copy ${k.toUpperCase()}`} checked={c[k] !== false} onChange={(e) => set(i, { [k]: e.target.checked })} />
                  {k.toUpperCase()}
                </label>
              ))}
            </div>
          )}
          {c.type === 'copyLocation' && (
            <label className="prop-row">
              <span>Offset (add its own location)</span>
              <input type="checkbox" aria-label="Offset" checked={!!c.offset} onChange={(e) => set(i, { offset: e.target.checked })} />
            </label>
          )}
          {c.type === 'limitDistance' && (
            <>
              <NumberField label="Distance" value={c.distance ?? 1} step={0.1} dragRate={0.02} suffix=" m" onPreview={(v) => store.preview({ type: 'setConstraint', id, index: i, patch: { distance: Math.max(0, v) } })} onCommit={(v) => { store.preview({ type: 'setConstraint', id, index: i, patch: { distance: Math.max(0, v) } }); store.commitPreview(); }} onCancel={() => store.cancelPreview()} />
              <label className="prop-row">
                <span>Clamp region</span>
                <select aria-label="Limit mode" value={c.mode ?? 'inside'} onChange={(e) => set(i, { mode: e.target.value as Constraint['mode'] })}>
                  <option value="inside">Inside</option>
                  <option value="outside">Outside</option>
                  <option value="on">On surface</option>
                </select>
              </label>
            </>
          )}
          <NumberField
            label="Influence"
            value={c.influence}
            step={0.05}
            dragRate={0.01}
            onPreview={(v) => store.preview({ type: 'setConstraint', id, index: i, patch: { influence: Math.max(0, Math.min(1, v)) } })}
            onCommit={(v) => {
              store.preview({ type: 'setConstraint', id, index: i, patch: { influence: Math.max(0, Math.min(1, v)) } });
              store.commitPreview();
            }}
            onCancel={() => store.cancelPreview()}
          />
        </div>
      ))}
      <p className="prop-hint">
        {list?.length
          ? 'Constraints run top to bottom after keyframes. The Location / Rotation / Scale fields still show the object’s own values.'
          : 'Track To keeps an object (or a light) facing another; Copy Location / Rotation / Scale glue it to one; Limit Distance keeps it on a leash.'}
      </p>
    </>
  );
}

/**
 * Drivers (Blender's Add Driver): a channel computed every frame from an expression of other
 * objects' values. Expressions are safe maths (core/expr.ts), never code.
 */
function DriversSection({ id }: { id: string }) {
  const { store } = useCtx();
  const list = useApp((s) => s.doc.objects[id]?.drivers);
  const doc = useApp((s) => s.doc);
  const frame = useApp((s) => s.frame);
  const o = doc.objects[id];
  const others = doc.order.filter((x) => x !== id);
  const run = (cmd: Command) => store.dispatch(cmd, { select: false });
  const set = (index: number, patch: Partial<Driver>) => run({ type: 'setDriver', id, index, patch });
  const shapeProps = (o?.shapeKeys?.keys.slice(1) ?? []).map((k) => `shape:${k.name}`);
  const props = [...CHANNELS, ...shapeProps];
  const free = props.filter((p) => !list?.some((d) => d.property === p));
  const add = () => {
    const property = (free.includes('rotation.z') ? 'rotation.z' : free[0]) as string;
    const src = others[0];
    run({ type: 'addDriver', id, driver: src ? { property, expression: 'var', vars: [{ name: 'var', object: src, channel: 'location.x' }] } : { property, expression: 'frame', vars: [] } });
  };
  const fps = doc.animation?.fps ?? 24;
  const read = (t: string, c: Channel) => (doc.objects[t] ? channelOf(transformAt(doc, t, frame, 1) ?? doc.objects[t].transform, c) : null);
  return (
    <Section title="Drivers" defaultOpen={!!list?.length}>
      {list?.map((d, i) => {
        const problem = driverProblem(d);
        const value = problem ? null : driverValue({ ...d, mute: false }, frame, fps, read);
        return (
          <div key={i} className={`con-card${d.mute ? ' muted' : ''}`} data-driver={i}>
            <div className="con-head">
              <select className="con-title drv-prop" aria-label="Driven property" value={d.property} onChange={(e) => set(i, { property: e.target.value })}>
                {props.filter((p) => p === d.property || free.includes(p)).map((p) => (
                  <option key={p} value={p}>
                    {p.startsWith('shape:') ? `Shape key: ${p.slice(6)}` : CHANNEL_LABELS[p as Channel]}
                  </option>
                ))}
              </select>
              <button className="icon-btn" aria-label={d.mute ? 'Turn on' : 'Turn off'} title={d.mute ? 'Turn on' : 'Turn off'} onClick={() => set(i, { mute: !d.mute })}>
                {d.mute ? '◌' : '●'}
              </button>
              <button className="icon-btn" aria-label="Remove driver" onClick={() => run({ type: 'removeDriver', id, index: i })}>✕</button>
            </div>
            <label className="prop-row drv-expr">
              <span>Expression</span>
              <input
                aria-label="Driver expression"
                key={d.expression}
                defaultValue={d.expression}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={MAX_EXPR}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (val && val !== d.expression) set(i, { expression: val });
                  // Refused (not maths): show what's stored again.
                  const kept = store.getState().doc.objects[id]?.drivers?.[i]?.expression;
                  if (kept !== undefined && kept !== val) e.target.value = kept;
                }}
              />
            </label>
            <p className={`prop-hint${problem ? ' drv-err' : ''}`} data-testid="driver-value">
              {problem ? problem : `= ${value === null ? '—' : +value.toFixed(4)}${d.mute ? ' (off)' : ''}`}
            </p>
            {d.vars.map((v, j) => (
              <div key={j} className="prop-row drv-var">
                <input
                  className="drv-name"
                  aria-label="Variable name"
                  key={v.name}
                  defaultValue={v.name}
                  spellCheck={false}
                  autoCapitalize="off"
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name === v.name) return;
                    if (!isVarName(name)) {
                      store.notify('Variable names are letters, digits and _ (not frame, time, pi)');
                      e.target.value = v.name;
                      return;
                    }
                    // Renaming a variable renames it in the expression too.
                    const expression = d.expression.replace(new RegExp(`\\b${v.name}\\b`, 'g'), name);
                    set(i, { vars: d.vars.map((x, k) => (k === j ? { ...x, name } : x)), expression });
                  }}
                />
                <select aria-label="Variable object" value={v.object} onChange={(e) => set(i, { vars: d.vars.map((x, k) => (k === j ? { ...x, object: e.target.value } : x)) })}>
                  {others.map((x) => (
                    <option key={x} value={x}>
                      {doc.objects[x].name}
                    </option>
                  ))}
                </select>
                <select aria-label="Variable channel" value={v.channel} onChange={(e) => set(i, { vars: d.vars.map((x, k) => (k === j ? { ...x, channel: e.target.value as Channel } : x)) })}>
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABELS[c]}
                    </option>
                  ))}
                </select>
                <button className="icon-btn" aria-label="Remove variable" onClick={() => set(i, { vars: d.vars.filter((_, k) => k !== j) })}>✕</button>
              </div>
            ))}
            {others.length > 0 && d.vars.length < MAX_DRIVER_VARS && (
              <button
                className="btn drv-addvar"
                onClick={() => {
                  let n = 1;
                  while (d.vars.some((x) => x.name === `var${n}`)) n++;
                  set(i, { vars: [...d.vars, { name: d.vars.length ? `var${n}` : 'var', object: others[0], channel: 'location.x' }] });
                }}
              >
                + Variable
              </button>
            )}
          </div>
        );
      })}
      <div className="prop-actions">
        <button className="btn" data-testid="driver-add" disabled={!free.length || (list?.length ?? 0) >= MAX_DRIVERS} onClick={add}>
          + Add Driver
        </button>
      </div>
      <p className="prop-hint">Maths only: + − * / ^ %, ( ), a &gt; b ? x : y, sin cos abs min max clamp lerp noise… plus frame and time (seconds). Rotations are in degrees.</p>
    </Section>
  );
}

function FollowSection({ id }: { id: string }) {
  const { store } = useCtx();
  const f = useApp((s) => s.doc.objects[id]?.follow);
  const curves = useApp((s) => s.doc.order.filter((x) => x !== id && s.doc.objects[x]?.modifiers?.curve).map((x) => ({ id: x, name: s.doc.objects[x].name })).join('|'));
  const list = curves ? curves.split('|') : [];
  const anim = useApp((s) => s.doc.animation);
  const { start, end } = animationOf({ animation: anim });
  const docNow = useApp((s) => s.doc);
  if (!list.length && !f) return null;
  const set = (patch: Partial<FollowPath> | null) =>
    store.dispatch({ type: 'setFollow', id, follow: patch === null ? null : ({ ...(f ?? { curve: '', start, end, orient: true }), ...patch } as FollowPath) }, { select: false });
  return (
    <Section title="Follow Path" defaultOpen={!!f}>
      <label className="prop-row">
        <span>Curve</span>
        <select aria-label="Follow curve" value={f?.curve ?? ''} onChange={(e) => set(e.target.value ? { curve: e.target.value } : null)}>
          <option value="">None</option>
          {docNow.order.filter((x) => x !== id && docNow.objects[x]?.modifiers?.curve).map((x) => (
            <option key={x} value={x}>
              {docNow.objects[x].name}
            </option>
          ))}
        </select>
      </label>
      {f && (
        <>
          <NumberField label="From frame" value={f.start} step={1} dragRate={0.2} onPreview={() => {}} onCommit={(v) => set({ start: Math.round(Math.min(v, f.end - 1)) })} onCancel={() => {}} />
          <NumberField label="To frame" value={f.end} step={1} dragRate={0.2} onPreview={() => {}} onCommit={(v) => set({ end: Math.round(Math.max(v, f.start + 1)) })} onCancel={() => {}} />
          <label className="prop-row">
            <span>Follow curve (turn along it)</span>
            <input type="checkbox" aria-label="Follow orient" checked={f.orient} onChange={(e) => set({ orient: e.target.checked })} />
          </label>
          <p className="prop-hint">Its Location is an offset from the path, its Rotation adds to the path's (+Y points forward).</p>
        </>
      )}
    </Section>
  );
}

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
      <CameraFollowRows />
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

/** Your uploaded images (kept fresh when one is added or removed). */
function useUserImages(): UserImageMeta[] {
  const [list, setList] = useState<UserImageMeta[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void listUserImages().then((l) => live && setList(l));
    load();
    const off = onUserImagesChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return list;
}

/** Pick a photo and store it; returns its texture id. */
async function uploadImage(store: Store): Promise<string | null> {
  const file = await pickFile('image/*');
  if (!file) return null;
  try {
    const meta = await saveUserImage(file, file.name);
    store.notify(`Image “${meta.name}” added (${meta.width}×${meta.height})`);
    return meta.id;
  } catch (e) {
    store.notify(e instanceof Error ? e.message : 'Could not read that image');
    return null;
  }
}

/**
 * Material slots (Blender's list in Material Properties): pick the material to edit, add or
 * remove slots, and in Edit Mode assign the selected faces to a slot or select its faces.
 */
function SlotsBar({ o, slot, setSlot }: { o: SceneObject; slot: number; setSlot: (s: number) => void }) {
  const { store } = useCtx();
  const edit = useApp((s) => (s.edit?.id === o.id ? s.edit : null));
  const mats = [o.material, ...(o.materialSlots ?? [])];
  const used = useMemo(() => {
    const m = o.mesh;
    const counts = mats.map(() => 0);
    if (m) m.faces.forEach((_, f) => counts[Math.min(slotOf(m, f), mats.length - 1)]++);
    return counts;
  }, [o.mesh, mats.length]);
  const swatch = (m: SceneObject['material']) => (m.pattern ? m.pattern.colorB : m.texture ? '#9a8f80' : m.baseColor);
  return (
    <>
      <div className="prop-row wrap">
        <span>Slots</span>
        <div className="seg-text" role="radiogroup" aria-label="Material slots">
          {mats.map((m, i) => (
            <button key={i} role="radio" aria-checked={slot === i} className={slot === i ? 'active' : ''} data-mat-slot={i} title={`${used[i]} face${used[i] === 1 ? '' : 's'}`} onClick={() => setSlot(i)}>
              <span className="slot-swatch" style={{ background: swatch(m) }} />
              {i === 0 ? 'Main' : `Slot ${i + 1}`}
            </button>
          ))}
          {mats.length <= MAX_SLOTS && (
            <button
              data-testid="mat-slot-add"
              title="Add a material slot (starts as a copy of the main material)"
              onClick={() => {
                store.dispatch({ type: 'setMaterial', id: o.id, slot: mats.length, material: {} }, { select: false });
                setSlot(mats.length);
              }}
            >
              +
            </button>
          )}
        </div>
      </div>
      {(slot > 0 || edit) && (
        <div className="prop-actions">
          {edit && (
            <>
              <button
                className="btn primary"
                data-testid="mat-assign"
                disabled={!edit.sel.faces.length}
                onClick={() => store.dispatch({ type: 'assignMaterial', id: o.id, slot, faces: edit.sel.faces }, { select: false })}
              >
                Assign to {edit.sel.faces.length} face{edit.sel.faces.length === 1 ? '' : 's'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  const m = o.mesh!;
                  const faces = m.faces.map((_, f) => f).filter((f) => slotOf(m, f) === slot);
                  store.setEdit({ ...edit, sel: convertMode(m, 'face', edit.mode, flush(m, 'face', { verts: [], edges: [], faces })) });
                }}
              >
                Select
              </button>
            </>
          )}
          {slot > 0 && (
            <button
              className="btn danger"
              onClick={() => {
                store.dispatch({ type: 'removeMaterialSlot', id: o.id, slot }, { select: false });
                setSlot(slot - 1);
              }}
            >
              Remove slot
            </button>
          )}
        </div>
      )}
      {mats.length > 1 && !edit && <p className="prop-hint">Faces use these materials by slot. In Edit Mode, select faces and press Assign.</p>}
    </>
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
          {r.type === 'passive' && (
            <label className="prop-row" title="Follows its keyframes and shoves active objects (Blender's Animated)">
              <span>Animated (follows its keys)</span>
              <input type="checkbox" data-testid="rigid-animated" checked={!!r.animated} onChange={(e) => set({ animated: e.target.checked })} />
            </label>
          )}
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
  const frame = useApp((s) => s.frame);
  const surge = useApp((s) => !!s.doc.objects[id].water?.surge);
  const set = (particles: Partial<ParticleSettings> | null) => store.dispatch({ type: 'setParticles', id, particles }, { select: false });
  // Wave spray runs while the giant wave is over the water; other presets come from the surface.
  const applyPreset = (pr: (typeof PARTICLE_PRESETS)[number]) => {
    if (pr.settings.emit === 'crest') {
      const st = store.getState();
      const span = crestFrames(st.doc.objects[id], st.doc.animation?.fps ?? 24);
      return set({ ...pr.settings, ...(span ?? {}) });
    }
    set(pr.burst ? { emit: undefined, ...pr.settings, start: frame, end: frame + pr.burst } : { emit: undefined, ...pr.settings });
  };
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
          {PARTICLE_PRESETS.filter((pr) => surge || pr.settings.emit !== 'crest').map((pr) => (
            <button key={pr.id} data-particle-preset={pr.id} onClick={() => applyPreset(pr)} title={pr.burst ? `Bursts at the current frame (${frame})` : pr.settings.emit === 'crest' ? 'Spray off the top of the giant wave while it crosses the water' : undefined}>
              {pr.label}
            </button>
          ))}
        </div>
      </div>
      {p && (
        <>
          {surge && (
            <label className="prop-row">
              <span>Emit from</span>
              <select aria-label="Emit from" value={p.emit ?? 'surface'} onChange={(e) => set({ emit: e.target.value === 'crest' ? 'crest' : undefined })}>
                <option value="surface">Surface</option>
                <option value="crest">Giant wave crest (spray)</option>
              </select>
            </label>
          )}
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
                <option key={sh} value={sh}>{sh === 'drop' ? 'Drop (stretched)' : sh === 'fire' ? 'Fire (glowing puffs)' : sh === 'smoke' ? 'Smoke (soft puffs)' : sh[0].toUpperCase() + sh.slice(1)}</option>
              ))}
            </select>
          </label>
          <label className="prop-row">
            <span>Colour</span>
            <input type="color" value={p.color} onChange={(e) => set({ color: e.target.value })} />
          </label>
          {num('glow', 'Glow', 0, 1, 0.1)}
          {([0, 1] as const).map((k) => (
            <NumberField
              key={k}
              label={k === 0 ? 'Wind X' : 'Wind Y'}
              value={p.wind?.[k] ?? 0}
              step={0.1}
              dragRate={0.01}
              suffix=" m/s²"
              onPreview={(v) => {
                const w: [number, number, number] = [...(p.wind ?? [0, 0, 0])];
                w[k] = clampN(v, -100, 100, false);
                store.preview({ type: 'setParticles', id, particles: { wind: w } });
              }}
              onCommit={(v) => {
                const w: [number, number, number] = [...(p.wind ?? [0, 0, 0])];
                w[k] = clampN(v, -100, 100, false);
                store.preview({ type: 'setParticles', id, particles: { wind: w } });
                store.commitPreview();
              }}
              onCancel={() => store.cancelPreview()}
            />
          ))}
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
      <p className="prop-hint">Particles fly off the object's surface, fall with gravity and vanish after their lifetime — sparks, fountains, rain, snow, debris, fire and smoke (negative gravity makes them rise; wind pushes them sideways). No baking: scrub and play. For rain or snow, use a big plane high up as the emitter. Fire and smoke look best in Rendered shading.</p>
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

/** Force field on an empty (Blender's Physics → Force Field): acts on rigid bodies in the bake. */
function FieldSection({ id }: { id: string }) {
  const { store } = useCtx();
  const f = useApp((s) => s.doc.objects[id].field);
  const frame = useApp((s) => s.frame);
  const set = (field: Partial<ForceField> | null) => store.dispatch({ type: 'setField', id, field }, { select: false });
  const num = (key: 'strength' | 'radius' | 'start' | 'end' | 'flash', label: string, lo: number, hi: number, step: number, suffix: string, int = false) => (
    <NumberField
      label={label}
      value={f![key] ?? 0}
      step={step}
      dragRate={step / 10}
      suffix={suffix}
      onPreview={(v) => store.preview({ type: 'setField', id, field: { [key]: clampN(v, lo, hi, int) } })}
      onCommit={(v) => {
        store.preview({ type: 'setField', id, field: { [key]: clampN(v, lo, hi, int) } });
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  return (
    <Section title="Force field" defaultOpen>
      <div className="seg-text" role="group" aria-label="Force field presets">
        {FIELD_PRESETS.map((p) => (
          <button key={p.id} data-field-preset={p.id} onClick={() => set(p.frames ? { flash: undefined, ...p.field, start: frame, end: frame + p.frames } : { flash: undefined, ...p.field, start: undefined, end: undefined })}>
            {p.label}
          </button>
        ))}
      </div>
      {f ? (
        <>
          <div className="prop-row">
            <span>Type</span>
            <div className="seg-text" role="radiogroup" aria-label="Field type">
              {FIELD_TYPES.map((t) => (
                <button key={t} role="radio" aria-checked={f.type === t} className={f.type === t ? 'active' : ''} onClick={() => set({ type: t })}>
                  {t === 'force' ? 'Force' : t === 'wind' ? 'Wind' : 'Vortex'}
                </button>
              ))}
            </div>
          </div>
          {num('strength', 'Strength', -100000, 100000, 5, ' m/s²')}
          {num('radius', 'Reach (0 = everywhere)', 0, 100000, 0.5, ' m')}
          <label className="prop-row">
            <span>Only some frames</span>
            <input type="checkbox" checked={f.start !== undefined} onChange={(e) => set(e.target.checked ? { start: frame, end: frame + 2 } : { start: undefined, end: undefined })} />
          </label>
          {f.start !== undefined && num('start', 'From frame', -100000, 100000, 1, '', true)}
          {f.end !== undefined && num('end', 'To frame', -100000, 100000, 1, '', true)}
          <label className="prop-row">
            <span>Light flash (lights up the area)</span>
            <input type="checkbox" aria-label="Light flash" checked={!!f.flash} onChange={(e) => set({ flash: e.target.checked ? 60000 : undefined })} />
          </label>
          {!!f.flash && (
            <>
              {num('flash', 'Flash power', 100, 10000000, 1000, ' W')}
              <label className="prop-row">
                <span>Flash colour</span>
                <input type="color" aria-label="Flash colour" value={f.flashColor ?? DEFAULT_FLASH_COLOR} onChange={(e) => store.preview({ type: 'setField', id, field: { flashColor: e.target.value } })} onBlur={() => store.commitPreview()} />
              </label>
            </>
          )}
          <div className="prop-actions">
            <button className="btn primary" onClick={() => void bakePhysics(store)}>Bake physics</button>
            <button className="btn" onClick={() => set(null)}>Remove field</button>
          </div>
        </>
      ) : null}
      <p className="prop-hint">
        Pushes rigid bodies when you bake physics: <b>Force</b> away from the centre (negative pulls in), <b>Wind</b> along the empty's blue (Z) axis, <b>Vortex</b> swirling around it. For an explosion: a
        big strength for 1–2 frames, aimed at fractured objects.
      </p>
    </Section>
  );
}

/** Float on water: the object rides the waves of the water under it. */
function FloatSection({ id }: { id: string }) {
  const { store } = useCtx();
  const f = useApp((s) => s.doc.objects[id].float);
  const hasWater = useApp((s) => Object.values(s.doc.objects).some((o) => o.water));
  if (!hasWater && !f) return null;
  return (
    <Section title="Float on water" defaultOpen>
      <label className="prop-row">
        <span>Float</span>
        <input type="checkbox" data-testid="float-toggle" checked={!!f} onChange={(e) => store.dispatch({ type: 'setFloat', id, float: e.target.checked ? { offset: 0 } : null }, { select: false })} />
      </label>
      {f && (
        <NumberField
          label="Height above water"
          value={f.offset}
          step={0.05}
          dragRate={0.005}
          suffix=" m"
          onPreview={(v) => store.preview({ type: 'setFloat', id, float: { offset: clampN(v, -100, 100, false) } })}
          onCommit={(v) => {
            store.preview({ type: 'setFloat', id, float: { offset: clampN(v, -100, 100, false) } });
            store.commitPreview();
          }}
          onCancel={() => store.cancelPreview()}
        />
      )}
      <p className="prop-hint">Bobs and tilts with the waves of the water under it (boats, buoys, debris). Negative height sinks it in: for a boat, about a third of its hull.</p>
    </Section>
  );
}

/** Water: ripples and ocean waves (Blender's Ocean modifier, simplified). */
function WaterSection({ id }: { id: string }) {
  const { store } = useCtx();
  const w = useApp((s) => s.doc.objects[id].water)!;
  const set = (water: Partial<WaterSettings>) => store.dispatch({ type: 'setWater', id, water }, { select: false });
  const field = (key: 'waves' | 'speed' | 'height' | 'direction', label: string, lo: number, hi: number, step: number, suffix: string) => (
    <NumberField
      label={label}
      value={w[key] ?? 0}
      step={step}
      dragRate={step / 10}
      suffix={suffix}
      onPreview={(v) => store.preview({ type: 'setWater', id, water: { [key]: clampN(v, lo, hi, false) } })}
      onCommit={(v) => {
        store.preview({ type: 'setWater', id, water: { [key]: clampN(v, lo, hi, false) } });
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  const seas: [string, number][] = [['Calm', 0], ['Choppy', 0.4], ['Rough', 1.5], ['Storm', 3.5]];
  return (
    <Section title="Water">
      <div className="prop-row">
        <span>Sea</span>
        <div className="seg-text" role="radiogroup" aria-label="Sea state">
          {seas.map(([label, h]) => {
            const on = (w.height ?? 0) === h;
            return (
              <button key={label} role="radio" aria-checked={on} className={on ? 'active' : ''} data-sea={label.toLowerCase()} onClick={() => set({ height: h, waves: h >= 1.5 ? Math.max(w.waves, Math.round(h * 16) / 10) : w.waves })}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {field('height', 'Wave height', 0, 30, 0.1, ' m')}
      {field('waves', 'Wave size', 0.05, 50, 0.1, ' m')}
      {field('direction', 'Direction', -3600, 3600, 5, '°')}
      {field('speed', 'Ripple speed', 0, 20, 0.05, ' m/s')}
      <p className="prop-hint">Wave height moves the surface itself, frame by frame (like Blender's Ocean modifier): rolling swells for boats, storms and floods. Wave size sets how long they are. Calm water keeps just the ripples.</p>
      <SurgeRows id={id} />
    </Section>
  );
}

/** One giant travelling wave across the water (tsunami / surge). */
function SurgeRows({ id }: { id: string }) {
  const { store } = useCtx();
  const w = useApp((s) => s.doc.objects[id].water)!;
  const frame = useApp((s) => s.frame);
  const g = w.surge;
  const set = (surge: Surge | null) => store.dispatch({ type: 'setWater', id, water: { surge } }, { select: false });
  const num = (key: keyof Surge, label: string, lo: number, hi: number, step: number, suffix: string, int = false) => (
    <NumberField
      label={label}
      value={g![key]}
      step={step}
      dragRate={step / 10}
      suffix={suffix}
      onPreview={(v) => store.preview({ type: 'setWater', id, water: { surge: { ...g!, [key]: clampN(v, lo, hi, int) } } })}
      onCommit={(v) => {
        store.preview({ type: 'setWater', id, water: { surge: { ...g!, [key]: clampN(v, lo, hi, int) } } });
        store.commitPreview();
      }}
      onCancel={() => store.cancelPreview()}
    />
  );
  return (
    <>
      <label className="prop-row">
        <span>Giant wave (tsunami)</span>
        <input type="checkbox" data-testid="surge-toggle" checked={!!g} onChange={(e) => set(e.target.checked ? { ...DEFAULT_SURGE, start: frame } : null)} />
      </label>
      {g && (
        <>
          {num('height', 'Wave height', 0.1, 100, 0.5, ' m')}
          {num('start', 'Starts at frame', -100000, 100000, 1, '', true)}
          {num('speed', 'Speed', 0.1, 300, 1, ' m/s')}
          {num('width', 'Length', 1, 1000, 1, ' m')}
          {num('from', 'Starts from', -10000, 10000, 5, ' m')}
          <p className="prop-hint">A single wall of water that runs across the sea in the Direction above, lifting and carrying anything that floats. It starts "Starts from" metres behind the centre — move it further back to see it come in.</p>
          <div className="prop-actions">
            <button className="btn" data-testid="surge-spray" onClick={() => {
              const pr = PARTICLE_PRESETS.find((x) => x.id === 'spray')!;
              const st = store.getState();
              const span = crestFrames(st.doc.objects[id], st.doc.animation?.fps ?? 24);
              store.dispatch({ type: 'setParticles', id, particles: { ...pr.settings, ...(span ?? {}) } }, { select: false });
              store.notify('Spray added on the wave crest (Physics → Particles to tune it)');
            }}>{w.surge && store.getState().doc.objects[id].particles?.emit === 'crest' ? 'Reset spray' : 'Add spray on the crest'}</button>
          </div>
        </>
      )}
    </>
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
