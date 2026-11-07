// Babylon.js viewport. Mirrors the store's SceneDoc into Babylon meshes,
// handles picking, gizmos and camera. It never mutates the doc directly:
// user edits made in the viewport (gizmo drags) are dispatched as commands.

// Deep imports keep the bundle much smaller than importing '@babylonjs/core' root.
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { Animation } from '@babylonjs/core/Animations/animation';
import { CubicEase, EasingFunction } from '@babylonjs/core/Animations/easing';
// Side-effect imports required by deep-import usage:
import '@babylonjs/core/Culling/ray'; // scene picking
import '@babylonjs/core/Rendering/outlineRenderer'; // selection outline
import '@babylonjs/core/Animations/animatable'; // camera transitions

import type { Store, AppState, ToolMode } from '../core/store';
import type { SceneObject, SceneDoc, Vec3 } from '../core/types';
import { babylonQuatToEulerDeg, clean, eulerDegToBabylonQuat, fromBabylonVec, toBabylonVec } from './coords';
import { subtree } from '../core/commands';

export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom' | 'persp';

interface Entry {
  mesh: Mesh;
  type: SceneObject['type'];
  color: string;
}

const SELECT_COLOR = new Color3(1, 0.55, 0.1); // Blender-like orange
const BG = new Color4(0.235, 0.235, 0.235, 1);

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
  private resizeObs: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, private store: Store) {
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      powerPreference: 'high-performance',
      adaptToDeviceRatio: false,
    });
    // Cap pixel ratio at 2: retina iPads at 3x would quadruple fill cost for little gain.
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

    const scene = (this.scene = new Scene(this.engine));
    scene.clearColor = BG;
    scene.skipPointerMovePicking = true; // we only pick on tap; saves CPU on mobile

    // Camera — Blender default view, Y-up internally (see coords.ts).
    const cam = (this.camera = new ArcRotateCamera('cam', -0.72, 1.08, 14, Vector3.Zero(), scene));
    cam.minZ = 0.05;
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

    const hemi = new HemisphericLight('hemi', new Vector3(0.3, 1, -0.4), scene);
    hemi.intensity = 0.75;
    hemi.groundColor = new Color3(0.25, 0.25, 0.28);
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.7), scene);
    sun.intensity = 0.55;

    this.buildGrid();

    // Gizmos
    const gm = (this.gizmos = new GizmoManager(scene, 1.6));
    gm.usePointerToAttachGizmos = false; // selection is driven by the store
    gm.clearGizmoOnEmptyPointerEvent = false;
    gm.positionGizmoEnabled = true;
    gm.rotationGizmoEnabled = true;
    gm.scaleGizmoEnabled = true;
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
      const ev = info.event as PointerEvent;
      if (ev.button !== 0) return;
      const id = this.pickAt(scene.pointerX, scene.pointerY);
      this.store.select(id);
    });

    this.engine.runRenderLoop(() => scene.render());
    this.resizeObs = new ResizeObserver(() => this.engine.resize());
    this.resizeObs.observe(canvas);

    this.unsub = store.subscribe(() => this.sync(store.getState()));
    this.sync(store.getState());
  }

  // ---------------------------------------------------------------- scene sync

  private sync(state: AppState) {
    if (state.doc !== this.lastDoc) {
      this.syncDoc(state.doc);
      this.lastDoc = state.doc;
    }
    if (state.selection !== this.lastSel || state.tool !== this.lastTool) {
      this.syncSelection(state.selection, state.tool);
      this.lastSel = state.selection;
      this.lastTool = state.tool;
    }
  }

  private syncDoc(doc: SceneDoc) {
    // remove
    for (const [id, e] of this.entries) {
      if (!doc.objects[id]) {
        e.mesh.material?.dispose();
        e.mesh.dispose();
        this.entries.delete(id);
      }
    }
    // create / update
    for (const id of doc.order) {
      const o = doc.objects[id];
      let e = this.entries.get(id);
      if (e && e.type !== o.type) {
        e.mesh.material?.dispose();
        e.mesh.dispose();
        e = undefined;
      }
      if (!e) {
        e = { mesh: this.createMesh(o), type: o.type, color: '' };
        this.entries.set(id, e);
      }
      if (e.color !== o.color) {
        (e.mesh.material as StandardMaterial).diffuseColor = Color3.FromHexString(o.color);
        e.color = o.color;
      }
      e.mesh.name = o.name;
      e.mesh.setEnabled(o.visible);
      if (!(this.dragging && id === this.store.getState().selection)) this.applyTransform(e.mesh, o);
    }
    // parenting (after all meshes exist)
    for (const id of doc.order) {
      const o = doc.objects[id];
      const mesh = this.entries.get(id)!.mesh;
      const parent = o.parentId ? this.entries.get(o.parentId)?.mesh ?? null : null;
      if (mesh.parent !== parent) mesh.parent = parent;
    }
  }

  private applyTransform(mesh: Mesh, o: SceneObject) {
    const t = o.transform;
    mesh.position.set(...toBabylonVec(t.position));
    mesh.scaling.set(...toBabylonVec(t.scale));
    const [x, y, z, w] = eulerDegToBabylonQuat(t.rotation);
    if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new Quaternion();
    mesh.rotationQuaternion.set(x, y, z, w);
  }

  private createMesh(o: SceneObject): Mesh {
    const s = this.scene;
    let mesh: Mesh;
    // Sizes match Blender defaults: 2m cube, 1m-radius sphere/cylinder, 2m plane.
    switch (o.type) {
      case 'cube':
        mesh = MeshBuilder.CreateBox(o.name, { size: 2 }, s);
        break;
      case 'sphere':
        mesh = MeshBuilder.CreateSphere(o.name, { diameter: 2, segments: 24 }, s);
        break;
      case 'cylinder':
        mesh = MeshBuilder.CreateCylinder(o.name, { diameter: 2, height: 2, tessellation: 32 }, s);
        break;
      case 'plane':
        mesh = MeshBuilder.CreateGround(o.name, { width: 2, height: 2 }, s);
        break;
    }
    const mat = new StandardMaterial(`${o.id}-mat`, s);
    mat.specularColor = new Color3(0.15, 0.15, 0.15);
    mat.backFaceCulling = o.type !== 'plane';
    mesh.material = mat;
    mesh.metadata = { id: o.id };
    mesh.outlineColor = SELECT_COLOR;
    mesh.outlineWidth = 0.035;
    return mesh;
  }

  private syncSelection(sel: string | null, tool: ToolMode) {
    for (const [id, e] of this.entries) e.mesh.renderOutline = id === sel;
    const gm = this.gizmos;
    const mesh = sel ? this.entries.get(sel)?.mesh ?? null : null;
    gm.positionGizmoEnabled = tool === 'move' && !!mesh;
    gm.rotationGizmoEnabled = tool === 'rotate' && !!mesh;
    gm.scaleGizmoEnabled = tool === 'scale' && !!mesh;
    gm.attachToMesh(mesh);
  }

  /** Read the gizmo-modified mesh back into a transform command. */
  private commitGizmo() {
    const sel = this.store.getState().selection;
    const e = sel ? this.entries.get(sel) : undefined;
    if (!sel || !e) return;
    const m = e.mesh;
    const q = m.rotationQuaternion ?? Quaternion.FromEulerVector(m.rotation);
    const r = (v: Vector3): Vec3 => fromBabylonVec([clean(v.x), clean(v.y), clean(v.z)]);
    this.store.dispatch({
      type: 'transform',
      id: sel,
      position: r(m.position),
      rotation: babylonQuatToEulerDeg([q.x, q.y, q.z, q.w]),
      scale: r(m.scaling),
    });
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
    const x = MeshBuilder.CreateLines('axisX', { points: [new Vector3(-size, 0, 0), new Vector3(size, 0, 0)] }, this.scene);
    x.color = new Color3(0.85, 0.27, 0.3);
    // Blender's Y axis is Babylon's Z axis.
    const y = MeshBuilder.CreateLines('axisY', { points: [new Vector3(0, 0, -size), new Vector3(0, 0, size)] }, this.scene);
    y.color = new Color3(0.47, 0.72, 0.18);
    x.isPickable = y.isPickable = false;
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
    const ids = !all && st.selection ? subtree(st.doc, st.selection) : st.doc.order;
    const meshes = ids.map((id) => this.entries.get(id)?.mesh).filter((m): m is Mesh => !!m && m.isEnabled());
    if (!meshes.length) {
      this.animateCamera(this.camera.alpha, this.camera.beta, 14, Vector3.Zero());
      return;
    }
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of meshes) {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, bb.minimumWorld);
      max = Vector3.Maximize(max, bb.maximumWorld);
    }
    const center = min.add(max).scale(0.5);
    const radius = Math.max(max.subtract(min).length() * 1.1, 2);
    this.animateCamera(this.camera.alpha, this.camera.beta, radius, center);
  }

  private animateCamera(alpha: number, beta: number, radius: number, target: Vector3) {
    const cam = this.camera;
    const ease = new CubicEase();
    ease.setEasingMode(EasingFunction.EASINGMODE_EASEINOUT);
    // shortest path for alpha
    let a = alpha;
    while (a - cam.alpha > Math.PI) a -= 2 * Math.PI;
    while (cam.alpha - a > Math.PI) a += 2 * Math.PI;
    const fps = 60;
    const frames = 18;
    Animation.CreateAndStartAnimation('ca', cam, 'alpha', fps, frames, cam.alpha, a, 0, ease);
    Animation.CreateAndStartAnimation('cb', cam, 'beta', fps, frames, cam.beta, beta, 0, ease);
    Animation.CreateAndStartAnimation('cr', cam, 'radius', fps, frames, cam.radius, radius, 0, ease);
    Animation.CreateAndStartAnimation('ct', cam, 'target', fps, frames, cam.target.clone(), target, 0, ease);
  }

  dispose() {
    this.unsub();
    this.resizeObs.disconnect();
    this.gizmos.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }
}
