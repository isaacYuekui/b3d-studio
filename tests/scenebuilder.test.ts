import { describe, expect, it } from 'vitest';
import { applyCommand, CommandError, validateCommand, validateSceneDoc } from '../src/core/commands';
import { parseProject, parseScript, serializeProject } from '../src/core/serialize';
import { Store } from '../src/core/store';
import type { SceneDoc } from '../src/core/types';

const empty = (): SceneDoc => ({ objects: {}, order: [] });
const seq = () => { let n = 0; return () => `id${++n}`; };

describe('scene builder model', () => {
  it('scripts can name objects and reference them as parents', () => {
    const r = applyCommand(empty(), validateCommand({ type: 'batch', commands: [
      { type: 'add', primitive: 'cube', id: 'body', name: 'Body' },
      { type: 'add', primitive: 'cylinder', id: 'wheel_fl', parentId: 'body', params: { segments: 24 } },
    ] }), seq());
    expect(r.doc.objects.wheel_fl.parentId).toBe('body');
    expect(r.doc.objects.wheel_fl.params).toEqual({ segments: 24 });
  });

  it('batches are atomic: one bad command changes nothing', () => {
    const s = new Store(empty(), seq());
    s.dispatch(validateCommand({ type: 'batch', commands: [
      { type: 'add', primitive: 'cube', id: 'a' },
      { type: 'transform', id: 'missing', position: [0, 0, 1] },
    ] }));
    expect(s.getState().doc.order).toEqual([]);
    expect(s.getState().notice).toMatch(/Command 2 \(transform\): Object not found/);
  });

  it('a whole batch is one undo step', () => {
    const s = new Store(empty(), seq());
    s.dispatch(validateCommand({ type: 'batch', commands: [{ type: 'add', primitive: 'cube' }, { type: 'add', primitive: 'torus' }, { type: 'add', primitive: 'light', light: { type: 'sun' } }] }));
    expect(s.getState().doc.order.length).toBe(3);
    s.undo();
    expect(s.getState().doc.order.length).toBe(0);
  });

  it('rejects duplicate ids and nested batches', () => {
    expect(() => applyCommand(applyCommand(empty(), { type: 'add', primitive: 'cube', id: 'x' }).doc, { type: 'add', primitive: 'cube', id: 'x' })).toThrow(/in use/);
    expect(() => validateCommand({ type: 'batch', commands: [{ type: 'batch', commands: [] }] })).toThrow(/nested/);
  });

  it('materials and lights merge partial updates and validate ranges', () => {
    let doc = applyCommand(empty(), { type: 'add', primitive: 'sphere', id: 's', color: '#ff0000' }).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setMaterial', id: 's', material: { metallic: 1, roughness: 0.2 } })).doc;
    expect(doc.objects.s.material).toMatchObject({ baseColor: '#ff0000', metallic: 1, roughness: 0.2 });
    expect(() => validateCommand({ type: 'setMaterial', id: 's', material: { metallic: 2 } })).toThrow(/0..1/);
    doc = applyCommand(doc, { type: 'add', primitive: 'light', id: 'l', light: { type: 'spot', power: 500 } }).doc;
    expect(doc.objects.l.light).toMatchObject({ type: 'spot', power: 500, shadows: true });
    expect(doc.objects.l.name).toBe('Spot Light');
    expect(() => applyCommand(doc, { type: 'setLight', id: 's', light: { power: 1 } })).toThrow(/not a light/);
  });

  it('validates custom mesh data', () => {
    const ok = validateCommand({ type: 'add', primitive: 'mesh', mesh: { vertices: [[0,0,0],[1,0,0],[0,1,0]], faces: [[0,1,2]], smooth: true } });
    expect(ok).toMatchObject({ primitive: 'mesh' });
    expect(() => validateCommand({ type: 'add', primitive: 'mesh', mesh: { vertices: [[0,0,0]], faces: [[0,1,2]] } })).toThrow(/invalid index/);
    expect(() => validateCommand({ type: 'add', primitive: 'mesh' })).toThrow(CommandError);
  });

  it('migrates v1 project files (single colour field) to materials', () => {
    const v1 = { format: 'b3d-studio-project', version: 1, scene: { order: ['a'], objects: { a: { id: 'a', name: 'Cube', type: 'cube', parentId: null, transform: { position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }, color: '#123456', visible: true } } } };
    const doc = parseProject(JSON.stringify(v1));
    expect(doc.objects.a.material.baseColor).toBe('#123456');
    expect(parseProject(serializeProject(doc))).toEqual(doc);
  });

  it('round-trips meshes and lights through the project format', () => {
    const s = new Store(empty(), seq());
    s.dispatch({ type: 'add', primitive: 'mesh', mesh: { vertices: [[0,0,0],[1,0,0],[0,1,0]], faces: [[0,1,2]], smooth: false } });
    s.dispatch({ type: 'add', primitive: 'light', light: { type: 'sun', power: 4 } });
    const doc = s.getState().doc;
    expect(validateSceneDoc(JSON.parse(serializeProject(doc)).scene)).toEqual(doc);
  });
});

describe('scene scripts', () => {
  const script = { format: 'b3d-studio-script', version: 1, title: 'Test', commands: [{ type: 'add', primitive: 'cone' }] };

  it('parses a script, even wrapped in a ``` code fence from chat', () => {
    expect(parseScript(JSON.stringify(script))).toMatchObject({ title: 'Test', count: 1 });
    expect(parseScript('Here you go:\n```json\n' + JSON.stringify(script) + '\n```\nEnjoy').count).toBe(1);
    expect(parseScript(JSON.stringify([{ type: 'add', primitive: 'cube' }])).count).toBe(1);
  });

  it('gives readable errors', () => {
    expect(() => parseScript('{ oops')).toThrow(/valid JSON/);
    expect(() => parseScript(JSON.stringify({ format: 'b3d-studio-project' }))).toThrow(/project file/);
    expect(() => parseScript(JSON.stringify({ ...script, commands: [{ type: 'add', primitive: 'teapot' }] }))).toThrow(/Command 1: primitive/);
  });
});
