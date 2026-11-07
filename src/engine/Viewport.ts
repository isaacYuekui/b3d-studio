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
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { Animation } from '@babylonjs/core/Animations/animation';
import { CubicEase, EasingFunction } from '@babylonjs/core/Animations/easing';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
// Side-effect imports required by deep-import usage:
import '@babylonjs/core/Culling/ray'; // scene picking
import '@babylonjs/core/Rendering/outlineRenderer'; // selection outline
import '@babylonjs/core/Animations/animatable'; // camera transitions
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'; // shadows

import type { Store, AppState, ToolMode, Shading } from '../core/store';
import type { SceneObject, SceneDoc, Vec3 } from '../core/types';
import { isRenderable } from '../core/types';
import { babylonQuatToEulerDeg, clean, eulerDegToBabylonQuat, fromBabylonVec, toBabylonVec } from './coords';
import { buildVertexData } from './geometry';
import { subtree } from '../core/commands';

export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'persp';

interface Entry {
  /** Root node that carries the object's transform and parenting. */
  node: TransformNode;
  /** Pickable visual: the geometry itself, or a helper for lights/empties. */
  pick: AbstractMesh | null;
  /** Rebuild key — when it changes, the node is recreated. */
  key: string;
  material?: PBRMaterial;
  light?: Light;
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
  private helperMat: StandardMaterial;

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, powerPreference: 'high-performance', adaptToDeviceRatio: false });
    // Cap pixel ratio at 2: retina iPads at 3x would quadruple fill cost for little gain.
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

    const scene = (this.scene = new Scene(this.engine));
    scene.clearColor = BG;
    scene.skipPointerMovePicking = true; // we only pick on tap; saves CPU on mobile
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.environmentTexture = this.makeEnvironment();

    // Camera — Blender default view, Y-up internally (see coords.ts).
    const cam = (this.camera = new ArcRotateCamera('cam', -0.72, 1.08, 14, Vector3.Zero(), scene));
    cam.minZ = 0.1;
    cam.maxZ = 2000;
    cam.lowerRadiusLimit = 0.5;
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

    // Gizmos
    const gm = (this.gizmos = new GizmoManager(scene, 1.6));
    gm.usePointerToAttachGizmos = false; // selection is driven by the store
    gm.clearGizmoOnEmptyPointerEvent = false;
    gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = true;
    const g = gm.gizmos;
    if (g.rotationGizmo) g.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = false;
    for (const gizmo of [g.positionGizmo, g.rotationGizmo, g.scaleGizmo]) {
      if (!gizmo) continue;
      gizmo.onDragStartObservable.add(() => (this.dragging = true));
      gizmo.onDragEndObservable.add(() => {
        this.dragging = false;
        this.commitGizmo();
      });
    }
    gm.positionGizmoEnabled = gm.rotationGizmoEnabled = gm.scaleGizmoEnabled = false;

    // Tap to select
    scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERTAP) return;
      if ((info.event as PointerEvent).button !== 0) return;
      this.store.select(this.pickAt(scene.pointerX, scene.pointerY));
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

  private sync(state: AppState) {
    if (state.doc !== this.lastDoc) {
      this.syncDoc(state.doc);
      this.lastDoc = state.doc;
    }
    if (state.shading !== this.lastShading) {
      this.lastShading = state.shading;
      this.applyShading();
    }
    if (state.selection !== this.lastSel || state.tool !== this.lastTool) {
      this.syncSelection(state.selection, state.tool);
      this.lastSel = state.selection;
      this.lastTool = state.tool;
    }
  }

  private keyFor(o: SceneObject): string {
    return `${o.type}|${JSON.stringify(o.params ?? {})}|${o.light?.type ?? ''}`;
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
      // Recreate when the type, shape parameters or mesh data changed.
      if (e && (e.key !== this.keyFor(o) || (o.mesh && e.last?.mesh !== o.mesh))) {
        this.disposeEntry(e);
        e = undefined;
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
      return { node: mesh, pick: mesh, key, material: mat };
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
      return { node, pick: helper, key, light };
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
    return { node, pick: helper, key };
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
        buildVertexData(o.mesh!).applyToMesh(mesh, false);
        if (!o.mesh!.smooth) mesh.convertToFlatShadedMesh();
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
      mat.albedoColor = Color3.FromHexString(m.baseColor).toLinearSpace();
      mat.metallic = m.metallic;
      mat.roughness = m.roughness;
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
    this.scene.environmentIntensity = rendered ? 0.35 : 0.8;
    const casters = [...this.entries.values()].filter((e) => e.material).map((e) => e.node as Mesh);
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

  private syncSelection(sel: string | null, tool: ToolMode) {
    for (const [id, e] of this.entries) {
      const on = id === sel;
      if (e.pick && 'renderOutline' in e.pick && e.pick.getClassName() !== 'LinesMesh') e.pick.renderOutline = on;
      if (e.pick?.getClassName() === 'LinesMesh') (e.pick as LinesMesh).color = on ? SELECT_COLOR : HELPER_COLOR;
    }
    const gm = this.gizmos;
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
    this.store.dispatch({ type: 'transform', id: sel, position: r(n.position), rotation: babylonQuatToEulerDeg([q.x, q.y, q.z, q.w]), scale: r(n.scaling) });
  }

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
  frame(all = false) {
    const st = this.store.getState();
    let ids = !all && st.selection ? subtree(st.doc, st.selection) : st.doc.order;
    // Frame geometry; lights and empties only count when there is nothing else to frame.
    const geo = ids.filter((id) => this.entries.get(id)?.material);
    if (geo.length) ids = geo;
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    let any = false;
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e || !e.node.isEnabled()) continue;
      e.node.computeWorldMatrix(true);
      any = true;
      if (e.material) {
        const bb = (e.node as Mesh).getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, bb.minimumWorld);
        max = Vector3.Maximize(max, bb.maximumWorld);
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
    const radius = Math.max((half / Math.sin(this.camera.fov / 2)) * 0.85, 2);
    this.animateCamera(this.camera.alpha, this.camera.beta, radius, center);
  }

  private animateCamera(alpha: number, beta: number, radius: number, target: Vector3) {
    const cam = this.camera;
    const ease = new CubicEase();
    ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
    let a = alpha;
    while (a - cam.alpha > Math.PI) a -= 2 * Math.PI;
    while (cam.alpha - a > Math.PI) a += 2 * Math.PI;
    const fps = 60;
    const frames = 18;
    // CONSTANT mode: play once and hold. (Mode 0 is RELATIVE, which accumulates offsets.)
    const mode = Animation.ANIMATIONLOOPMODE_CONSTANT;
    this.scene.stopAnimation(cam);
    Animation.CreateAndStartAnimation('ca', cam, 'alpha', fps, frames, cam.alpha, a, mode, ease);
    Animation.CreateAndStartAnimation('cb', cam, 'beta', fps, frames, cam.beta, beta, mode, ease);
    Animation.CreateAndStartAnimation('cr', cam, 'radius', fps, frames, cam.radius, radius, mode, ease);
    Animation.CreateAndStartAnimation('ct', cam, 'target', fps, frames, cam.target.clone(), target, mode, ease);
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
    this.resizeObs.disconnect();
    this.gizmos.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
