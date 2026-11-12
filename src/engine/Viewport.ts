// Babylon.js viewport. Mirrors the store's SceneDoc into Babylon nodes,
// handles picking, gizmos, camera, lights, materials and shading modes.
// It never mutates the doc directly: viewport edits (gizmo drags) are dispatched as commands.

// Deep imports keep the bundle much smaller than importing '@babylonjs/core' root.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { DepthOfFieldEffectBlurLevel } from '@babylonjs/core/PostProcesses/depthOfFieldEffect';
import { cameraFov, equivalentFocal } from '../core/lens';
import { isBillboard, particlesAt } from '../core/particles';
import { floatTransform, oceanDisplace, oceanGrid } from '../core/ocean';
import { shakeCamera } from '../core/shake';
import { DEFAULT_FLASH_COLOR, flashLevel } from '../core/fields';
import type { ParticleFrame, ParticleSettings } from '../core/particles';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
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
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Node } from '@babylonjs/core/node';
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
import '@babylonjs/core/Meshes/thinInstanceMesh'; // scatter
import '@babylonjs/core/Rendering/outlineRenderer'; // selection outline
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'; // shadows
import '@babylonjs/core/Helpers/sceneHelpers'; // skybox
import '@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent';
import '@babylonjs/core/Rendering/prePassRendererSceneComponent'; // SSAO2
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'; // SSAO2

import type { Store, AppState, ToolMode, Shading, Quality } from '../core/store';
import type { Material as SceneMaterial, SceneObject, SceneDoc, Vec3, World } from '../core/types';
import { PRIMITIVES, isRenderable, worldOf } from '../core/types';
import type { PrimitiveType } from '../core/types';
import { primitiveMesh } from '../core/mesh/primitives';
import { catalogNow, hdriUrl, loadCatalog, modelUrl, textureUrl } from './library';
import { animationOf, evaluateCamera, evaluateTransform, transformEdit } from '../core/animation';
import { guessUnitScale, isUserAsset, updateUserModelMeta, userModelMetaNow, userModelUrl } from './userModels';

class MissingModel extends Error {}
import { babylonQuatToEulerDeg, clean, eulerDegToBabylonQuat, fromBabylonVec, toBabylonVec } from './coords';
import { buildVertexData } from './geometry';
import { subtree } from '../core/commands';
import { EditOverlay } from './EditOverlay';
import { rippleNormalTexture } from './water';
import { isSharedTexture, patternColorTexture, patternGlowTexture, patternNormalTexture } from './patternTexture';
import { proportionalWeights } from '../core/mesh/proportional';
import { brushStep, strokeContext } from '../core/mesh/sculpt';
import type { StrokeContext } from '../core/mesh/sculpt';
import { TerrainPlugin } from './terrainMaterial';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Matrix as BMatrix } from '@babylonjs/core/Maths/math.vector';
import type { M4, PosedBones, Weights } from '../core/rig';
import { humanWeights, loadHuman } from '../core/humans';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
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
  /** Force fields with an explosion light (its brightness follows the frame). */
  flash?: PointLight;
  /** Armatures: the drawn bones (rebuilt when the pose changes). */
  bonesKey?: string;
  shadow?: ShadowGenerator;
  /** Last applied object data, to skip unchanged updates. */
  last?: SceneObject;
}

const SELECT_COLOR = new Color3(1, 0.55, 0.1); // Blender-like orange
const WIRE_COLOR = new Color3(0.72, 0.74, 0.77);
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
  private lastSculpt: unknown = undefined;
  private lastTool: ToolMode | null = null;
  private lastShading: Shading | null = null;
  private resizeObs: ResizeObserver;
  private studio: Light[] = [];
  private studioEnv!: RawCubeTexture;
  private hdris = new Map<string, HDRCubeTexture>();
  private ssaoQuality: Quality | null = null;
  private waters = new Map<string, { tex: Texture; water: { waves: number; speed: number } }>();
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
  private editDrag: { id: string; mesh: MeshData; verts: number[]; startInv: Matrix; world: Matrix; worldInv: Matrix; weights?: Map<number, number> } | null = null;
  private lastEditKey = '';

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, powerPreference: 'high-performance', adaptToDeviceRatio: false });
    this.engine.setHardwareScalingLevel(pixelScaling(store.getState().quality));

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

    // Sculpt strokes: a press on the sculpted mesh paints; anywhere else the view orbits as usual.
    canvas.addEventListener('pointerdown', (ev) => this.sculptDown(ev), { capture: true });
    canvas.addEventListener('pointermove', (ev) => this.sculptMove(ev));
    canvas.addEventListener('pointerup', () => this.sculptUp());
    canvas.addEventListener('pointercancel', () => this.sculptUp(true));

    // Tap to select
    scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERTAP) return;
      const ev = info.event as PointerEvent;
      if (ev.button !== 0) return;
      if (this.store.getState().sculpt) return; // taps don't change the selection while sculpting
      if (this.store.getState().pose) this.poseTap(scene.pointerX, scene.pointerY, ev.pointerType !== 'mouse');
      else if (this.store.getState().edit) this.editTap(scene.pointerX, scene.pointerY, ev.shiftKey || this.store.getState().addSelect, ev.altKey, ev.pointerType !== 'mouse');
      else this.store.select(this.pickAt(scene.pointerX, scene.pointerY));
    });

    scene.onBeforeRenderObservable.add(() => this.stepTween());
    scene.onBeforeRenderObservable.add(() => this.applyLens());
    scene.onBeforeRenderObservable.add(() => this.aimBillboards());
    scene.onBeforeRenderObservable.add(() => {
      if (!this.waters.size) return;
      const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);
      for (const { tex, water } of this.waters.values()) {
        const k = (dt * water.speed) / (water.waves * 16);
        tex.uOffset = (tex.uOffset + k * 0.8) % 1;
        tex.vOffset = (tex.vOffset + k * 0.6) % 1;
      }
    });
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
  private lastQuality: Quality | null = null;
  private lastSnap: boolean | null = null;
  /** Video export renders at Best whatever this device's setting is. */
  private forceBest = false;
  private recording = false;
  private quality(): Quality {
    return this.forceBest ? 'best' : this.store.getState().quality;
  }

  /**
   * Through the scene camera, use its lens (focal length on a 36 mm sensor, depth of field);
   * otherwise the viewport's own view. Runs every frame, so camera moves keep their focus.
   */
  private applyLens() {
    const st = this.store.getState();
    const lens = st.cameraView ? st.doc.lens : undefined;
    const aspect = this.engine.getRenderWidth() / Math.max(1, this.engine.getRenderHeight());
    const { fov, horizontal } = cameraFov(lens, aspect);
    const mode = horizontal ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
    if (this.camera.fov !== fov) this.camera.fov = fov;
    if (this.camera.fovMode !== mode) this.camera.fovMode = mode;
    const p = this.pipeline;
    if (!p) return;
    const q = this.quality();
    const want = !!lens?.dof && q !== 'fast';
    if (p.depthOfFieldEnabled !== want) p.depthOfFieldEnabled = want;
    if (!want || !lens) return;
    const level = q === 'best' ? DepthOfFieldEffectBlurLevel.High : DepthOfFieldEffectBlurLevel.Medium;
    if (p.depthOfFieldBlurLevel !== level) p.depthOfFieldBlurLevel = level;
    // Babylon's depth of field works in millimetres when scene units are metres.
    p.depthOfField.focalLength = equivalentFocal(lens, aspect);
    p.depthOfField.fStop = lens.fStop ?? 2.8;
    p.depthOfField.focusDistance = (lens.focus ?? this.camera.radius) * 1000;
  }
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
    const quality = this.quality();
    if (quality !== this.lastQuality) {
      this.lastQuality = quality;
      if (!this.recording) this.engine.setHardwareScalingLevel(pixelScaling(quality));
      // Shadow maps are rebuilt at the new size; post effects re-chosen below.
      for (const e of this.entries.values()) {
        e.shadow?.dispose();
        e.shadow = undefined;
      }
      this.lastWorld = null;
    }
    if (state.shading !== this.lastShading || JSON.stringify(world) !== JSON.stringify(this.lastWorld)) {
      this.lastShading = state.shading;
      this.lastWorld = world;
      this.applyShading();
      this.applyWorld(world, state.shading === 'rendered');
    }
    if (state.snap !== this.lastSnap) {
      this.lastSnap = state.snap;
      const g = this.gizmos.gizmos;
      // Increments, like Blender's Increment snapping: 0.25 m, 15°, 0.1×.
      if (g.positionGizmo) g.positionGizmo.snapDistance = state.snap ? 0.25 : 0;
      if (g.rotationGizmo) g.rotationGizmo.snapDistance = state.snap ? Math.PI / 12 : 0;
      if (g.scaleGizmo) g.scaleGizmo.snapDistance = state.snap ? 0.1 : 0;
    }
    if (state.shading === 'wireframe' || this.wire.size || this.wireMats.size) {
      if (docChanged || state.shading !== this.lastWireShading || state.selection !== this.lastSel || state.edit?.id !== this.lastEdit?.id) this.syncWire(state);
      this.lastWireShading = state.shading;
    }
    if (docChanged || state.frame !== this.lastParticleFrame || state.shading !== this.lastParticleShading) {
      this.syncOcean(state);
      this.syncParticles(state);
      this.lastParticleFrame = state.frame;
      this.lastParticleShading = state.shading;
    }
    const editKey = state.edit ? `${state.edit.id}|${state.edit.mode}|${state.xray}` : '';
    const editChanged = editKey !== this.lastEditKey || state.edit !== this.lastEdit || (state.edit && docChanged);
    if (editChanged) this.syncEdit(state, editKey !== this.lastEditKey);
    const poseChanged = state.pose !== this.lastPose;
    this.lastPose = state.pose;
    if (poseChanged) this.applyRigs(state);
    const sculptChanged = state.sculpt !== this.lastSculpt;
    this.lastSculpt = state.sculpt;
    if (state.selection !== this.lastSel || state.tool !== this.lastTool || editChanged || poseChanged || sculptChanged) {
      this.syncSelection(state.selection, state.tool);
      this.lastSel = state.selection;
      this.lastTool = state.tool;
    }
    this.lastEditKey = editKey;
    this.lastEdit = state.edit;
  }

  private lastEdit: AppState['edit'] = null;
  private lastPose: AppState['pose'] = null;

  // ---------------------------------------------------------------- ocean waves

  private oceans = new Map<string, { key: string; xy: Float32Array; indices: number[] }>();

  /** Water with wave height: a fine grid moved by Gerstner waves for this frame (Ocean modifier). */
  private syncOcean(state: AppState) {
    const doc = state.doc;
    const fps = animationOf(doc).fps;
    const t = state.frame / fps;
    for (const id of doc.order) {
      const o = doc.objects[id];
      const e = this.entries.get(id);
      const want = !!o?.water && ((o.water.height ?? 0) > 0 || !!o.water.surge) && !!o.mesh && e?.node instanceof Mesh;
      if (!want) {
        if (this.oceans.has(id)) {
          this.oceans.delete(id);
          if (o?.mesh && e?.node instanceof Mesh) buildVertexData(applyModifiers(o.mesh, o.modifiers)).applyToMesh(e.node, true);
        }
        continue;
      }
      const node = e!.node as Mesh;
      const w = o!.water!;
      const xs = o!.mesh!.vertices.map((v) => v[0]), ys = o!.mesh!.vertices.map((v) => v[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys), sx = Math.max(...xs) - x0, sy = Math.max(...ys) - y0;
      const [nx, ny] = oceanGrid(sx, sy, w);
      const key = `${x0},${y0},${sx},${sy},${nx},${ny}`;
      let g = this.oceans.get(id);
      if (!g || g.key !== key || node.getTotalVertices() !== (nx + 1) * (ny + 1)) {
        const xy = new Float32Array((nx + 1) * (ny + 1) * 2);
        const indices: number[] = [];
        const uvs: number[] = [];
        for (let j = 0; j <= ny; j++)
          for (let i = 0; i <= nx; i++) {
            const k = j * (nx + 1) + i;
            xy[k * 2] = x0 + (sx * i) / nx;
            xy[k * 2 + 1] = y0 + (sy * j) / ny;
            uvs.push(xy[k * 2], xy[k * 2 + 1]);
          }
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 2, d = a + nx + 1;
            indices.push(a, b, c, a, c, d);
          }
        const vd = new VertexData();
        vd.positions = new Array(xy.length * 1.5).fill(0);
        vd.indices = indices;
        vd.uvs = uvs;
        vd.normals = new Array(xy.length * 1.5).fill(0);
        vd.applyToMesh(node, true);
        g = { key, xy, indices };
        this.oceans.set(id, g);
      }
      const n = g.xy.length / 2;
      const pos = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        const x = g.xy[k * 2], y = g.xy[k * 2 + 1];
        const [dx, dy, dz] = oceanDisplace(x, y, t, w, fps);
        // Blender (x, y, z) → Babylon (x, z, y)
        pos[k * 3] = x + dx;
        pos[k * 3 + 1] = dz;
        pos[k * 3 + 2] = y + dy;
      }
      const normals: number[] = [];
      VertexData.ComputeNormals(pos, g.indices, normals);
      node.updateVerticesData(VertexBuffer.PositionKind, pos);
      node.updateVerticesData(VertexBuffer.NormalKind, normals);
      node.refreshBoundingInfo();
    }
  }

  // ---------------------------------------------------------------- particles

  private particleMeshes = new Map<string, { key: string; mesh: Mesh; mat: PBRMaterial | StandardMaterial; frame: ParticleFrame; settings: ParticleSettings }>();
  private lastParticleFrame = -1;
  private lastParticleShading: AppState['shading'] = 'solid';
  private puffTex: DynamicTexture | null = null;

  /** A soft round puff (white, alpha falling off to the edge) for fire and smoke. */
  private puffTexture(): DynamicTexture {
    if (this.puffTex) return this.puffTex;
    const t = new DynamicTexture('particle-puff', { width: 64, height: 64 }, this.scene, true);
    const c = t.getContext() as unknown as CanvasRenderingContext2D;
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    t.update();
    t.hasAlpha = true;
    t.metadata = { shared: true };
    this.puffTex = t;
    return t;
  }

  /** Particle systems: one thin-instanced mesh per emitter, positions worked out for this frame. */
  private syncParticles(state: AppState) {
    const doc = state.doc;
    const fps = animationOf(doc).fps;
    const live = new Set<string>();
    const rendered = state.shading === 'rendered';
    for (const id of doc.order) {
      const o = doc.objects[id];
      const e = this.entries.get(id);
      if (!o?.particles || !o.visible) continue;
      live.add(id);
      const s = o.particles;
      const key = `${s.shape}|${s.color}|${s.glow}`;
      let pm = this.particleMeshes.get(id);
      if (!pm || pm.key !== key) {
        pm?.mesh.dispose();
        pm?.mat.dispose();
        const sc = this.scene;
        let mesh: Mesh;
        let mat: PBRMaterial | StandardMaterial;
        if (isBillboard(s.shape)) {
          // Fire and smoke: camera-facing soft puffs, coloured and faded per particle.
          mesh = MeshBuilder.CreatePlane(`${id}-particles`, { size: 1, sideOrientation: Mesh.DOUBLESIDE }, sc);
          // Unlit: each puff shows its own colour (set per particle), shaped by the soft texture.
          const um = new PBRMaterial(`${id}-particles-mat`, sc);
          um.unlit = true;
          um.albedoColor = Color3.White();
          um.albedoTexture = this.puffTexture();
          um.useAlphaFromAlbedoTexture = true;
          um.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
          um.disableDepthWrite = true;
          um.alphaMode = s.shape === 'fire' ? 1 /* additive */ : 2 /* blend */;
          um.backFaceCulling = false;
          mesh.hasVertexAlpha = true;
          mat = um;
        } else {
          mesh =
            s.shape === 'cube'
              ? MeshBuilder.CreateBox(`${id}-particles`, { size: 1 }, sc)
              : s.shape === 'flake'
                ? MeshBuilder.CreatePolyhedron(`${id}-particles`, { type: 1, size: 0.5 }, sc)
                : MeshBuilder.CreateSphere(`${id}-particles`, { diameter: 1, segments: 4 }, sc);
          const pb = new PBRMaterial(`${id}-particles-mat`, sc);
          const c = Color3.FromHexString(s.color);
          pb.albedoColor = c;
          pb.metallic = 0;
          pb.roughness = s.shape === 'drop' ? 0.15 : 0.55;
          pb.emissiveColor = c.scale(s.glow * 3);
          mat = pb;
        }
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.metadata = { particles: id };
        pm = { key, mesh, mat, frame: { positions: [], sizes: [], spins: [], dirs: [], life: [] }, settings: s };
        this.particleMeshes.set(id, pm);
      }
      pm.frame = particlesAt(doc, id, state.frame, fps);
      pm.settings = s;
      this.layoutParticles(pm);
      // "Show Emitter" off: the emitter disappears in Rendered shading and videos.
      if (e && state.shading !== 'wireframe') for (const mm of e.meshes) mm.visibility = s.hideEmitter && rendered ? 0 : 1;
    }
    for (const [id, pm] of this.particleMeshes)
      if (!live.has(id)) {
        pm.mesh.dispose();
        pm.mat.dispose();
        this.particleMeshes.delete(id);
        const e = this.entries.get(id);
        if (e && state.shading !== 'wireframe') for (const mm of e.meshes) mm.visibility = 1;
      }
  }

  /** Instance matrices (and, for fire and smoke, colours) for one particle system. */
  private layoutParticles(pm: { mesh: Mesh; frame: ParticleFrame; settings: ParticleSettings }) {
    const { frame: f, settings: s, mesh } = pm;
    const n = f.positions.length;
    const buf = new Float32Array(Math.max(1, n) * 16);
    const m = new Matrix();
    const q = new Quaternion();
    const up = Vector3.Up();
    const bill = isBillboard(s.shape);
    const camQ = bill ? this.camera.absoluteRotation : null;
    const cols = bill ? new Float32Array(Math.max(1, n) * 4) : null;
    const base = Color3.FromHexString(s.color);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = toBabylonVec(f.positions[i]);
      let sz = f.sizes[i];
      if (bill) {
        const t = f.life[i];
        let r: number, g: number, b: number, a: number;
        if (s.shape === 'fire') {
          // Hot white-yellow core → the flame colour → dark red, fading in and out; flames taper.
          sz *= t < 0.25 ? 0.6 + 1.6 * t : 1 - (t - 0.25) * 0.9;
          const hot = Math.max(0, 1 - t / 0.22);
          const cool = Math.min(1, Math.max(0, (t - 0.25) / 0.5));
          r = (base.r + (1 - base.r) * hot) * (1 - cool * 0.35);
          g = (base.g + (0.9 - base.g) * hot) * (1 - cool * 0.85);
          b = (base.b + (0.55 - base.b) * hot) * (1 - cool);
          a = Math.min(1, t / 0.08) * Math.pow(1 - t, 1.5) * 0.8;
        } else {
          // Smoke: grows and spreads, fades in quickly and thins out slowly. Glow brightens it
          // (sunlit steam, white spray) without making it additive like fire.
          sz *= 1 + t * 2.2;
          const lift = 1 + s.glow * 1.5;
          r = (base.r + (1 - base.r) * t * 0.25) * lift;
          g = (base.g + (1 - base.g) * t * 0.25) * lift;
          b = (base.b + (1 - base.b) * t * 0.25) * lift;
          a = Math.min(1, t / 0.12) * (1 - t) * 0.55;
        }
        cols!.set([r, g, b, a], i * 4);
        Quaternion.RotationAxisToRef(Vector3.Forward(), (f.spins[i] * Math.PI) / 180, q);
        camQ!.multiplyToRef(q, q);
        Matrix.ComposeToRef(new Vector3(sz, sz, sz), q, new Vector3(x, y, z), m);
      } else if (s.shape === 'drop') {
        // Raindrops and water: stretched along their direction of travel.
        const d = toBabylonVec(f.dirs[i]);
        Quaternion.FromUnitVectorsToRef(up, new Vector3(d[0], d[1], d[2]), q);
        Matrix.ComposeToRef(new Vector3(sz * 0.6, sz * 2.4, sz * 0.6), q, new Vector3(x, y, z), m);
      } else {
        Quaternion.RotationYawPitchRollToRef((f.spins[i] * Math.PI) / 180, (f.spins[i] * Math.PI) / 360, 0, q);
        Matrix.ComposeToRef(new Vector3(sz, sz, sz), q, new Vector3(x, y, z), m);
      }
      m.copyToArray(buf, i * 16);
    }
    mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
    if (cols) mesh.thinInstanceSetBuffer('color', cols, 4, false);
    mesh.thinInstanceCount = n;
    mesh.setEnabled(n > 0);
  }

  /** Fire and smoke face the camera: re-aim them whenever the view turns. */
  private aimBillboards() {
    const rot = this.camera.absoluteRotation;
    const k = `${rot.x.toFixed(4)},${rot.y.toFixed(4)},${rot.z.toFixed(4)},${rot.w.toFixed(4)}`;
    if (k === this.lastBillboardKey) return;
    this.lastBillboardKey = k;
    for (const pm of this.particleMeshes.values()) if (isBillboard(pm.settings.shape) && pm.frame.positions.length) this.layoutParticles(pm);
  }
  private lastBillboardKey = '';

  // ---------------------------------------------------------------- wireframe shading

  private wire = new Map<string, { key: unknown[]; lines: LinesMesh }>();
  private wireMats = new Set<{ wireframe: boolean }>();
  private lastWireShading: AppState['shading'] = 'solid';

  /**
   * Wireframe shading (Blender's first shading mode): every polygon edge, seen through the model,
   * with the surfaces hidden. Meshes and shapes draw their real edges; models, scatter and posed
   * characters fall back to their triangles.
   */
  private syncWire(state: AppState) {
    const on = state.shading === 'wireframe';
    const doc = state.doc;
    const keep = new Set<string>();
    for (const [id, e] of this.entries) {
      const o = doc.objects[id];
      const surfaces = e.meshes;
      if (!on || !o || !o.visible) {
        for (const m of surfaces) m.visibility = 1;
        continue;
      }
      const prim = (PRIMITIVES as readonly string[]).includes(o.type);
      const ownEdges = (o.type === 'mesh' && o.mesh && !o.skin) || prim;
      if (!ownEdges) {
        for (const m of surfaces) {
          const mat = m.material as { wireframe: boolean } | null;
          if (mat && !mat.wireframe) {
            mat.wireframe = true;
            this.wireMats.add(mat);
          }
        }
        continue;
      }
      for (const m of surfaces) m.visibility = 0;
      if (state.edit?.id === id) continue; // the edit overlay draws the cage
      const selected = state.selection === id;
      const key = [o.mesh, o.modifiers, o.type, o.params, selected];
      keep.add(id);
      const prev = this.wire.get(id);
      if (prev && prev.key.length === key.length && prev.key.every((k, i) => k === key[i])) continue;
      prev?.lines.dispose();
      const geo = o.type === 'mesh' ? applyModifiers(o.mesh!, o.modifiers) : primitiveMesh(o.type as PrimitiveType, o.params);
      const seen = new Set<string>();
      const lines: Vector3[][] = [];
      const p = geo.vertices.map((v) => new Vector3(...toBabylonVec(v)));
      for (const f of geo.faces)
        for (let i = 0; i < f.length; i++) {
          const a = f[i], b = f[(i + 1) % f.length];
          const k = a < b ? `${a}_${b}` : `${b}_${a}`;
          if (seen.has(k)) continue;
          seen.add(k);
          lines.push([p[a], p[b]]);
        }
      const ls = MeshBuilder.CreateLineSystem(`${id}-wire`, { lines }, this.scene);
      ls.color = selected ? SELECT_COLOR : WIRE_COLOR;
      ls.isPickable = false;
      ls.parent = e.node;
      this.wire.set(id, { key, lines: ls });
    }
    for (const [id, w] of this.wire)
      if (!keep.has(id)) {
        w.lines.dispose();
        this.wire.delete(id);
      }
    if (!on) {
      for (const mat of this.wireMats) mat.wireframe = false;
      this.wireMats.clear();
    }
  }

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
      let explicit: Weights | null = null;
      const ref = o.skin.weights;
      if (ref) {
        explicit = humanWeights(ref);
        if (!explicit) {
          // Library weights not loaded yet (e.g. after a reload): fetch, then redraw.
          const preset = /^humans\/([a-z0-9_-]+)#/.exec(ref)?.[1];
          if (preset) void loadHuman(preset).then((d) => d && this.redrawRigs());
          continue;
        }
      }
      const deformed = skinMesh(doc, id, ev.out, state.frame, this.bindCache, explicit);
      this.updateDeformed(e.node, deformed);
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

  private redrawRigs() {
    this.skinned.clear();
    this.applyRigs(this.store.getState());
  }

  /** Topology cache per mesh face list: triangle indices for fast per-frame updates. */
  private topo = new WeakMap<object, { indices: number[] }>();

  /** Update a skinned mesh's vertices in place (smooth meshes: positions + normals only). */
  private updateDeformed(node: Mesh, mesh: MeshData) {
    if (!mesh.smooth) {
      buildVertexData(mesh).applyToMesh(node, true);
      node.refreshBoundingInfo();
      return;
    }
    let t = this.topo.get(mesh.faces);
    const n = mesh.vertices.length;
    const fresh = !t || node.getTotalVertices() !== n || node.metadata?.topo !== mesh.faces;
    if (fresh) {
      buildVertexData(mesh).applyToMesh(node, true);
      t = { indices: Array.from(node.getIndices() ?? []) };
      this.topo.set(mesh.faces, t);
      node.metadata = { ...node.metadata, topo: mesh.faces };
      node.refreshBoundingInfo();
      return;
    }
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = mesh.vertices[i];
      pos[i * 3] = v[0];
      pos[i * 3 + 1] = v[2];
      pos[i * 3 + 2] = v[1];
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(pos, t!.indices, normals);
    node.updateVerticesData('position', pos, false, false);
    node.updateVerticesData('normal', normals, false, false);
    node.refreshBoundingInfo();
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
    const prop = st.proportional;
    const weights = prop.on
      ? proportionalWeights(
          o.mesh.vertices.map((v) => {
            const b = Vector3.TransformCoordinates(new Vector3(...toBabylonVec(v)), world);
            return fromBabylonVec([b.x, b.y, b.z]);
          }),
          ed.sel.verts,
          prop.radius,
        )
      : undefined;
    this.editDrag = {
      id: ed.id,
      mesh: o.mesh,
      verts: weights ? [...weights.keys()] : [...ed.sel.verts],
      startInv: this.editPivot.computeWorldMatrix(true).clone().invert(),
      world,
      worldInv: world.clone().invert(),
      weights,
    };
  }

  private stepEditDrag() {
    const d = this.editDrag;
    if (!d) return;
    const cur = this.editPivot.computeWorldMatrix(true);
    // local → world → undo pivot start → apply pivot now → back to local
    const m = d.world.multiply(d.startInv).multiply(cur).multiply(d.worldInv);
    const mods = this.store.getState().doc.objects[d.id]?.modifiers;
    const clip = mods?.mirror?.clip ? mods.mirror : null;
    const mesh = transformVerts(d.mesh, d.verts, (p, i) => {
      const b = Vector3.TransformCoordinates(new Vector3(...toBabylonVec(p)), m);
      let out = fromBabylonVec([b.x, b.y, b.z]);
      const w = d.weights?.get(i) ?? 1;
      if (w < 1) out = [p[0] + (out[0] - p[0]) * w, p[1] + (out[1] - p[1]) * w, p[2] + (out[2] - p[2]) * w];
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
    // Objects floating on water ride the waves (after their own animation).
    for (const id of state.doc.order) {
      const o = state.doc.objects[id];
      if (!o?.float) continue;
      const e = this.entries.get(id);
      if (!e || (this.dragging && id === sel)) continue;
      const ft = floatTransform(state.doc, id, state.frame);
      if (!ft) continue;
      now.add(id);
      this.applyTransform(e.node, { ...o, transform: ft });
    }
    // Objects whose animation was removed go back to their own transform.
    for (const id of this.animated) {
      if (now.has(id)) continue;
      const e = this.entries.get(id);
      const o = state.doc.objects[id];
      if (e && o) this.applyTransform(e.node, o);
    }
    this.animated = now;
    this.applyFlashes(state);
    this.applyRigs(state);
    if (state.cameraView) {
      const cam = (anim?.camera.length ? evaluateCamera(anim.camera, state.frame) : null) ?? state.doc.camera;
      if (cam) {
        const c = shakeCamera(cam, anim?.shakes, state.frame, anim?.fps ?? 24);
        this.placeCamera(c.position, c.target);
      }
    }
  }

  /** Explosion lights on force fields: brightness for the current frame. */
  private applyFlashes(state: AppState) {
    const fps = state.doc.animation?.fps ?? 24, first = state.doc.animation?.start ?? 1;
    for (const [id, e] of this.entries) {
      const f = e.flash && state.doc.objects[id]?.field;
      if (!f || !e.flash) continue;
      e.flash.diffuse = Color3.FromHexString(f.flashColor ?? DEFAULT_FLASH_COLOR);
      e.flash.specular = e.flash.diffuse;
      e.flash.intensity = (f.flash ?? 0) * POINT_SCALE * flashLevel(f, state.frame, fps, first);
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
    return `${o.type}|${JSON.stringify(o.params ?? {})}|${o.light?.type ?? ''}|${o.asset ?? ''}|${o.field ? `${o.field.type}:${o.field.radius}:${o.field.flash ? 'flash' : ''}` : ''}`;
  }

  private disposeEntry(e: Entry) {
    e.shadow?.dispose();
    e.light?.dispose();
    e.flash?.dispose();
    e.material?.dispose();
    e.node.dispose(false, true);
  }

  private syncDoc(doc: SceneDoc) {
    let structure = false;
    for (const [id, e] of this.entries) {
      if (!doc.objects[id]) {
        this.disposeEntry(e);
        this.entries.delete(id);
        this.waters.get(id)?.tex.dispose();
        this.waters.delete(id);
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
      if (o.terrain && e.node instanceof Mesh && (e.last?.terrain !== o.terrain || e.last?.mesh !== o.mesh)) this.applyTerrain(e, o);
      if (o.type === 'scatter' && e.last && e.last.scatter !== o.scatter) this.applyScatterItems(e, o);
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
    if (o.type === 'scatter') {
      const node = new TransformNode(o.name, s);
      node.rotationQuaternion = new Quaternion();
      node.metadata = { id: o.id, export: true };
      const entry: Entry = { node, pick: null, key, meshes: [] };
      const job = this.attachScatter(entry, o).finally(() => this.pending.delete(job));
      this.pending.add(job);
      return entry;
    }
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
    // empty: small axes cross; a force field also shows its reach (rings) and direction.
    const size = 0.5;
    const lines: Vector3[][] = [
      [new Vector3(-size, 0, 0), new Vector3(size, 0, 0)],
      [new Vector3(0, -size, 0), new Vector3(0, size, 0)],
      [new Vector3(0, 0, -size), new Vector3(0, 0, size)],
    ];
    if (o.field) {
      const r = o.field.radius > 0 ? o.field.radius : 2;
      const ring = (f: (a: number) => Vector3) => Array.from({ length: 49 }, (_, i) => f((i / 48) * Math.PI * 2));
      // Babylon Y = Blender Z.
      lines.push(ring((a) => new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)));
      if (o.field.type === 'force') {
        lines.push(ring((a) => new Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)), ring((a) => new Vector3(0, Math.cos(a) * r, Math.sin(a) * r)));
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          lines.push([new Vector3(Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6), new Vector3(Math.cos(a) * 1.4, 0, Math.sin(a) * 1.4)]);
        }
      } else if (o.field.type === 'wind') {
        lines.push([new Vector3(0, 0, 0), new Vector3(0, 2.5, 0)], [new Vector3(0, 2.5, 0), new Vector3(0.3, 2.1, 0)], [new Vector3(0, 2.5, 0), new Vector3(-0.3, 2.1, 0)]);
      } else {
        lines.push(Array.from({ length: 97 }, (_, i) => {
          const a = (i / 48) * Math.PI * 2, rr = (i / 96) * r;
          return new Vector3(Math.cos(a) * rr, (i / 96) * 2, Math.sin(a) * rr);
        }));
      }
    }
    const helper = MeshBuilder.CreateLineSystem(`${o.id}-helper`, { lines }, s);
    helper.color = o.field ? new Color3(0.55, 0.75, 1) : HELPER_COLOR;
    helper.intersectionThreshold = 0.15;
    helper.metadata = { id: o.id };
    helper.parent = node;
    let flash: PointLight | undefined;
    if (o.field?.flash) {
      // Explosion light: off until the field starts (applyFlashes sets it per frame).
      // Raised above the centre so the ground right under it isn't a white-hot spot (Babylon Y = up).
      flash = new PointLight(`${o.id}-flash`, new Vector3(0, Math.min(10, Math.max(1, o.field.radius * 0.25)), 0), s);
      flash.parent = node;
      flash.intensity = 0;
      flash.setEnabled(this.store.getState().shading === 'rendered');
    }
    return { node, pick: helper, key, meshes: [], flash };
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

  // ---------------------------------------------------------------- terrain & scatter

  private terrainPlugins = new WeakMap<PBRMaterial, TerrainPlugin>();

  /** Splat weights as a vertex buffer, and the path / rock layers on the material. */
  private applyTerrain(e: Entry, o: SceneObject) {
    const t = o.terrain!;
    const mesh = e.node as Mesh;
    if (!o.mesh?.smooth || mesh.getTotalVertices() !== t.splat.length / 3) return;
    mesh.setVerticesData('splat', new Float32Array(t.splat), false, 3);
    const mat = e.material;
    if (!mat) return;
    let plugin = this.terrainPlugins.get(mat);
    if (!plugin) {
      plugin = new TerrainPlugin(mat);
      this.terrainPlugins.set(mat, plugin);
    }
    const load = (id: string) => {
      const tex = new Texture(textureUrl(id, 'diff'), this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.anisotropicFilteringLevel = 8;
      return tex;
    };
    if (plugin.layer1?.name !== textureUrl(t.layers[1], 'diff')) {
      plugin.layer1?.dispose();
      plugin.layer1 = load(t.layers[1]);
    }
    if (plugin.layer2?.name !== textureUrl(t.layers[2], 'diff')) {
      plugin.layer2?.dispose();
      plugin.layer2 = load(t.layers[2]);
    }
    plugin.scales = [t.scales[1], t.scales[2]];
    plugin.enabled = true;
  }

  /** Total triangles drawn by one scatter object is capped so a forest stays smooth on a tablet. */
  private static SCATTER_TRI_BUDGET = 400_000;

  private async attachScatter(e: Entry, o: SceneObject) {
    const asset = o.scatter?.asset;
    if (!asset) return this.attachScatterFromSource(e, o);
    try {
      this.loadersReady ??= import('@babylonjs/loaders/glTF/2.0');
      await this.loadersReady;
      let p = this.containers.get(asset);
      if (!p) {
        p = LoadAssetContainerAsync(modelUrl(asset), this.scene, { pluginExtension: '.glb' });
        this.containers.set(asset, p);
        p.catch(() => this.containers.delete(asset));
      }
      const container = await p;
      if (this.entries.get(o.id) !== e) return;
      const inst = container.instantiateModelsToScene((n) => `${o.id}-${n}`, false, { doNotInstantiate: true });
      const holder = new TransformNode(`${o.id}-template`, this.scene);
      for (const root of inst.rootNodes) root.parent = holder;
      holder.parent = e.node;
      e.meshes = e.node.getChildMeshes(false).filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
      // Simplify the template when many copies would exceed the triangle budget.
      await MeshoptSimplifier.ready;
      const tris = e.meshes.reduce((s, m) => s + (m.getTotalIndices() / 3), 0);
      const count = Math.max(1, o.scatter!.items.length);
      const ratio = Math.min(1, Viewport.SCATTER_TRI_BUDGET / (tris * count));
      if (ratio < 0.95) for (const m of e.meshes) simplifyMesh(m as Mesh, Math.max(ratio, 0.01));
      for (const m of e.meshes) {
        m.metadata = { ...(m.metadata ?? {}), id: o.id, export: true, scatter: true };
        m.isPickable = true;
        (m as Mesh).thinInstanceEnablePicking = true;
        m.outlineColor = SELECT_COLOR;
        m.outlineWidth = 0.01;
        m.alwaysSelectAsActiveMesh = false;
      }
      e.pick = e.meshes[0] ?? null;
      e.last = o;
      this.applyScatterItems(e, o);
      this.applyShading();
      this.syncSelection(this.store.getState().selection, this.store.getState().tool);
    } catch {
      this.store.notify(`Could not load “${asset}” for ${o.name}.`);
    }
  }

  /** Scatter copies of an object already in the scene (a template such as an addPlant tree). */
  private attachScatterFromSource(e: Entry, o: SceneObject) {
    const src = o.scatter?.source;
    const doc = this.store.getState().doc;
    if (!src || !doc.objects[src]) return Promise.resolve();
    const root = this.entries.get(src)?.node;
    if (!root) return Promise.resolve();
    const rootInv = root.computeWorldMatrix(true).clone().invert();
    const holder = new TransformNode(`${o.id}-template`, this.scene);
    holder.parent = e.node;
    for (const id of subtree(doc, src)) {
      const te = this.entries.get(id);
      if (!te) continue;
      for (const m of te.meshes) {
        if (!(m instanceof Mesh)) continue;
        const local = m.computeWorldMatrix(true).multiply(rootInv);
        const c = m.clone(`${o.id}-${m.name}`, null, true)!;
        c.setEnabled(true);
        c.isVisible = true;
        c.parent = holder;
        c.setPreTransformMatrix(BMatrix.Identity());
        const sc = new Vector3(), rq = new Quaternion(), tr = new Vector3();
        local.decompose(sc, rq, tr);
        c.position.copyFrom(tr);
        c.rotationQuaternion = rq;
        c.scaling.copyFrom(sc);
        c.metadata = { id: o.id, export: true, scatter: true };
        c.thinInstanceEnablePicking = true;
        c.outlineColor = SELECT_COLOR;
        c.outlineWidth = 0.01;
        e.meshes.push(c);
      }
    }
    e.pick = e.meshes[0] ?? null;
    e.last = o;
    this.applyScatterItems(e, o);
    this.applyShading();
    return Promise.resolve();
  }

  /** Thin instances: one GPU draw per template mesh, a matrix per item (world space, Blender → Babylon). */
  private applyScatterItems(e: Entry, o: SceneObject) {
    const items = o.scatter?.items ?? [];
    const nodeInv = e.node.computeWorldMatrix(true).clone().invert();
    for (const m of e.meshes as Mesh[]) {
      const L = m.computeWorldMatrix(true).multiply(nodeInv); // mesh relative to the scatter node
      const Linv = L.clone().invert();
      const buf = new Float32Array(items.length * 16);
      const tmp = new BMatrix();
      items.forEach(([x, y, z, yaw, sc], i) => {
        const q = eulerDegToBabylonQuat([0, 0, yaw]);
        const T = BMatrix.Compose(new Vector3(sc, sc, sc), new Quaternion(q[0], q[1], q[2], q[3]), new Vector3(x, z, y));
        L.multiplyToRef(T, tmp);
        tmp.multiplyToRef(Linv, tmp);
        tmp.copyToArray(buf, i * 16);
      });
      m.thinInstanceSetBuffer('matrix', buf, 16, true);
      m.thinInstanceRefreshBoundingInfo(false);
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
    if (prev && prev.texture === m.texture && prev.textureScale === m.textureScale && prev.pattern === m.pattern) return;
    for (const t of [mat.albedoTexture, mat.bumpTexture, mat.metallicTexture]) if (t && !isSharedTexture(t)) t.dispose();
    mat.albedoTexture = mat.bumpTexture = mat.metallicTexture = mat.emissiveTexture = null;
    mat.useAmbientOcclusionFromMetallicTextureRed = mat.useRoughnessFromMetallicTextureGreen = mat.useMetallnessFromMetallicTextureBlue = false;
    if (!m.texture && m.pattern) {
      // Procedural pattern: colour map + bump from the same values (Blender: texture → colour and bump).
      mat.albedoTexture = patternColorTexture(this.scene, m.pattern);
      if (m.pattern.bump > 0) {
        mat.bumpTexture = patternNormalTexture(this.scene, m.pattern.type, m.pattern.scale, m.pattern.bump);
        mat.invertNormalMapX = mat.invertNormalMapY = false;
      }
      // Glow: the pattern drives emission (lit windows at night, glowing cracks…).
      if (m.pattern.glow) mat.emissiveTexture = patternGlowTexture(this.scene, m.pattern);
      return;
    }
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
      // A glowing pattern's map carries the colour; its strength scales it (and replaces Emission).
      const glow = !m.texture && m.pattern?.glow ? m.pattern.glow : 0;
      mat.emissiveColor = glow ? new Color3(glow, glow, glow) : Color3.FromHexString(m.emission).toLinearSpace().scale(m.emissionStrength);
      mat.alpha = m.alpha;
      mat.transparencyMode = m.alpha < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
      // A pattern carries the colour itself.
      if (!m.texture && m.pattern) mat.albedoColor = Color3.White();
      applyPrincipled(mat, m);
    }
    if (e.material && o.water && (o.water !== prev?.water || o.material !== prev?.material)) {
      const mat = e.material;
      let tex = this.waters.get(o.id)?.tex;
      if (!tex) tex = rippleNormalTexture(this.scene);
      tex.uScale = tex.vScale = 1 / (o.water.waves * 16);
      tex.level = 0.45;
      mat.bumpTexture = tex;
      mat.environmentIntensity = 1.2;
      this.waters.set(o.id, { tex, water: o.water });
    } else if (!o.water && this.waters.has(o.id)) {
      if (e.material) e.material.bumpTexture = null;
      this.waters.get(o.id)!.tex.dispose();
      this.waters.delete(o.id);
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
    for (const e of this.entries.values()) e.flash?.setEnabled(rendered);
    const casters = [...this.entries.values()].flatMap((e) => e.meshes);
    let shadowCount = 0;
    for (const e of sceneLights) {
      const obj = e.last;
      e.light!.setEnabled(rendered);
      const wantShadow = rendered && !!obj?.light?.shadows && obj.light.type !== 'point' && shadowCount < MAX_SHADOW_LIGHTS;
      if (wantShadow) {
        shadowCount++;
        if (!e.shadow) {
          const q = this.quality();
          const sg = new ShadowGenerator(q === 'best' ? 2048 : 1024, e.light as DirectionalLight | SpotLight);
          sg.usePercentageCloserFiltering = q !== 'fast';
          if (q === 'best') sg.filteringQuality = ShadowGenerator.QUALITY_HIGH;
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
    // The skybox shows a clone of the environment: keep its rotation in step with the lighting.
    const skyTex = (this.skybox?.material as { reflectionTexture?: { rotationY: number } } | null)?.reflectionTexture;
    if (skyTex && 'rotationY' in env) skyTex.rotationY = (env as unknown as { rotationY: number }).rotationY;
    if (this.skybox) this.skybox.applyFog = false;
    // Distance haze (rendered only): EXP2 fog, half-hidden at w.fog metres.
    if (rendered && w.fog > 0) {
      scene.fogMode = 2; // Scene.FOGMODE_EXP2
      scene.fogDensity = Math.sqrt(Math.LN2) / w.fog;
      // The fog colour is blended before exposure / tone mapping: undo exposure so the haze
      // meets the sky's horizon colour on screen.
      scene.fogColor = Color3.FromHexString(w.fogColor).toLinearSpace().scale(1 / Math.max(0.05, w.exposure));
    } else scene.fogMode = 0;
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
      const q = this.quality();
      this.pipeline.bloomEnabled = w.bloom > 0 && q !== 'fast';
      this.pipeline.bloomWeight = w.bloom;
      const wantAo = w.ao && q !== 'fast';
      if (this.ssao && this.ssaoQuality !== q) {
        this.ssao.dispose(true);
        this.ssao = null;
      }
      if (wantAo && !this.ssao && SSAO2RenderingPipeline.IsSupported) {
        const ssao = new SSAO2RenderingPipeline('ao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera], true);
        ssao.radius = 0.5;
        ssao.totalStrength = 1.1;
        ssao.samples = q === 'best' ? 16 : 8;
        ssao.maxZ = 60;
        ssao.expensiveBlur = q === 'best';
        this.ssao = ssao;
        this.ssaoQuality = q;
      } else if (!wantAo && this.ssao) {
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
    if (st.sculpt) {
      // Sculpt mode: no gizmo, no outline: the brush is the tool.
      for (const m of this.entries.get(st.sculpt.id)?.meshes ?? []) m.renderOutline = false;
      gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = false;
      gm.attachToNode(null);
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
  // ---------------------------------------------------------------- sculpt

  private stroke: {
    id: string;
    pointer: number;
    ctx: StrokeContext;
    faces: number[][];
    verts: Vec3[];
    world: Matrix;
    worldInv: Matrix;
    /** World metres per CSS pixel at the start point, and the local/world scale. */
    mPerPx: number;
    localPerWorld: number;
    startLocal: Vec3;
    startWorld: Vector3;
    last: { x: number; y: number };
    raf: number;
    pending: { x: number; y: number } | null;
  } | null = null;

  private sculptPick(x: number, y: number, id: string) {
    const e = this.entries.get(id);
    if (!e) return null;
    const pick = this.scene.pick(x, y, (m) => m === e.node || m.parent === e.node);
    return pick?.hit && pick.pickedPoint ? pick.pickedPoint : null;
  }

  private sculptDown(ev: PointerEvent) {
    const st = this.store.getState();
    if (!st.sculpt || this.stroke || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const o = st.doc.objects[st.sculpt.id];
    const e = this.entries.get(st.sculpt.id);
    if (!o?.mesh || !e) return;
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const hit = this.sculptPick(x, y, o.id);
    if (!hit) return; // off the mesh: let the camera orbit
    ev.stopImmediatePropagation();
    ev.preventDefault();
    this.canvas.setPointerCapture?.(ev.pointerId);
    this.camera.inputs.attached.pointers?.detachControl();
    const world = e.node.computeWorldMatrix(true).clone();
    const worldInv = world.clone().invert();
    const scale = new Vector3();
    world.decompose(scale);
    const dist = Vector3.Distance(this.camera.position, hit);
    const mPerPx = (2 * dist * Math.tan(this.camera.fov / 2)) / Math.max(1, r.height);
    const local = Vector3.TransformCoordinates(hit, worldInv);
    this.stroke = {
      id: o.id,
      pointer: ev.pointerId,
      ctx: strokeContext(o.mesh),
      faces: o.mesh.faces,
      verts: o.mesh.vertices.map((v) => [...v] as Vec3),
      world,
      worldInv,
      mPerPx,
      localPerWorld: 1 / Math.max(1e-6, (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3),
      startLocal: fromBabylonVec([local.x, local.y, local.z]),
      startWorld: hit.clone(),
      last: { x, y },
      raf: 0,
      pending: { x, y },
    };
    this.sculptFlush();
  }

  private sculptMove(ev: PointerEvent) {
    const s = this.stroke;
    if (!s || ev.pointerId !== s.pointer) return;
    const r = this.canvas.getBoundingClientRect();
    s.pending = { x: ev.clientX - r.left, y: ev.clientY - r.top };
    if (!s.raf) s.raf = requestAnimationFrame(() => this.sculptFlush());
  }

  /** Apply the brush at the latest pointer position (at most once per frame). */
  private sculptFlush() {
    const s = this.stroke;
    if (!s) return;
    s.raf = 0;
    const p = s.pending;
    s.pending = null;
    if (!p) return;
    const b = this.store.getState().sculptBrush;
    const radius = b.radius * s.mPerPx * s.localPerWorld;
    let opts: Parameters<typeof brushStep>[3];
    if (b.brush === 'grab') {
      // Move in the view plane through the start point.
      const ray = this.scene.createPickingRay(p.x, p.y, null, this.camera);
      const n = this.camera.getForwardRay().direction;
      const t = Vector3.Dot(s.startWorld.subtract(ray.origin), n) / Vector3.Dot(ray.direction, n);
      const w = ray.origin.add(ray.direction.scale(t));
      const l = Vector3.TransformCoordinates(w, s.worldInv);
      const cur = fromBabylonVec([l.x, l.y, l.z]);
      opts = { brush: 'grab', center: s.startLocal, radius, strength: b.strength, symmetryX: b.symmetry, grabStart: s.startLocal, grabDelta: [cur[0] - s.startLocal[0], cur[1] - s.startLocal[1], cur[2] - s.startLocal[2]] };
    } else {
      const hit = this.sculptPick(p.x, p.y, s.id);
      if (!hit) return;
      const l = Vector3.TransformCoordinates(hit, s.worldInv);
      opts = { brush: b.brush, center: fromBabylonVec([l.x, l.y, l.z]), radius, strength: b.strength, invert: b.invert, symmetryX: b.symmetry };
    }
    s.verts = brushStep(s.verts, s.faces, s.ctx, opts);
    s.last = p;
    const o = this.store.getState().doc.objects[s.id];
    if (o?.mesh) this.store.preview({ type: 'setMesh', id: s.id, mesh: { ...o.mesh, vertices: s.verts.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5) as Vec3) } });
  }

  private sculptUp(cancel = false) {
    const s = this.stroke;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (!cancel) this.sculptFlush();
    this.stroke = null;
    if (cancel) this.store.cancelPreview();
    else this.store.commitPreview();
    this.camera.inputs.attached.pointers?.attachControl(true);
  }

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
  /** World-space centre of an object's visible geometry (Blender coordinates), or null. */
  objectCenter(id: string): Vec3 | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const meshes = [e.node, ...e.node.getChildMeshes(false)].filter((m): m is AbstractMesh => m instanceof AbstractMesh && m.isEnabled() && m.getTotalVertices() > 0);
    if (!meshes.length) return fromBabylonVec([e.node.absolutePosition.x, e.node.absolutePosition.y, e.node.absolutePosition.z].map((v) => clean(v, 3)) as Vec3);
    let min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of meshes) {
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
    const c = min.add(max).scale(0.5);
    return fromBabylonVec([clean(c.x, 3), clean(c.y, 3), clean(c.z, 3)]);
  }

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
    // Videos always render at Best (soft shadows, full AO and bloom), whatever this device's setting.
    this.recording = true;
    this.forceBest = true;
    this.sync(this.store.getState());
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
      this.forceBest = false;
      this.recording = false;
      this.sync(this.store.getState());
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
  async exportGLB(opts: { ids?: Set<string>; exclude?: Set<string>; lights?: boolean } = {}): Promise<Blob> {
    const [{ GLTF2Export }] = await Promise.all([
      import('@babylonjs/serializers/glTF/2.0/glTFSerializer'),
      // Exporter plug-ins: texture tiling, scatter instancing, lights.
      import('@babylonjs/serializers/glTF/2.0/Extensions/KHR_texture_transform'),
      import('@babylonjs/serializers/glTF/2.0/Extensions/EXT_mesh_gpu_instancing'),
      import('@babylonjs/serializers/glTF/2.0/Extensions/KHR_lights_punctual'),
    ]);
    const { ids, exclude, lights = true } = opts;
    const owner = (node: Node | null): string | null => {
      for (let n = node; n; n = n.parent) if (n.metadata?.id) return n.metadata.id as string;
      return null;
    };
    const result = await GLTF2Export.GLBAsync(this.scene, 'b3d-scene', {
      shouldExportNode: (node) => {
        if (!node.metadata?.export || !node.isEnabled()) return false;
        if (!lights && node.getClassName().endsWith('Light')) return false;
        const id = owner(node);
        if (id && exclude?.has(id)) return false;
        return !ids || (!!id && ids.has(id));
      },
    });
    const file = Object.values(result.files)[0];
    return file instanceof Blob ? file : new Blob([file as BlobPart], { type: 'model/gltf-binary' });
  }

  /**
   * Export for Roblox Studio: a .zip with the models (.glb: instances expanded, ≤ 20k tris per
   * mesh, studs, baked UV tiling), each terrain as a heightmap + colormap for Roblox Terrain,
   * and a README with the exact import numbers.
   */
  async exportRoblox(ids?: Set<string>) {
    const doc = this.store.getState().doc;
    const terrains = Object.values(doc.objects).filter((o) => o.terrain && o.mesh && (!ids || ids.has(o.id)));
    const waters = Object.values(doc.objects).filter((o) => o.water && o.mesh && (!ids || ids.has(o.id)));
    // Terrain and water become Roblox Terrain (heightmap, Sea Level) rather than meshes.
    const exclude = new Set([...terrains, ...waters].map((t) => t.id));
    const [{ toRobloxGlb }, { terrainHeightmap, encodePng }, { zipSync, zlibSync, strToU8 }] = await Promise.all([
      import('./robloxExport'),
      import('../core/robloxTerrain'),
      import('fflate'),
    ]);
    const files: Record<string, Uint8Array> = {};
    const notes: string[] = [];
    const exportable = Object.values(doc.objects).some((o) => !exclude.has(o.id) && (!ids || ids.has(o.id)) && o.visible !== false && o.type !== 'light' && o.type !== 'armature');
    let report = null;
    if (exportable) {
      const blob = await this.exportGLB({ ids, exclude, lights: false });
      const r = await toRobloxGlb(new Uint8Array(await blob.arrayBuffer()));
      files['models.glb'] = r.glb;
      report = r.report;
    }
    if (terrains.length) {
      // Fallback: the terrain as plain meshes (≤ 20k tris each), for when Roblox Terrain isn't wanted.
      const blob = await this.exportGLB({ ids: exclude, lights: false });
      files['terrain_mesh_optional.glb'] = (await toRobloxGlb(new Uint8Array(await blob.arrayBuffer()))).glb;
    }
    const heightmaps = terrains.map((t) => {
      const hm = terrainHeightmap(t);
      const slug = t.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || t.id;
      files[`${slug}_heightmap.png`] = encodePng(hm.width, hm.height, hm.heights, 1, (b) => zlibSync(b, { level: 9 }));
      files[`${slug}_colormap.png`] = encodePng(hm.width, hm.height, hm.colors, 3, (b) => zlibSync(b, { level: 9 }));
      notes.push(
        `Terrain "${t.name}": ${slug}_heightmap.png + ${slug}_colormap.png`,
        `  Size (studs):     X ${hm.sizeStuds[0]}   Y ${hm.sizeStuds[1]}   Z ${hm.sizeStuds[2]}`,
        `  Position (studs): X ${hm.positionStuds[0]}   Y ${hm.positionStuds[1]}   Z ${hm.positionStuds[2]}`,
        '',
      );
      return { name: t.name, ...hm };
    });
    const S = 1 / 0.28;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const waterNotes = waters.map((o) => {
      const xs = o.mesh!.vertices.map((v) => v[0] * o.transform.scale[0]), ys = o.mesh!.vertices.map((v) => v[1] * o.transform.scale[1]);
      const [px, py, pz] = o.transform.position;
      const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
      return `Water "${o.name}": Position X ${r1(px * S)}  Y ${r1(pz * S - 2)}  Z ${r1(-py * S)}   Size X ${r1(w * S)}  Y 4  Z ${r1(d * S)}`;
    });
    files['README.txt'] = strToU8(robloxReadme(report, notes, waterNotes, worldOf(doc).time));
    const zip = zipSync(files, { level: 0 });
    return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), report, terrains: heightmaps.length, files: Object.keys(files) };
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

/** Reduce a mesh's triangles in place (meshoptimizer), keeping its vertex data. */
function simplifyMesh(m: Mesh, ratio: number) {
  const idx = m.getIndices();
  const pos = m.getVerticesData('position');
  if (!idx || !pos) return;
  const indices = Uint32Array.from(idx);
  const target = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  const [out] = MeshoptSimplifier.simplify(indices, Float32Array.from(pos), 3, target, 0.05, ['LockBorder']);
  if (out.length >= 3) m.setIndices(Array.from(out));
}

/** Roblox Lighting.ClockTime for each B3D time of day (starting points, tweak to taste). */
const ROBLOX_CLOCK: Record<string, { clock: number; density: number; haze: number }> = {
  sunrise: { clock: 6.3, density: 0.38, haze: 2 },
  morning: { clock: 8.5, density: 0.3, haze: 1 },
  noon: { clock: 12, density: 0.25, haze: 0 },
  afternoon: { clock: 16, density: 0.3, haze: 1 },
  sunset: { clock: 17.7, density: 0.38, haze: 2.5 },
  dusk: { clock: 18.4, density: 0.4, haze: 2 },
  night: { clock: 0, density: 0.35, haze: 0 },
  overcast: { clock: 13, density: 0.45, haze: 3 },
  misty: { clock: 7.5, density: 0.65, haze: 6 },
};

/** Hardware scaling per quality: Fast draws at 1× pixels, Balanced up to 1.5×, Best up to 2×. */
function pixelScaling(q: Quality): number {
  const dpr = window.devicePixelRatio || 1;
  return 1 / Math.min(dpr, q === 'fast' ? 1 : q === 'balanced' ? 1.5 : 2);
}

function robloxReadme(report: { parts: number; triangles: number; maxTriangles: number } | null, terrain: string[], water: string[] = [], time?: string): string {
  const lines = [
    'B3D Studio → Roblox Studio',
    '==========================',
    '',
    'Everything is already in studs (1 stud = 0.28 m) and lined up around the origin.',
    '',
  ];
  if (report)
    lines.push(
      '1. MODELS (models.glb)',
      `   ${report.parts} parts, ${report.triangles} triangles; largest mesh ${report.maxTriangles} (Roblox limit 20,000).`,
      '   Studio: Home → Import 3D → choose models.glb. In the import window set:',
      '     - Scale Unit: Studs (the default)',
      '     - Insert Using Scene Position: ON   (keeps everything where it was placed)',
      '     - Anchored: ON',
      '   then Import.',
      '',
    );
  if (terrain.length)
    lines.push(
      `${report ? '2' : '1'}. TERRAIN (heightmap + colormap)`,
      '   Studio: Home → Terrain Editor → Import.',
      '   Pick the heightmap and the colormap PNG, then type the size and position below.',
      '   Colours map to Roblox materials: grass → Grass, paths → Ground, cliffs → Rock.',
      '',
      ...terrain.map((l) => '   ' + l),
      '   Click Generate. Trees, rocks and houses in models.glb sit on this ground.',
      '   (Prefer a plain mesh? Import terrain_mesh_optional.glb the same way as models.glb instead.)',
      '',
    );
  if (water.length)
    lines.push(
      'WATER',
      '   Studio: Terrain Editor → Sea Level. Type the position and size, then Create.',
      '   (Roblox fills the box with real terrain water: waves, swimming, reflections.)',
      '',
      ...water.map((l) => '   ' + l),
      '',
    );
  const look = time ? ROBLOX_CLOCK[time] : undefined;
  lines.push(
    'LOOK',
    '   Lighting → Technology: Future. Add an Atmosphere (Insert → Atmosphere) and a Sky.',
    ...(look
      ? [
          `   This scene is set at "${time}". Matching starting values:`,
          `     Lighting.ClockTime = ${look.clock}`,
          `     Atmosphere.Density = ${look.density}   Atmosphere.Haze = ${look.haze}`,
        ]
      : []),
    '   Terrain Editor → Settings → Decoration: ON adds swaying grass.',
  );
  return lines.join('\n') + '\n';
}

/** Blender Principled BSDF extras mapped onto Babylon's PBR material layers. */
function applyPrincipled(mat: PBRMaterial, m: SceneMaterial) {
  const cc = m.clearcoat ?? 0;
  mat.clearCoat.isEnabled = cc > 0;
  if (cc > 0) {
    mat.clearCoat.intensity = cc;
    mat.clearCoat.roughness = m.clearcoatRoughness ?? 0.03;
  }
  const sh = m.sheen ?? 0;
  mat.sheen.isEnabled = sh > 0;
  if (sh > 0) {
    mat.sheen.intensity = sh;
    mat.sheen.color = Color3.FromHexString(m.sheenColor ?? '#ffffff').toLinearSpace();
  }
  const tr = m.transmission ?? 0;
  mat.subSurface.isRefractionEnabled = tr > 0;
  if (tr > 0) {
    mat.subSurface.refractionIntensity = tr;
    mat.subSurface.indexOfRefraction = m.ior ?? 1.5;
    mat.subSurface.tintColor = Color3.FromHexString(m.baseColor).toLinearSpace();
  }
  const ss = m.subsurface ?? 0;
  mat.subSurface.isTranslucencyEnabled = ss > 0;
  if (ss > 0) {
    mat.subSurface.translucencyIntensity = ss;
    mat.subSurface.thicknessTexture = null;
    mat.subSurface.maximumThickness = 1;
    if (!tr) mat.subSurface.tintColor = Color3.FromHexString(m.subsurfaceColor ?? '#ff6040').toLinearSpace();
  }
  const an = m.anisotropy ?? 0;
  mat.anisotropy.isEnabled = an > 0;
  if (an > 0) mat.anisotropy.intensity = an;
}
