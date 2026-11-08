import { describe, expect, it } from 'vitest';
import { Store } from '../src/core/store';
import { adjustLastOp, enterEdit, exitEdit, getLastOp, runMeshOp, selectCmd, setSelectMode, setSubdivision } from '../src/ui/editing';
import { EMPTY_SEL, flush } from '../src/core/mesh/select';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/serialize';

let n = 0;
const ids = () => `t${n++}`;

function cubeInEdit() {
  const s = new Store(undefined, ids);
  expect(enterEdit(s)).toBe(true);
  return s;
}
const objOf = (s: Store) => s.getState().doc.objects[s.getState().edit?.id ?? s.getState().selection!];

describe('edit mode controller', () => {
  it('Tab converts a primitive to an editable mesh with everything selected', () => {
    const s = cubeInEdit();
    const o = objOf(s);
    expect(o.type).toBe('mesh');
    expect(o.mesh!.vertices.length).toBe(8);
    expect(s.getState().edit!.sel.verts.length).toBe(8);
    exitEdit(s);
    expect(s.getState().edit).toBe(null);
  });

  it('extrude is one undo step and undo restores the selection', () => {
    const s = cubeInEdit();
    const mesh = objOf(s).mesh!;
    const top = mesh.faces.findIndex((f) => f.every((v) => mesh.vertices[v][2] > 0.9));
    setSelectMode(s, 'face');
    s.setEdit({ ...s.getState().edit!, sel: flush(mesh, 'face', { ...EMPTY_SEL, faces: [top] }) });
    expect(runMeshOp(s, 'extrude')).toBe(true);
    expect(objOf(s).mesh!.faces.length).toBe(10);
    s.undo();
    expect(objOf(s).mesh!.faces.length).toBe(6);
    expect(s.getState().edit!.sel.faces).toEqual([top]);
    expect(s.getState().edit).not.toBe(null);
  });

  it('adjust last operation re-runs from the start without extra undo steps', () => {
    const s = cubeInEdit();
    selectCmd(s, 'all');
    setSelectMode(s, 'edge');
    runMeshOp(s, 'bevel');
    const faces1 = objOf(s).mesh!.faces.length;
    adjustLastOp(s, { segments: 3 });
    expect(getLastOp()!.params.segments).toBe(3);
    expect(objOf(s).mesh!.faces.length).toBeGreaterThan(faces1);
    s.undo();
    expect(objOf(s).mesh!.faces.length).toBe(6);
  });

  it('operators report a friendly notice instead of throwing', () => {
    const s = cubeInEdit();
    selectCmd(s, 'none');
    expect(runMeshOp(s, 'loopcut')).toBe(false);
    expect(s.getState().notice).toMatch(/Select an edge/);
  });

  it('selecting another object leaves edit mode', () => {
    const s = cubeInEdit();
    const [other] = s.dispatch({ type: 'add', primitive: 'sphere' }, { select: false });
    s.select(other);
    expect(s.getState().edit).toBe(null);
  });

  it('subdivision shortcut adds the modifier and shades smooth', () => {
    const s = new Store(undefined, ids);
    setSubdivision(s, 2);
    const o = objOf(s);
    expect(o.type).toBe('mesh');
    expect(o.modifiers?.subdivision?.levels).toBe(2);
    expect(o.mesh!.smooth).toBe(true);
  });

  it('mesh commands validate and survive a project round trip', () => {
    const s = new Store(undefined, ids);
    const id = s.getState().selection!;
    s.dispatch(validateCommand({ type: 'setModifiers', id, modifiers: { mirror: { x: true }, subdivision: { levels: 1 } } }));
    const doc = parseProject(serializeProject(s.getState().doc));
    expect(doc.objects[id].modifiers).toEqual({ mirror: { x: true, y: false, z: false }, subdivision: { levels: 1 } });
    expect(() => validateCommand({ type: 'setModifiers', id, modifiers: { subdivision: { levels: 9 } } })).toThrow();
    expect(() => validateCommand({ type: 'setMesh', id, mesh: { vertices: [[0, 0, 0]], faces: [[0, 1, 2]] } })).toThrow();
    const applied = applyCommand(doc, { type: 'applyModifiers', id }).doc;
    expect(applied.objects[id].modifiers).toBeUndefined();
    expect(applied.objects[id].mesh!.faces.length).toBe(48); // cube + mirrored copy, subdivided once
    expect(() => validateSceneDoc(JSON.parse(JSON.stringify(applied)))).not.toThrow();
  });
});
