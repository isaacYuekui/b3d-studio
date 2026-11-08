// Babylon.js viewport. Mirrors the store's SceneDoc into Babylon nodes,
// handles picking, gizmos, camera, lights, materials and shading modes.
// It never mutates the doc directly: viewport edits (gizmo drags) are dispatched as commands.

// Deep imports keep the bundle much smaller than importing '@babylonjs/core' root.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import type { Light } from '@babylonjs/core/Lights/light';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Vector3, Quaternion, Matrix } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline';
import { Constants } from '@babylonjs/core/Engines/constants';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
// Side-effect imports required by deep-import usage:
import '@babylonjs/core/Culling/ray'; // scene picking
import '@babylonjs/core/Rendering/outlineRenderer'; // selection outline
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'; // shadows
import '@babylonjs/core/Helpers/sceneHelpers'; // skybox
import '@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent';
import '@babylonjs/core/Rendering/prePassRendererSceneComponent'; // SSAO2
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'; // SSAO2

import type { Store, AppState, ToolMode, Shading } from '../core/store';
import type { Material as SceneMaterial, SceneObject, SceneDoc, Vec3, World } from '../core/types';
import { isRenderable, worldOf } from '../core/types';
import { catalogNow, hdriUrl, loadCatalog, modelUrl, textureUrl } from './library';
import { evaluateCamera, evaluateTransform, transformEdit } from '../core/animation';
import { guessUnitScale, isUserAsset, updateUserModelMeta, userModelMetaNow, userModelUrl } from './userModels';

class MissingModel extends Error {}
import { babylonQuatToEulerDeg, clean, eulerDegToBabylonQuat, fromBabylonVec, toBabylonVec } from './coords';
import { buildVertexData } from './geometry';
import { subtree } from '../core/commands';
import { EditOverlay } from './EditOverlay';
import type { M4, PosedBones, Weights } from '../core/rig';
import { apply as m4apply, rotEuler as rotEulerM, boneBase, invert as m4invert, m4ToQuat, mul as m4mul, poseAt, poseBones, poseEdit, quatToM4, rotationOnly, skinMesh, toEuler, worldMatrix } from '../core/rig';
import { applyModifiers } from '../core/mesh/modifiers';
import { transformVerts } from '../core/mesh/ops';
import { flush, pickElement, selectLoop } from '../core/mesh/select';
import type { MeshSelection } from '../core/mesh/select';
import type { MeshData } from '../core/types';

export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'persp';

interface Entry {
  /** Root node that carries the object's transform and parenting. */
  node: TransformNode;
  /** Pickable visual: the geometry itself, or a helper for lights/empties. */
  pick: AbstractMesh | null;
  /** Renderable meshes (outline, shadows, framing). Filled asynchronously for library models. */
  meshes: AbstractMesh[];
  /** Rebuild key — when it changes, the node is recreated. */
  key: string;
  material?: PBRMaterial;
  light?: Light;
  /** Armatures: the drawn bones (rebuilt when the pose changes). */
  bonesKey?: string;
  shadow?: ShadowGenerator;
  /** Last applied object data, to skip unchanged updates. */
  last?: SceneObject;
}

const SELECT_COLOR = new Color3(1, 0.55, 0.1); // Blender-like orange
const BG = new Color4(0.235, 0.235, 0.235, 1);
const HELPER_COLOR = new Color3(0.1, 0.1, 0.1);
const MAX_SHADOW_LIGHTS = 2;

/** Blender watts → Babylon intensity. Tuned by eye so 1000 W at ~4 m reads like Blender. */
const POINT_SCALE = 1 / 40;

export class Viewport {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  private gizmos: GizmoManager;
  private entries = new Map<string, Entry>();
  private unsub: () => void;
  private dragging = false;
  private lastDoc: SceneDoc | null = null;
  private lastSel: string | null | undefined = undefined;
  private lastTool: ToolMode | null = null;
  private lastShading: Shading | null = null;
  private resizeObs: ResizeObserver;
  private studio: Light[] = [];
  private studioEnv!: RawCubeTexture;
  private hdris = new Map<string, HDRCubeTexture>();
  private skybox: Mesh | null = null;
  private skyKey = '';
  private pipeline: DefaultRenderingPipeline | null = null;
  private ssao: SSAO2RenderingPipeline | null = null;
  private lastWorld: World | null = null;
  private containers = new Map<string, Promise<AssetContainer>>();
  private loadersReady: Promise<unknown> | null = null;
  private pending = new Set<Promise<void>>();
  private helperMat: StandardMaterial;
  private overlay: EditOverlay;
  private editPivot: TransformNode;
  private editDrag: { id: string; mesh: MeshData; verts: number[]; startInv: Matrix; world: Matrix; worldInv: Matrix } | null = null;
  private lastEditKey = '';

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, powerPreference: 'high-performance', adaptToDeviceRatio: false });
    // Cap pixel ratio at 2: retina iPads at 3x would quadruple fill cost for little gain.
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

    const scene = (this.scene = new Scene(this.engine));
    scene.clearColor = BG;
    scene.skipPointerMovePicking = true; // we only pick on tap; saves CPU on mobile
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.environmentTexture = this.studioEnv = this.makeEnvironment();
    void loadCatalog();

    // Camera — Blender default view, Y-up internally (see coords.ts).
    const cam = (this.camera = new ArcRotateCamera('cam', -0.72, 1.08, 14, Vector3.Zero(), scene));
    cam.minZ = 0.02; // close-ups of real-size objects (a 10 cm mug) must not clip
    cam.maxZ = 2000;
    cam.lowerRadiusLimit = 0.05;
    cam.upperRadiusLimit = 500;
    cam.wheelDeltaPercentage = 0.01;
    cam.pinchDeltaPercentage = 0.004;
    cam.panningSensibility = 600;
    cam.angularSensibilityX = cam.angularSensibilityY = 500;
    cam.useNaturalPinchZoom = true;
    cam.attachControl(canvas, true);
    // Left = orbit, middle = pan, Ctrl/Cmd+left = pan, right button free for the context menu.
    const pointers = cam.inputs.attached.pointers as unknown as { buttons: number[]; multiTouchPanAndZoom: boolean } | undefined;
    if (pointers) {
      pointers.buttons = [0, 1];
      pointers.multiTouchPanAndZoom = true;
    }

    // Studio lights for Solid shading (like Blender's workbench lighting).
    const hemi = new HemisphericLight('studio-hemi', new Vector3(0.3, 1, -0.4), scene);
    hemi.intensity = 0.9;
    hemi.groundColor = new Color3(0.3, 0.3, 0.33);
    const key = new DirectionalLight('studio-key', new Vector3(-0.5, -1, 0.7), scene);
    key.intensity = 1.2;
    this.studio = [hemi, key];

    this.helperMat = new StandardMaterial('helper-mat', scene);
    this.helperMat.disableLighting = true;
    this.helperMat.emissiveColor = new Color3(0.05, 0.05, 0.05);

    this.buildGrid();
    this.overlay = new EditOverlay(scene);
    this.editPivot = new TransformNode('edit-pivot', scene);
    this.editPivot.rotationQuaternion = Quaternion.Identity();
    this.bonePivot = new TransformNode('bone-pivot', scene);
    this.bonePivot.rotationQuaternion = Quaternion.Identity();

    // Gizmos
    const gm = (this.gizmos = new GizmoManager(scene, 1.6));
    gm.usePointerToAttachGizmos = false; // selection is driven by the store
    gm.clearGizmoOnEmptyPointerEvent = false;
    gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = true;
    const g = gm.gizmos;
    if (g.rotationGizmo) g.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = false;
    for (const gizmo of [g.positionGizmo, g.rotationGizmo, g.scaleGizmo]) {
      if (!gizmo) continue;
      gizmo.onDragStartObservable.add(() => {
        this.dragging = true;
        if (this.store.getState().pose) this.startBoneDrag();
        else this.startEditDrag();
      });
      gizmo.onDragObservable.add(() => (this.boneDrag ? this.stepBoneDrag() : this.stepEditDrag()));
      gizmo.onDragEndObservable.add(() => {
        this.dragging = false;
        if (this.boneDrag) {
          this.boneDrag = null;
          this.store.commitPreview();
          this.placeBonePivot(this.store.getState());
        } else if (this.editDrag) {
          this.editDrag = null;
          this.store.commitPreview();
          this.placePivot(this.store.getState());
        } else this.commitGizmo();
      });
    }
    gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = false;

    // Moving the view by hand leaves the scene-camera view (like Blender).
    scene.onPointerObservable.add((info) => {
      if (info.type === PointerEventTypes.POINTERMOVE && (info.event as PointerEvent).buttons && this.store.getState().cameraView && !this.dragging) this.store.setCameraView(false);
    });
    canvas.addEventListener('wheel', () => this.store.getState().cameraView && this.store.setCameraView(false), { passive: true });

    // Tap to select
    scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERTAP) return;
      const ev = info.event as PointerEvent;
      if (ev.button !== 0) return;
      if (this.store.getState().pose) this.poseTap(scene.pointerX, scene.pointerY, ev.pointerType !== 'mouse');
      else if (this.store.getState().edit) this.editTap(scene.pointerX, scene.pointerY, ev.shiftKey || this.store.getState().addSelect, ev.altKey, ev.pointerType !== 'mouse');
      else this.store.select(this.pickAt(scene.pointerX, scene.pointerY));
    });

    scene.onBeforeRenderObservable.add(() => this.stepTween());
    this.engine.runRenderLoop(() => scene.render());
    this.resizeObs = new ResizeObserver(() => this.engine.resize());
    this.resizeObs.observe(canvas);

    this.unsub = store.subscribe(() => this.sync(store.getState()));
    this.sync(store.getState());
  }

  // ---------------------------------------------------------------- environment

  /** Procedural grey studio sky as a cube map, so metals and gloss have something to reflect. */
  private makeEnvironment(): RawCubeTexture {
    const size = 32;
    const faces: Uint8Array[] = [];
    // Face order: +X, -X, +Y, -Y, +Z, -Z. Compute the world direction per texel.
    const dirFor = (f: number, u: number, v: number): [number, number, number] => {
      switch (f) {
        case 0: return [1, -v, -u];
        case 1: return [-1, -v, u];
        case 2: return [u, 1, v];
        case 3: return [u, -1, -v];
        case 4: return [u, -v, 1];
        default: return [-u, -v, -1];
      }
    };
    const sky = [205, 210, 220], horizon = [150, 150, 152], ground = [55, 55, 58];
    for (let f = 0; f < 6; f++) {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const [dx, dy, dz] = dirFor(f, ((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
          const h = dy / Math.hypot(dx, dy, dz);
          const c = h >= 0 ? horizon.map((hc, i) => hc + (sky[i] - hc) * Math.pow(h, 0.6)) : horizon.map((hc, i) => hc + (ground[i] - hc) * Math.min(1, -h * 3));
          const o = (y * size + x) * 4;
          data[o] = c[0];
          data[o + 1] = c[1];
          data[o + 2] = c[2];
          data[o + 3] = 255;
        }
      faces.push(data);
    }
    const tex = new RawCubeTexture(this.scene, faces, size, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, true);
    tex.gammaSpace = true;
    return tex;
  }

  // ---------------------------------------------------------------- scene sync

  private lastFrame = -1;
  private animated = new Set<string>();
  private lastCameraView = false;

  private sync(state: AppState) {
    const docChanged = state.doc !== this.lastDoc;
    if (docChanged) {
      this.syncDoc(state.doc);
      this.lastDoc = state.doc;
    }
    if (docChanged || state.frame !== this.lastFrame || state.cameraView !== this.lastCameraView) {
      this.applyAnimation(state);
      this.lastFrame = state.frame;
      this.lastCameraView = state.cameraView;
    }
    const world = worldOf(state.doc);
    if (state.shading !== this.lastShading || JSON.stringify(world) !== JSON.stringify(this.lastWorld)) {
      this.lastShading = state.shading;
      this.lastWorld = world;
      this.applyShading();
      this.applyWorld(world, state.shading === 'rendered');
    }
    const editKey = state.edit ? `${state.edit.id}|${state.edit.mode}|${state.xray}` : '';
    const editChanged = editKey !== this.lastEditKey || state.edit !== this.lastEdit || (state.edit && docChanged);
    if (editChanged) this.syncEdit(state, editKey !== this.lastEditKey);
    const poseChanged = state.pose !== this.lastPose;
    this.lastPose = state.pose;
    if (poseChanged) this.applyRigs(state);
    if (state.selection !== this.lastSel || state.tool !== this.lastTool || editChanged || poseChanged) {
      this.syncSelection(state.selection, state.tool);
      this.lastSel = state.selection;
      this.lastTool = state.tool;
    }
    this.lastEditKey = editKey;
    this.lastEdit = state.edit;
  }

  private lastEdit: AppState['edit'] = null;
  private lastPose: AppState['pose'] = null;

  // ---------------------------------------------------------------- armatures & skinning

  private bonePivot!: TransformNode;
  private boneDrag: { arm: string; bone: string; startQ: Quaternion; startPos: Vector3; base: M4; armWorld: M4; rot0: [number, number, number]; loc0: [number, number, number] } | null = null;
  private bindCache = new Map<string, { key: unknown; weights: Weights; rel: string }>();
  private evalCache = new Map<string, { mesh: unknown; mods: unknown; out: MeshData }>();
  private skinned = new Set<string>();

  /** Draw bones (posed) and deform skinned meshes for the current frame. */
  private applyRigs(state: AppState) {
    const doc = state.doc;
    const rendered = state.shading === 'rendered';
    for (const id of doc.order) {
      const o = doc.objects[id];
      const e = this.entries.get(id);
      if (!e) continue;
      if (o.type === 'armature' && o.armature) {
        const pose = poseAt(doc, id, state.frame);
        const selBone = state.pose?.id === id ? state.pose.bone : null;
        const key = JSON.stringify([o.armature.bones, pose, selBone, state.selection === id, !!state.pose]);
        if (key !== e.bonesKey) {
          e.pick?.dispose();
          e.pick = this.drawBones(o, poseBones(o.armature.bones, pose), selBone, state.selection === id, state.pose?.id === id);
          e.pick.parent = e.node;
          e.bonesKey = key;
        }
        e.pick?.setEnabled(!rendered && o.visible);
      }
    }
    // Skinned meshes
    const now = new Set<string>();
    for (const id of doc.order) {
      const o = doc.objects[id];
      if (o.type !== 'mesh' || !o.mesh || !o.skin || !doc.objects[o.skin.armature]) continue;
      const e = this.entries.get(id);
      if (!e || !(e.node instanceof Mesh)) continue;
      if (state.edit?.id === id) continue; // edit the rest shape
      now.add(id);
      let ev = this.evalCache.get(id);
      if (!ev || ev.mesh !== o.mesh || ev.mods !== o.modifiers) {
        ev = { mesh: o.mesh, mods: o.modifiers, out: applyModifiers(o.mesh, o.modifiers) };
        this.evalCache.set(id, ev);
      }
      const deformed = skinMesh(doc, id, ev.out, state.frame, this.bindCache);
      buildVertexData(deformed).applyToMesh(e.node, true);
      e.node.refreshBoundingInfo();
    }
    // Meshes no longer skinned: back to the rest shape.
    for (const id of this.skinned) {
      if (now.has(id)) continue;
      const o = doc.objects[id];
      const e = this.entries.get(id);
      if (o?.mesh && e?.node instanceof Mesh) buildVertexData(applyModifiers(o.mesh, o.modifiers)).applyToMesh(e.node, true);
    }
    this.skinned = now;
  }

  /** Octahedral bones like Blender's, in the armature's local space. */
  private drawBones(o: SceneObject, posed: PosedBones, selBone: string | null, objSelected: boolean, poseMode: boolean): LinesMesh {
    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    const base = poseMode ? new Color4(0.55, 0.6, 0.68, 1) : objSelected ? Color4.FromColor3(SELECT_COLOR, 1) : new Color4(0.62, 0.62, 0.62, 1);
    const hi = new Color4(0.3, 0.75, 1, 1);
    for (const b of o.armature!.bones) {
      const P = posed.posed.get(b.name)!;
      const L = Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
      const w = L * 0.1;
      const pt = (x: number, y: number, z: number) => new Vector3(...toBabylonVec(m4apply(P, [x, y, z])));
      const h = pt(0, 0, 0), t = pt(0, L, 0);
      const ring = [pt(w, w, 0), pt(0, w, w), pt(-w, w, 0), pt(0, w, -w)];
      const c = b.name === selBone ? hi : base;
      for (let i = 0; i < 4; i++) {
        lines.push([h, ring[i]], [ring[i], t], [ring[i], ring[(i + 1) % 4]]);
        colors.push([c, c], [c, c], [c, c]);
      }
    }
    const m = MeshBuilder.CreateLineSystem(`${o.id}-bones`, { lines, colors, useVertexAlpha: false }, this.scene);
    m.metadata = { id: o.id };
    m.intersectionThreshold = 0.12;
    m.renderingGroupId = poseMode ? 1 : 0; // in Pose Mode bones draw on top of the body
    m.alwaysSelectAsActiveMesh = true;
    return m;
  }

  /** Pose Mode tap: select the bone under the finger. */
  private poseTap(x: number, y: number, touch: boolean) {
    const st = this.store.getState();
    const p = st.pose!;
    const o = st.doc.objects[p.id];
    const e = this.entries.get(p.id);
    if (!o?.armature || !e) return;
    const posed = poseBones(o.armature.bones, poseAt(st.doc, p.id, st.frame));
    const world = e.node.computeWorldMatrix(true);
    const engine = this.engine;
    const k = engine.getHardwareScalingLevel();
    const vp = this.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const tm = this.scene.getTransformMatrix();
    const proj = (q: [number, number, number]) => {
      const s = Vector3.Project(new Vector3(...toBabylonVec(q)), world, tm, vp);
      return { x: s.x * k, y: s.y * k };
    };
    let best: string | null = null;
    let bd = touch ? 26 : 14;
    for (const b of o.armature.bones) {
      const P = posed.posed.get(b.name)!;
      const L = Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
      const a = proj(m4apply(P, [0, 0, 0])), c = proj(m4apply(P, [0, L, 0]));
      const dx = c.x - a.x, dy = c.y - a.y, LL = dx * dx + dy * dy;
      const t = LL ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / LL)) : 0;
      const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
      if (d < bd) (bd = d), (best = b.name);
    }
    if (best || !this.store.getState().addSelect) this.store.setPose({ id: p.id, bone: best });
  }

  /** Put the bone gizmo pivot at the selected bone's head, aligned with it (world space). */
  private placeBonePivot(state: AppState) {
    const p = state.pose;
    if (!p?.bone || this.boneDrag) return;
    const o = state.doc.objects[p.id];
    if (!o?.armature?.bones.some((b) => b.name === p.bone)) return;
    const posed = poseBones(o.armature.bones, poseAt(state.doc, p.id, state.frame));
    const W = m4mul(worldMatrix(state.doc, p.id, state.frame), posed.posed.get(p.bone)!);
    this.bonePivot.position.set(...toBabylonVec([W[3], W[7], W[11]]));
    const [x, y, z, w] = m4ToQuat(rotationOnly(W));
    // Blender quaternion → Babylon (see coords.ts): (x, y, z) → (-x, -z, -y)
    this.bonePivot.rotationQuaternion = new Quaternion(-x, -z, -y, w);
    this.bonePivot.scaling.setAll(1);
    this.bonePivot.computeWorldMatrix(true);
  }

  private startBoneDrag() {
    const st = this.store.getState();
    const p = st.pose;
    if (!p?.bone) return;
    const o = st.doc.objects[p.id];
    if (!o?.armature) return;
    const pose = poseAt(st.doc, p.id, st.frame);
    const posed = poseBones(o.armature.bones, pose);
    const cur = pose[p.bone];
    this.boneDrag = {
      arm: p.id,
      bone: p.bone,
      startQ: this.bonePivot.rotationQuaternion!.clone(),
      startPos: this.bonePivot.position.clone(),
      base: boneBase(o.armature.bones, posed, p.bone),
      armWorld: worldMatrix(st.doc, p.id, st.frame),
      rot0: [...(cur?.rotation ?? [0, 0, 0])] as [number, number, number],
      loc0: [...(cur?.location ?? [0, 0, 0])] as [number, number, number],
    };
  }

  private stepBoneDrag() {
    const d = this.boneDrag;
    if (!d) return;
    const st = this.store.getState();
    const q = this.bonePivot.rotationQuaternion!;
    // World-space delta rotation (Babylon) → Blender.
    const dq = q.multiply(Quaternion.Inverse(d.startQ));
    const D = quatToM4([-dq.x, -dq.z, -dq.y, dq.w]);
    const AB = rotationOnly(m4mul(d.armWorld, d.base));
    const L0 = rotationOnly(quatToM4(m4ToQuat(rotEulerM(d.rot0))));
    const Lnew = m4mul(m4mul(m4invert(AB), D), m4mul(AB, L0));
    const rotation = toEuler(Lnew);
    // Location: world delta into the bone's base axes.
    const dp = this.bonePivot.position.subtract(d.startPos);
    const dw = fromBabylonVec([dp.x, dp.y, dp.z]);
    const inv = m4invert(m4mul(d.armWorld, d.base));
    const o = m4apply(inv, [0, 0, 0]);
    const t = m4apply(inv, dw);
    const location: [number, number, number] = [d.loc0[0] + t[0] - o[0], d.loc0[1] + t[1] - o[1], d.loc0[2] + t[2] - o[2]];
    const hasLoc = location.some((x) => Math.abs(x) > 1e-6);
    this.store.preview(poseEdit(st.doc, st.frame, d.arm, d.bone, { rotation, ...(hasLoc ? { location } : {}) }));
  }
  private editedId: string | null = null;

  /** Edit-mode overlay, see-through display and the pivot the gizmo drives. */
  private syncEdit(state: AppState, modeChanged: boolean) {
    const ed = state.edit;
    // Restore the previously edited object's look.
    if (this.editedId && (!ed || ed.id !== this.editedId || modeChanged)) {
      const prev = this.entries.get(this.editedId)?.material;
      if (prev) {
        prev.zOffset = 0;
        const m = state.doc.objects[this.editedId]?.material;
        prev.alpha = m?.alpha ?? 1;
        prev.transparencyMode = (m?.alpha ?? 1) < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
      }
      this.editedId = null;
    }
    const o = ed ? state.doc.objects[ed.id] : null;
    const e = ed ? this.entries.get(ed.id) : undefined;
    if (!ed || !o?.mesh || !e) {
      this.overlay.clear();
      return;
    }
    this.editedId = ed.id;
    if (e.material) {
      // Push the surface back a little so wires and dots on it win the depth test.
      e.material.zOffset = 1;
      if (state.xray) {
        e.material.alpha = 0.35;
        e.material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      } else {
        e.material.alpha = o.material.alpha;
        e.material.transparencyMode = o.material.alpha < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
      }
    }
    if (this.editDrag) {
      // While dragging only the geometry changes; redraw the wires without touching the pivot.
      this.overlay.update(e.node, o.mesh, ed.mode, ed.sel, state.xray, this.pointPx());
      return;
    }
    this.overlay.update(e.node, o.mesh, ed.mode, ed.sel, state.xray, this.pointPx());
    this.placePivot(state);
  }

  private pointPx() {
    return Math.round(7 / this.engine.getHardwareScalingLevel());
  }

  /** Put the gizmo pivot at the selection's median, in world space. */
  private placePivot(state: AppState) {
    const ed = state.edit;
    const o = ed ? state.doc.objects[ed.id] : null;
    const e = ed ? this.entries.get(ed.id) : undefined;
    if (!ed || !o?.mesh || !e || !ed.sel.verts.length) return;
    let x = 0, y = 0, z = 0;
    for (const v of ed.sel.verts) {
      const p = o.mesh.vertices[v];
      x += p[0];
      y += p[1];
      z += p[2];
    }
    const n = ed.sel.verts.length;
    const local = new Vector3(...toBabylonVec([x / n, y / n, z / n]));
    const world = Vector3.TransformCoordinates(local, e.node.computeWorldMatrix(true));
    this.editPivot.position.copyFrom(world);
    this.editPivot.rotationQuaternion = Quaternion.Identity();
    this.editPivot.scaling.setAll(1);
    this.editPivot.computeWorldMatrix(true);
  }

  private startEditDrag() {
    const st = this.store.getState();
    const ed = st.edit;
    const o = ed ? st.doc.objects[ed.id] : null;
    const e = ed ? this.entries.get(ed.id) : undefined;
    if (!ed || !o?.mesh || !e || !ed.sel.verts.length) return;
    const world = e.node.computeWorldMatrix(true).clone();
    this.editDrag = { id: ed.id, mesh: o.mesh, verts: [...ed.sel.verts], startInv: this.editPivot.computeWorldMatrix(true).clone().invert(), world, worldInv: world.clone().invert() };
  }

  private stepEditDrag() {
    const d = this.editDrag;
    if (!d) return;
    const cur = this.editPivot.computeWorldMatrix(true);
    // local → world → undo pivot start → apply pivot now → back to local
    const m = d.world.multiply(d.startInv).multiply(cur).multiply(d.worldInv);
    const mods = this.store.getState().doc.objects[d.id]?.modifiers;
    const clip = mods?.mirror?.clip ? mods.mirror : null;
    const mesh = transformVerts(d.mesh, d.verts, (p) => {
      const b = Vector3.TransformCoordinates(new Vector3(...toBabylonVec(p)), m);
      const out = fromBabylonVec([b.x, b.y, b.z]);
      if (clip) {
        const merge = clip.merge ?? 0.001;
        ([clip.x, clip.y, clip.z] as boolean[]).forEach((on, ax) => {
          if (!on) return;
          if (Math.abs(p[ax]) <= merge || Math.sign(out[ax]) !== Math.sign(p[ax])) out[ax] = 0;
        });
      }
      return out;
    });
    this.store.preview({ type: 'setMesh', id: d.id, mesh });
  }

  /** Tap in edit mode: select the vertex / edge / face under the finger or cursor. */
  private editTap(x: number, y: number, extend: boolean, loop: boolean, touch: boolean) {
    const st = this.store.getState();
    const ed = st.edit!;
    const o = st.doc.objects[ed.id];
    const e = this.entries.get(ed.id);
    if (!o?.mesh || !e) return;
    const world = e.node.computeWorldMatrix(true);
    const hit = this.overlay.pick(o.mesh, ed.mode, world, this.camera, x, y, touch ? 26 : 14, st.xray);
    let sel: MeshSelection;
    if (loop && typeof hit === 'string') sel = selectLoop(o.mesh, ed.mode, extend ? ed.sel : flush(o.mesh, ed.mode, { verts: [], edges: [], faces: [] }), hit);
    else sel = pickElement(o.mesh, ed.mode, ed.sel, hit, extend);
    this.store.setEdit({ ...ed, sel });
  }

  /** Box select in edit mode (client coordinates). */
  boxSelect(rect: { x0: number; y0: number; x1: number; y1: number }, extend: boolean) {
    const st = this.store.getState();
    const ed = st.edit;
    const o = ed ? st.doc.objects[ed.id] : null;
    const e = ed ? this.entries.get(ed.id) : undefined;
    if (!ed || !o?.mesh || !e) return;
    const r = this.canvas.getBoundingClientRect();
    const box = { x0: Math.min(rect.x0, rect.x1) - r.left, x1: Math.max(rect.x0, rect.x1) - r.left, y0: Math.min(rect.y0, rect.y1) - r.top, y1: Math.max(rect.y0, rect.y1) - r.top };
    const hits = this.overlay.boxSelect(o.mesh, ed.mode, e.node.computeWorldMatrix(true), this.camera, box, st.xray);
    const prim = extend ? ed.sel : { verts: [], edges: [], faces: [] };
    const next: MeshSelection =
      ed.mode === 'vert' ? { ...prim, verts: [...prim.verts, ...(hits as number[])] } : ed.mode === 'edge' ? { ...prim, edges: [...prim.edges, ...(hits as string[])] } : { ...prim, faces: [...prim.faces, ...(hits as number[])] };
    this.store.setEdit({ ...ed, sel: flush(o.mesh, ed.mode, next) });
  }

  /** Pose animated objects (and the camera, when looking through it) at the current frame. */
  private applyAnimation(state: AppState) {
    const anim = state.doc.animation;
    const now = new Set<string>();
    const sel = state.selection;
    for (const [id, keys] of Object.entries(anim?.tracks ?? {})) {
      const e = this.entries.get(id);
      if (!e || !keys.length) continue;
      now.add(id);
      if (this.dragging && id === sel) continue;
      const t = evaluateTransform(keys, state.frame)!;
      this.applyTransform(e.node, { ...state.doc.objects[id], transform: t });
    }
    // Objects whose animation was removed go back to their own transform.
    for (const id of this.animated) {
      if (now.has(id)) continue;
      const e = this.entries.get(id);
      const o = state.doc.objects[id];
      if (e && o) this.applyTransform(e.node, o);
    }
    this.animated = now;
    this.applyRigs(state);
    if (state.cameraView) {
      const cam = (anim?.camera.length ? evaluateCamera(anim.camera, state.frame) : null) ?? state.doc.camera;
      if (cam) this.placeCamera(cam.position, cam.target);
    }
  }

  /** Put the viewport camera exactly at a scene-camera position (no tween). */
  private placeCamera(position: Vec3, target: Vec3) {
    const pos = new Vector3(...toBabylonVec(position));
    const tgt = new Vector3(...toBabylonVec(target));
    const d = pos.subtract(tgt);
    const radius = Math.max(d.length(), 0.3);
    this.tween = null;
    this.camera.setTarget(tgt);
    this.camera.alpha = Math.atan2(d.z, d.x);
    this.camera.beta = Math.acos(Math.min(1, Math.max(-1, d.y / radius)));
    this.camera.radius = radius;
  }

  private keyFor(o: SceneObject): string {
    return `${o.type}|${JSON.stringify(o.params ?? {})}|${o.light?.type ?? ''}|${o.asset ?? ''}`;
  }

  private disposeEntry(e: Entry) {
    e.shadow?.dispose();
    e.light?.dispose();
    e.material?.dispose();
    e.node.dispose(false, true);
  }

  private syncDoc(doc: SceneDoc) {
    let structure = false;
    for (const [id, e] of this.entries) {
      if (!doc.objects[id]) {
        this.disposeEntry(e);
        this.entries.delete(id);
        structure = true;
      }
    }
    for (const id of doc.order) {
      const o = doc.objects[id];
      let e = this.entries.get(id);
      // Recreate when the type or shape parameters changed; mesh edits update in place.
      if (e && e.key !== this.keyFor(o)) {
        this.disposeEntry(e);
        e = undefined;
      }
      if (e && o.mesh && (e.last?.mesh !== o.mesh || e.last?.modifiers !== o.modifiers) && e.node instanceof Mesh) {
        buildVertexData(applyModifiers(o.mesh, o.modifiers)).applyToMesh(e.node, true);
        e.node.refreshBoundingInfo();
      }
      if (!e) {
        e = this.createEntry(o);
        this.entries.set(id, e);
        structure = true;
      }
      if (e.last === o) continue;
      this.updateEntry(e, o, e.last);
      e.last = o;
    }
    for (const id of doc.order) {
      const o = doc.objects[id];
      const node = this.entries.get(id)!.node;
      const parent = o.parentId ? this.entries.get(o.parentId)?.node ?? null : null;
      if (node.parent !== parent) node.parent = parent;
    }
    if (structure) this.applyShading();
  }

  private createEntry(o: SceneObject): Entry {
    const s = this.scene;
    const key = this.keyFor(o);
    if (o.type === 'model') {
      const node = new TransformNode(o.name, s);
      node.rotationQuaternion = new Quaternion();
      node.metadata = { id: o.id, export: true };
      const entry: Entry = { node, pick: null, key, meshes: [] };
      const job = this.attachModel(entry, o).finally(() => this.pending.delete(job));
      this.pending.add(job);
      return entry;
    }
    if (isRenderable(o.type)) {
      const mesh = this.createGeometry(o);
      const mat = new PBRMaterial(`${o.id}-mat`, s);
      mat.backFaceCulling = o.type !== 'plane' && o.type !== 'mesh';
      mat.twoSidedLighting = !mat.backFaceCulling;
      mesh.material = mat;
      mesh.metadata = { id: o.id, export: true };
      mesh.outlineColor = SELECT_COLOR;
      mesh.outlineWidth = 0.035;
      mesh.rotationQuaternion = new Quaternion();
      return { node: mesh, pick: mesh, key, material: mat, meshes: [mesh] };
    }
    const node = new TransformNode(o.name, s);
    node.rotationQuaternion = new Quaternion();
    node.metadata = { id: o.id, export: true };
    if (o.type === 'light') {
      const l = o.light!;
      let light: Light;
      // Lights point along local -Z in Blender (= Babylon -Y).
      if (l.type === 'sun') light = new DirectionalLight(`${o.id}-light`, new Vector3(0, -1, 0), s);
      else if (l.type === 'spot') light = new SpotLight(`${o.id}-light`, Vector3.Zero(), new Vector3(0, -1, 0), 1, 2, s);
      else light = new PointLight(`${o.id}-light`, Vector3.Zero(), s);
      light.parent = node;
      light.metadata = { export: true };
      const helper = this.lightHelper(o, l.type);
      helper.parent = node;
      return { node, pick: helper, key, light, meshes: [] };
    }
    if (o.type === 'armature') {
      // Bones are drawn in applyRigs (they follow the pose).
      return { node, pick: null, key, meshes: [] };
    }
    // empty: small axes cross
    const size = 0.5;
    const helper = MeshBuilder.CreateLineSystem(`${o.id}-helper`, {
      lines: [
        [new Vector3(-size, 0, 0), new Vector3(size, 0, 0)],
        [new Vector3(0, -size, 0), new Vector3(0, size, 0)],
        [new Vector3(0, 0, -size), new Vector3(0, 0, size)],
      ],
    }, s);
    helper.color = HELPER_COLOR;
    helper.intersectionThreshold = 0.15;
    helper.metadata = { id: o.id };
    helper.parent = node;
    return { node, pick: helper, key, meshes: [] };
  }

  /** Load a library model (cached per asset) and instance it under the entry's node. */
  private async attachModel(e: Entry, o: SceneObject) {
    const asset = o.asset!;
    const user = isUserAsset(asset);
    try {
      this.loadersReady ??= import('@babylonjs/loaders/glTF/2.0');
      await this.loadersReady;
      let p = this.containers.get(asset);
      if (!p) {
        p = (async () => {
          const url = user ? await userModelUrl(asset) : modelUrl(asset);
          if (!url) throw new MissingModel();
          return LoadAssetContainerAsync(url, this.scene, { pluginExtension: '.glb' });
        })();
        this.containers.set(asset, p);
        p.catch(() => this.containers.delete(asset));
      }
      const container = await p;
      if (this.entries.get(o.id) !== e) return; // object was deleted or rebuilt meanwhile
      const inst = container.instantiateModelsToScene((n) => n, false, { doNotInstantiate: true });
      // Imported files come in any units and with any origin: a "fit" node grounds and
      // centres them and converts their units to metres. Library models are already clean.
      const fit = new TransformNode(`${o.id}-fit`, this.scene);
      for (const root of inst.rootNodes) root.parent = fit;
      if (user) this.fitUserModel(fit, asset);
      fit.parent = e.node;
      for (const d of e.node.getDescendants(false)) d.metadata = { ...(d.metadata ?? {}), export: true };
      e.meshes = e.node.getChildMeshes(false).filter((m) => m.getTotalVertices() > 0);
      for (const m of e.meshes) {
        m.metadata = { ...(m.metadata ?? {}), id: o.id, export: true };
        m.isPickable = true;
        m.outlineColor = SELECT_COLOR;
        m.outlineWidth = 0.01;
      }
      e.pick = e.meshes[0] ?? null;
      this.applyShading();
      this.syncSelection(this.store.getState().selection, this.store.getState().tool);
    } catch (err) {
      if (err instanceof MissingModel) this.store.notify(`“${o.name}” was imported on another device. Import the model again, or open the project file that includes it.`);
      else this.store.notify(`Could not load model “${user ? o.name : asset}”.`);
    }
  }

  /** Centre an imported model on its footprint, put it on the ground, and convert its units to metres. */
  private fitUserModel(fit: TransformNode, asset: string) {
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const n of [fit, ...fit.getDescendants(false)]) n.computeWorldMatrix(true);
    for (const m of fit.getChildMeshes(false)) {
      if (!m.getTotalVertices()) continue;
      const bb = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, bb.minimumWorld);
      max = Vector3.Maximize(max, bb.maximumWorld);
    }
    if (!Number.isFinite(min.x)) return;
    const size = max.subtract(min);
    const k = guessUnitScale(Math.max(size.x, size.y, size.z));
    fit.scaling.setAll(k);
    fit.position.set(-((min.x + max.x) / 2) * k, -min.y * k, -((min.z + max.z) / 2) * k);
    const meta = userModelMetaNow(asset);
    if (meta && !meta.max) void updateUserModelMeta(asset, { min: min.asArray() as Vec3, max: max.asArray() as Vec3 });
  }

  /** Photo-scanned PBR maps from the library (colour, normal, AO/roughness/metal). */
  private applyTexture(mat: PBRMaterial, m: SceneMaterial, prev?: SceneMaterial) {
    if (prev && prev.texture === m.texture && prev.textureScale === m.textureScale) return;
    for (const t of [mat.albedoTexture, mat.bumpTexture, mat.metallicTexture]) t?.dispose();
    mat.albedoTexture = mat.bumpTexture = mat.metallicTexture = null;
    mat.useAmbientOcclusionFromMetallicTextureRed = mat.useRoughnessFromMetallicTextureGreen = mat.useMetallnessFromMetallicTextureBlue = false;
    if (!m.texture) return;
    const id = m.texture;
    const maps = catalogNow()?.textures.find((t) => t.id === id)?.maps ?? ['diff', 'nor', 'arm'];
    const load = (map: 'diff' | 'nor' | 'arm' | 'rough'): Texture => {
      const t = new Texture(textureUrl(id, map), this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, null, () => this.store.notify(`Could not load texture “${id}”.`));
      t.uScale = t.vScale = m.textureScale;
      t.anisotropicFilteringLevel = 8;
      return t;
    };
    mat.albedoTexture = load('diff');
    if (maps.includes('nor')) {
      mat.bumpTexture = load('nor');
      // OpenGL-style normal maps in a left-handed scene (same as Babylon's glTF loader).
      mat.invertNormalMapX = true;
      mat.invertNormalMapY = false;
    }
    if (maps.includes('arm')) {
      mat.metallicTexture = load('arm');
      mat.useAmbientOcclusionFromMetallicTextureRed = true;
      mat.useRoughnessFromMetallicTextureGreen = true;
      mat.useMetallnessFromMetallicTextureBlue = true;
    } else if (maps.includes('rough')) {
      mat.metallicTexture = load('rough');
      mat.useRoughnessFromMetallicTextureGreen = true;
    }
  }

  private lightHelper(o: SceneObject, type: string): Mesh {
    const s = this.scene;
    const h = MeshBuilder.CreatePolyhedron(`${o.id}-helper`, { type: 1, size: 0.18 }, s);
    h.material = this.helperMat;
    h.metadata = { id: o.id };
    h.outlineColor = SELECT_COLOR;
    h.outlineWidth = 0.03;
    if (type !== 'point') {
      // Direction indicator for sun / spot
      const line = MeshBuilder.CreateLines(`${o.id}-dir`, { points: [Vector3.Zero(), new Vector3(0, -1.2, 0)] }, s);
      line.color = new Color3(0.9, 0.85, 0.4);
      line.isPickable = false;
      line.parent = h;
    }
    return h;
  }

  private createGeometry(o: SceneObject): Mesh {
    const s = this.scene;
    const p = o.params ?? {};
    const seg = p.segments;
    // Sizes match Blender defaults (2 m cube, 1 m radius sphere/cylinder/cone, 2 m plane).
    switch (o.type) {
      case 'cube':
        return MeshBuilder.CreateBox(o.name, { size: 2 }, s);
      case 'sphere':
        return MeshBuilder.CreateSphere(o.name, { diameter: 2, segments: seg ? Math.max(2, Math.round(seg / 2)) : 16 }, s);
      case 'cylinder':
        return MeshBuilder.CreateCylinder(o.name, { diameterTop: 2 * (p.radiusTop ?? 1), diameterBottom: 2 * (p.radiusBottom ?? 1), height: 2, tessellation: seg ?? 32 }, s);
      case 'cone':
        return MeshBuilder.CreateCylinder(o.name, { diameterTop: 2 * (p.radiusTop ?? 0), diameterBottom: 2 * (p.radiusBottom ?? 1), height: 2, tessellation: seg ?? 32 }, s);
      case 'torus':
        return MeshBuilder.CreateTorus(o.name, { diameter: 2 * (p.majorRadius ?? 1), thickness: 2 * (p.minorRadius ?? 0.25), tessellation: seg ?? 48 }, s);
      case 'capsule':
        return MeshBuilder.CreateCapsule(o.name, { radius: 0.5, height: 2, tessellation: seg ?? 24, subdivisions: 2 }, s);
      case 'plane':
        return MeshBuilder.CreateGround(o.name, { width: 2, height: 2 }, s);
      case 'mesh': {
        const mesh = new Mesh(o.name, s);
        buildVertexData(applyModifiers(o.mesh!, o.modifiers)).applyToMesh(mesh, true);
        return mesh;
      }
      default:
        throw new Error(`Unsupported geometry type ${o.type}`);
    }
  }

  private updateEntry(e: Entry, o: SceneObject, prev?: SceneObject) {
    const n = e.node;
    n.name = o.name;
    n.setEnabled(o.visible);
    if (!(this.dragging && o.id === this.store.getState().selection)) this.applyTransform(n, o);

    if (e.material && o.material !== prev?.material) {
      const m = o.material;
      const mat = e.material;
      this.applyTexture(mat, m, prev?.material);
      mat.albedoColor = Color3.FromHexString(m.baseColor).toLinearSpace();
      // With a texture, metal/roughness come from its maps (scalars act as multipliers).
      mat.metallic = m.texture ? 1 : m.metallic;
      mat.roughness = m.texture ? 1 : m.roughness;
      mat.emissiveColor = Color3.FromHexString(m.emission).toLinearSpace().scale(m.emissionStrength);
      mat.alpha = m.alpha;
      mat.transparencyMode = m.alpha < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    }
    if (e.light && o.light) {
      const l = o.light;
      e.light.diffuse = Color3.FromHexString(l.color);
      e.light.specular = e.light.diffuse;
      e.light.intensity = l.type === 'sun' ? l.power : l.power * POINT_SCALE;
      if (e.light instanceof SpotLight) e.light.angle = (l.spotAngle * Math.PI) / 180;
      if (prev?.light?.shadows !== l.shadows) this.applyShading();
    }
  }

  private applyTransform(node: TransformNode, o: SceneObject) {
    const t = o.transform;
    node.position.set(...toBabylonVec(t.position));
    node.scaling.set(...toBabylonVec(t.scale));
    const [x, y, z, w] = eulerDegToBabylonQuat(t.rotation);
    if (!node.rotationQuaternion) node.rotationQuaternion = new Quaternion();
    node.rotationQuaternion.set(x, y, z, w);
  }

  /** Solid: studio lights only. Rendered: the scene's own lights + shadows. */
  private applyShading() {
    const rendered = this.store.getState().shading === 'rendered';
    const sceneLights = [...this.entries.values()].filter((e) => e.light);
    const useStudio = !rendered || sceneLights.length === 0;
    this.studio.forEach((l) => l.setEnabled(useStudio));
    const casters = [...this.entries.values()].flatMap((e) => e.meshes);
    let shadowCount = 0;
    for (const e of sceneLights) {
      const obj = e.last;
      e.light!.setEnabled(rendered);
      const wantShadow = rendered && !!obj?.light?.shadows && obj.light.type !== 'point' && shadowCount < MAX_SHADOW_LIGHTS;
      if (wantShadow) {
        shadowCount++;
        if (!e.shadow) {
          const sg = new ShadowGenerator(1024, e.light as DirectionalLight | SpotLight);
          sg.usePercentageCloserFiltering = true;
          sg.bias = 0.0008;
          sg.normalBias = 0.02;
          e.shadow = sg;
        }
        const map = e.shadow.getShadowMap();
        if (map) map.renderList = casters;
      } else if (e.shadow) {
        e.shadow.dispose();
        e.shadow = undefined;
      }
    }
    for (const m of casters) m.receiveShadows = rendered && shadowCount > 0;
  }

  /** HDRI lighting, background, exposure and post-processing. Only in Rendered shading. */
  private applyWorld(w: World, rendered: boolean) {
    const scene = this.scene;
    const hasLights = [...this.entries.values()].some((e) => e.light);
    let env: BaseTexture = this.studioEnv;
    if (rendered && w.hdri) {
      let hdr = this.hdris.get(w.hdri);
      if (!hdr) {
        // 256px prefiltered cube: good reflections at a size phones handle.
        hdr = new HDRCubeTexture(hdriUrl(w.hdri), scene, 256, false, true, false, true, null, () => this.store.notify(`Could not load sky “${w.hdri}”.`));
        this.hdris.set(w.hdri, hdr);
      }
      hdr.rotationY = (-w.rotation * Math.PI) / 180;
      env = hdr;
    }
    scene.environmentTexture = env;
    scene.environmentIntensity = !rendered ? 0.8 : w.hdri ? w.strength : (hasLights ? 0.35 : 0.8) * w.strength;

    // Background
    const wantSky = rendered && !!w.hdri && w.background !== 'color';
    const skyKey = wantSky ? `${w.hdri}|${w.background}` : '';
    if (skyKey !== this.skyKey) {
      this.skybox?.dispose(false, false);
      this.skybox = wantSky ? scene.createDefaultSkybox(env, true, 1000, w.background === 'blurred' ? 0.5 : 0, false) : null;
      if (this.skybox) {
        this.skybox.isPickable = false;
        this.skybox.infiniteDistance = true;
      }
      this.skyKey = skyKey;
    }
    scene.clearColor = rendered ? Color4.FromColor3(Color3.FromHexString(w.color), 1) : BG;
    // Rendered view shows the scene as it will look: no grid, no light/empty helpers.
    for (const g of this.grid) g.setEnabled(!rendered);
    for (const e of this.entries.values()) if (e.pick && !e.meshes.includes(e.pick)) e.pick.setEnabled(!rendered);
    scene.imageProcessingConfiguration.exposure = rendered ? w.exposure : 1;

    // Post-processing (rendered only): anti-aliasing, bloom, ambient occlusion.
    if (rendered) {
      if (!this.pipeline) {
        this.pipeline = new DefaultRenderingPipeline('look', true, scene, [this.camera]);
        this.pipeline.fxaaEnabled = true;
        this.pipeline.bloomThreshold = 0.85;
        this.pipeline.bloomKernel = 48;
        this.pipeline.bloomScale = 0.5;
      }
      this.pipeline.bloomEnabled = w.bloom > 0;
      this.pipeline.bloomWeight = w.bloom;
      if (w.ao && !this.ssao && SSAO2RenderingPipeline.IsSupported) {
        const ssao = new SSAO2RenderingPipeline('ao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera], true);
        ssao.radius = 0.5;
        ssao.totalStrength = 1.1;
        ssao.samples = 16;
        ssao.maxZ = 60;
        ssao.expensiveBlur = true;
        this.ssao = ssao;
      } else if (!w.ao && this.ssao) {
        this.ssao.dispose(true);
        this.ssao = null;
      }
    } else {
      this.ssao?.dispose(true);
      this.ssao = null;
      this.pipeline?.dispose();
      this.pipeline = null;
    }
  }

  private syncSelection(sel: string | null, tool: ToolMode) {
    for (const [id, e] of this.entries) {
      const on = id === sel;
      for (const m of e.meshes) m.renderOutline = on;
      if (e.pick && !e.meshes.includes(e.pick) && e.pick.getClassName() !== 'LinesMesh') e.pick.renderOutline = on;
      if (e.pick?.getClassName() === 'LinesMesh') (e.pick as LinesMesh).color = on ? SELECT_COLOR : HELPER_COLOR;
    }
    const gm = this.gizmos;
    const st = this.store.getState();
    if (st.pose) {
      for (const e of this.entries.values()) for (const m of e.meshes) m.renderOutline = false;
      const has = !!st.pose.bone;
      gm.positionGizmoEnabled = tool === 'move' && has;
      gm.rotationGizmoEnabled = (tool === 'rotate' || tool === 'select' || tool === 'scale') && has;
      gm.scaleGizmoEnabled = false;
      this.placeBonePivot(st);
      gm.attachToNode(has ? this.bonePivot : null);
      return;
    }
    if (st.edit) {
      // Edit mode: the gizmo moves the selected vertices (through the pivot), not the object.
      for (const m of this.entries.get(st.edit.id)?.meshes ?? []) m.renderOutline = false;
      const has = st.edit.sel.verts.length > 0;
      gm.positionGizmoEnabled = tool === 'move' && has;
      gm.rotationGizmoEnabled = tool === 'rotate' && has;
      gm.scaleGizmoEnabled = tool === 'scale' && has;
      gm.attachToNode(has ? this.editPivot : null);
      return;
    }
    const node = sel ? this.entries.get(sel)?.node ?? null : null;
    gm.positionGizmoEnabled = tool === 'move' && !!node;
    gm.rotationGizmoEnabled = tool === 'rotate' && !!node;
    gm.scaleGizmoEnabled = tool === 'scale' && !!node;
    gm.attachToNode(node);
  }

  /** Read the gizmo-modified node back into a transform command. */
  private commitGizmo() {
    const sel = this.store.getState().selection;
    const e = sel ? this.entries.get(sel) : undefined;
    if (!sel || !e) return;
    const n = e.node;
    const q = n.rotationQuaternion ?? Quaternion.FromEulerVector(n.rotation);
    const r = (v: Vector3): Vec3 => fromBabylonVec([clean(v.x), clean(v.y), clean(v.z)]);
    const st = this.store.getState();
    this.store.dispatch(transformEdit(st.doc, st.frame, sel, { position: r(n.position), rotation: babylonQuatToEulerDeg([q.x, q.y, q.z, q.w]), scale: r(n.scaling) }));
  }

  private grid: LinesMesh[] = [];

  private buildGrid() {
    const size = 20;
    const lines: Vector3[][] = [];
    for (let i = -size; i <= size; i++) {
      if (i === 0) continue;
      lines.push([new Vector3(i, 0, -size), new Vector3(i, 0, size)]);
      lines.push([new Vector3(-size, 0, i), new Vector3(size, 0, i)]);
    }
    const grid = MeshBuilder.CreateLineSystem('grid', { lines }, this.scene);
    grid.color = new Color3(0.33, 0.33, 0.33);
    grid.isPickable = false;
    // Sit just under z=0 so a floor plane at z=0 hides it instead of z-fighting.
    grid.position.y = -0.02;
    const x = MeshBuilder.CreateLines('axisX', { points: [new Vector3(-size, 0, 0), new Vector3(size, 0, 0)] }, this.scene);
    x.color = new Color3(0.85, 0.27, 0.3);
    // Blender's Y axis is Babylon's Z axis.
    const y = MeshBuilder.CreateLines('axisY', { points: [new Vector3(0, 0, -size), new Vector3(0, 0, size)] }, this.scene);
    y.color = new Color3(0.47, 0.72, 0.18);
    x.isPickable = y.isPickable = false;
    x.position.y = y.position.y = -0.015;
    this.grid = [grid, x, y];
  }

  // ---------------------------------------------------------------- public API

  /** Pick the object id under a canvas-relative CSS pixel position. */
  pickAt(x: number, y: number): string | null {
    const pick = this.scene.pick(x, y, (m) => !!m.metadata?.id && m.isEnabled());
    return (pick?.pickedMesh?.metadata?.id as string | undefined) ?? null;
  }

  /** Pick from a client (page) coordinate, used for context menus / long press. */
  pickClient(clientX: number, clientY: number): string | null {
    // scene.pick takes CSS pixels relative to the canvas (it divides by hardware scaling itself).
    const rect = this.canvas.getBoundingClientRect();
    return this.pickAt(clientX - rect.left, clientY - rect.top);
  }

  /** Move to the scene camera (if the scene has one). Returns false when there is none. */
  viewCamera(): boolean {
    const st = this.store.getState();
    const c = (st.doc.animation?.camera.length ? evaluateCamera(st.doc.animation.camera, st.frame) : null) ?? st.doc.camera;
    if (!c) return false;
    const pos = new Vector3(...toBabylonVec(c.position));
    const target = new Vector3(...toBabylonVec(c.target));
    const d = pos.subtract(target);
    const radius = Math.max(d.length(), 0.6);
    const alpha = Math.atan2(d.z, d.x);
    const beta = Math.acos(Math.min(1, Math.max(-1, d.y / radius)));
    this.animateCamera(alpha, beta, radius, target);
    setTimeout(() => this.store.setCameraView(true), 320);
    return true;
  }

  /** The current viewpoint in Blender coordinates, for "Set Scene Camera to View". */
  currentView(): { position: Vec3; target: Vec3 } {
    const r = (v: Vector3): Vec3 => fromBabylonVec([clean(v.x, 3), clean(v.y, 3), clean(v.z, 3)]);
    return { position: r(this.camera.position), target: r(this.camera.target) };
  }

  /** Resolves when every library model currently loading has finished (or failed). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  setView(view: ViewName) {
    const H = Math.PI / 2;
    const targets: Record<ViewName, [number, number]> = {
      front: [-H, H], // camera on Blender -Y looking +Y
      back: [H, H],
      right: [0, H],
      left: [Math.PI, H],
      top: [-H, 0.0001],
      bottom: [-H, Math.PI - 0.0001],
      persp: [-0.72, 1.08],
    };
    const [alpha, beta] = targets[view];
    this.animateCamera(alpha, beta, this.camera.radius, this.camera.target.clone());
  }

  /** Frame the selection (or everything) — Blender's numpad period / Home. */
  frame(all = false, only?: string[]) {
    const st = this.store.getState();
    let ids = only?.length ? only.flatMap((id) => (st.doc.objects[id] ? subtree(st.doc, id) : [])) : !all && st.selection ? subtree(st.doc, st.selection) : st.doc.order;
    // Frame geometry; lights and empties only count when there is nothing else to frame.
    const geo = ids.filter((id) => (this.entries.get(id)?.meshes.length ?? 0) > 0);
    if (geo.length) ids = geo;
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    let any = false;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e || !e.node.isEnabled()) continue;
      any = true;
      // Parent-first, so quantized model meshes get their real scale before measuring.
      for (const n of [e.node, ...e.node.getDescendants(false)]) n.computeWorldMatrix(true);
      if (e.meshes.length) {
        for (const m of e.meshes) {
          const bb = m.getBoundingInfo().boundingBox;
          min = Vector3.Minimize(min, bb.minimumWorld);
          max = Vector3.Maximize(max, bb.maximumWorld);
        }
      } else {
        const p = e.node.getAbsolutePosition();
        min = Vector3.Minimize(min, p.subtract(new Vector3(0.5, 0.5, 0.5)));
        max = Vector3.Maximize(max, p.add(new Vector3(0.5, 0.5, 0.5)));
      }
    }
    if (!any) {
      this.animateCamera(this.camera.alpha, this.camera.beta, 14, Vector3.Zero());
      return;
    }
    const center = min.add(max).scale(0.5);
    const half = max.subtract(min).length() / 2;
    const radius = Math.max((half / Math.sin(this.camera.fov / 2)) * 0.85, 0.15);
    this.animateCamera(this.camera.alpha, this.camera.beta, radius, center);
  }

  private tween: { from: [number, number, number, Vector3]; to: [number, number, number, Vector3]; t0: number } | null = null;

  /**
   * Time-based camera move (300 ms ease-in-out). Driven from the render loop and always
   * finishing on the exact target, even if frames stall while assets load.
   */
  private animateCamera(alpha: number, beta: number, radius: number, target: Vector3) {
    const cam = this.camera;
    let a = alpha;
    while (a - cam.alpha > Math.PI) a -= 2 * Math.PI;
    while (cam.alpha - a > Math.PI) a += 2 * Math.PI;
    this.tween = { from: [cam.alpha, cam.beta, cam.radius, cam.target.clone()], to: [a, beta, radius, target.clone()], t0: performance.now() };
  }

  private stepTween() {
    const tw = this.tween;
    if (!tw) return;
    const cam = this.camera;
    const k = Math.min(1, (performance.now() - tw.t0) / 300);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const lerp = (x: number, y: number) => x + (y - x) * e;
    // Target first: ArcRotateCamera.setTarget() recomputes alpha/beta/radius from the old
    // position, so the angles and distance must be applied after it.
    cam.setTarget(Vector3.Lerp(tw.from[3], tw.to[3], e));
    cam.alpha = lerp(tw.from[0], tw.to[0]);
    cam.beta = lerp(tw.from[1], tw.to[1]);
    cam.radius = lerp(tw.from[2], tw.to[2]);
    if (k >= 1) this.tween = null;
  }

  /**
   * Render the animation frame by frame and encode it to MP4 (H.264 when the device
   * can encode it). Deterministic: every frame is posed from the timeline, rendered,
   * copied, and encoded, so the result never drops frames however slow the device is.
   */
  async renderVideo(opts: { width: number; height: number; start: number; end: number; fps: number; onProgress?: (done: number, total: number) => void; isCancelled?: () => boolean }): Promise<{ blob: Blob; codec: string } | null> {
    const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH, getFirstEncodableVideoCodec } = await import('mediabunny');
    const W = Math.round(opts.width / 2) * 2;
    const H = Math.round(opts.height / 2) * 2;
    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H });
    if (!codec) throw new Error('This browser cannot encode video. Update Safari / Chrome and try again.');

    const st0 = this.store.getState();
    const restore = { shading: st0.shading, selection: st0.selection, frame: st0.frame, cameraView: st0.cameraView, scaling: this.engine.getHardwareScalingLevel() };
    const hasCamera = !!st0.doc.camera || (st0.doc.animation?.camera.length ?? 0) > 0;

    // Look the way the final video should: rendered shading, no selection, through the scene camera.
    this.store.select(null);
    this.store.setShading('rendered');
    if (hasCamera) this.store.setCameraView(true);
    this.engine.stopRenderLoop();
    this.resizeObs.disconnect();
    this.engine.setHardwareScalingLevel(1);
    this.engine.setSize(W, H);
    await this.settle();
    await this.scene.whenReadyAsync();

    const copy = document.createElement('canvas');
    copy.width = W;
    copy.height = H;
    const ctx2d = copy.getContext('2d')!;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const source = new CanvasSource(copy, { codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: opts.fps });
    await output.start();

    const total = opts.end - opts.start + 1;
    let cancelled = false;
    try {
      for (let i = 0; i < total; i++) {
        if (opts.isCancelled?.()) {
          cancelled = true;
          break;
        }
        this.store.setFrame(opts.start + i); // poses objects and camera synchronously
        this.scene.render();
        ctx2d.drawImage(this.canvas, 0, 0, W, H); // copy before the WebGL buffer is cleared
        await source.add(i / opts.fps, 1 / opts.fps);
        opts.onProgress?.(i + 1, total);
        if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      }
      if (cancelled) {
        await output.cancel();
        return null;
      }
      await output.finalize();
      const buf = (output.target as InstanceType<typeof BufferTarget>).buffer!;
      return { blob: new Blob([buf], { type: 'video/mp4' }), codec };
    } finally {
      this.engine.setHardwareScalingLevel(restore.scaling);
      this.engine.resize();
      this.resizeObs.observe(this.canvas);
      this.engine.runRenderLoop(() => this.scene.render());
      this.store.setShading(restore.shading);
      this.store.setCameraView(restore.cameraView);
      this.store.setFrame(restore.frame);
      this.store.select(restore.selection);
    }
  }

  /** Export the scene as binary glTF (opens in Blender via File > Import > glTF 2.0). */
  async exportGLB(): Promise<Blob> {
    const { GLTF2Export } = await import('@babylonjs/serializers/glTF/2.0/glTFSerializer');
    const result = await GLTF2Export.GLBAsync(this.scene, 'b3d-scene', {
      shouldExportNode: (node) => !!node.metadata?.export && node.isEnabled(),
    });
    const file = Object.values(result.files)[0];
    return file instanceof Blob ? file : new Blob([file as BlobPart], { type: 'model/gltf-binary' });
  }

  dispose() {
    this.unsub();
    this.overlay.dispose();
    this.resizeObs.disconnect();
    this.gizmos.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
