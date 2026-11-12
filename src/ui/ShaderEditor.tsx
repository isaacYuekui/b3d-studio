import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCtx } from './context';
import { NODE_DEFS, NODE_TYPES, ShaderError, connect, defaultGraph, propOf } from '../core/shaderNodes';
import type { NodeType, ShaderGraph, ShaderNode, SocketKind } from '../core/shaderNodes';
import { listUserImages, onUserImagesChanged } from '../engine/userImages';
import type { UserImageMeta } from '../engine/userImages';
import { useCatalog } from './LibraryDialog';
import type { Command } from '../core/commands';

const NODE_W = 200;
const ROW = 24;
const HEAD = 26;
const SOCKET_COLOR: Record<SocketKind, string> = { color: '#c7c729', value: '#a1a1a1', normal: '#6363c7' };

/** Rows of a node in drawing order: outputs, then inputs (with their unconnected values), then settings. */
function layout(n: ShaderNode) {
  const def = NODE_DEFS[n.type];
  const outs = def.outputs.map((s, i) => ({ ...s, y: HEAD + ROW * i + ROW / 2 }));
  const inputs = def.inputs.map((s, i) => ({ ...s, y: HEAD + ROW * (outs.length + i) + ROW / 2 }));
  const settings = def.props.filter((p) => !p.socket);
  const h = HEAD + ROW * (outs.length + inputs.length + settings.length) + 8;
  return { def, outs, inputs, settings, h };
}

const newId = (g: ShaderGraph, type: NodeType) => {
  for (let i = 1; ; i++) if (!g.nodes.some((n) => n.id === `${type}${i}`)) return `${type}${i}`;
};

function useImages(): UserImageMeta[] {
  const [l, setL] = useState<UserImageMeta[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void listUserImages().then((x) => live && setL(x));
    load();
    const off = onUserImagesChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return l;
}

/**
 * Shader Editor (Blender's): the selected object's material as nodes feeding a Principled BSDF.
 * Drag a node by its title, drag from an output dot to an input dot to connect (drag a connected
 * input away to disconnect), drag the background to pan, pinch / wheel to zoom.
 */
export function ShaderEditor() {
  const { store } = useCtx();
  const id = useApp((s) => s.edit?.id ?? s.selection);
  const o = useApp((s) => (id ? s.doc.objects[id] : undefined));
  const [slot, setSlot] = useState(0);
  const [view, setView] = useState({ x: 70, y: 10, k: 0.8 });
  const [sel, setSel] = useState<string | null>(null);
  const [wire, setWire] = useState<{ from: string; out: string; x: number; y: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: 'node' | 'pan'; id?: string; sx: number; sy: number; ox: number; oy: number; base?: ShaderGraph } | null>(null);
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map());
  const images = useImages();
  const catalog = useCatalog();

  const slots = o ? [o.material, ...(o.materialSlots ?? [])] : [];
  const s = Math.min(slot, Math.max(0, slots.length - 1));
  const mat = slots[s];
  const graph = mat?.nodes ?? null;

  const set = (g: ShaderGraph | null, preview = false) => {
    if (!o) return;
    const cmd: Command = { type: 'setMaterial', id: o.id, slot: s, material: { nodes: g } };
    if (preview) store.preview(cmd);
    else store.dispatch(cmd, { select: false });
  };

  // Delete / X removes the selected node (not the output).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel || !graph || (e.target as HTMLElement).closest('input,select,textarea')) return;
      if (!box.current?.matches(':hover') && document.activeElement !== box.current) return;
      if (e.key === 'Delete' || e.key === 'Backspace' || e.key.toLowerCase() === 'x') {
        const n = graph.nodes.find((x) => x.id === sel);
        if (!n || n.type === 'principled') return;
        e.preventDefault();
        e.stopPropagation();
        set({ nodes: graph.nodes.filter((x) => x.id !== sel), links: graph.links.filter((l) => l.from !== sel && l.to !== sel) });
        setSel(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  const links = useMemo(() => {
    if (!graph) return [];
    const at = new Map(graph.nodes.map((n) => [n.id, { n, l: layout(n) }]));
    return graph.links.flatMap((l) => {
      const a = at.get(l.from), b = at.get(l.to);
      if (!a || !b) return [];
      const oy = a.l.outs.find((x) => x.id === l.out)?.y ?? 0;
      const iy = b.l.inputs.find((x) => x.id === l.in)?.y ?? 0;
      return [{ l, x1: a.n.x + NODE_W, y1: a.n.y + oy, x2: b.n.x, y2: b.n.y + iy, kind: NODE_DEFS[a.n.type].outputs.find((x) => x.id === l.out)?.kind ?? 'value' }];
    });
  }, [graph]);

  if (!o || !mat)
    return (
      <div className="shed" data-testid="shader-editor">
        <p className="prop-hint">Shader Editor: select an object.</p>
      </div>
    );

  const header = (
    <div className="uved-bar">
      <span className="graph-title">Shader · {o.name}</span>
      {slots.length > 1 && (
        <select aria-label="Material slot" value={s} onChange={(e) => setSlot(Number(e.target.value))}>
          {slots.map((_, i) => (
            <option key={i} value={i}>
              {i === 0 ? 'Main material' : `Slot ${i + 1}`}
            </option>
          ))}
        </select>
      )}
      {graph ? (
        <>
          <button className="tl-btn" data-testid="shader-add" onClick={() => setAdding(!adding)}>
            + Add
          </button>
          <button className="tl-btn" title="Back to the plain material settings" onClick={() => set(null)}>
            Use Nodes ✓
          </button>
        </>
      ) : (
        <button className="tl-btn" data-testid="shader-use-nodes" onClick={() => set(defaultGraph(mat))}>
          Use Nodes
        </button>
      )}
      {err && <span className="shed-err">{err}</span>}
    </div>
  );
  if (!graph)
    return (
      <div className="shed" data-testid="shader-editor">
        {header}
        <p className="prop-hint">Press Use Nodes to build this material from nodes (textures, mixes, colour ramps, bump) feeding a Principled BSDF, like Blender's Shader Editor.</p>
      </div>
    );

  const addNode = (type: NodeType) => {
    const nid = newId(graph, type);
    // New nodes stack in columns to the left of the Principled BSDF, under the ones already there.
    const out = graph.nodes.find((n) => n.type === 'principled')!;
    const col = graph.nodes.filter((n) => n.type !== 'principled').length % 2;
    const x = out.x - (NODE_W + 50) * (col + 1);
    const below = graph.nodes.filter((n) => Math.abs(n.x - x) < NODE_W).map((n) => n.y + layout(n).h);
    const y = below.length ? Math.max(...below) + 16 : out.y;
    set({ ...graph, nodes: [...graph.nodes, { id: nid, type, x, y, props: {} }] });
    setSel(nid);
    setAdding(false);
  };

  const setProp = (n: ShaderNode, k: string, v: number | string, preview = false) =>
    set({ ...graph, nodes: graph.nodes.map((x) => (x.id === n.id ? { ...x, props: { ...x.props, [k]: v } } : x)) }, preview);

  const onPointerDown = (e: React.PointerEvent) => {
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const t = e.target as HTMLElement;
    const sock = t.closest('[data-socket]') as HTMLElement | null;
    const head = t.closest('[data-node-head]') as HTMLElement | null;
    if (t.closest('input,select,button,label')) return;
    box.current?.setPointerCapture?.(e.pointerId);
    if (sock) {
      const [nid, dir, sid] = sock.dataset.socket!.split(':');
      const p = local(e);
      if (dir === 'out') setWire({ from: nid, out: sid, x: p.x, y: p.y });
      else {
        // Pick up a connected input's link to move it elsewhere (or drop it to disconnect).
        const l = graph.links.find((x) => x.to === nid && x.in === sid);
        if (l) {
          set({ ...graph, links: graph.links.filter((x) => x !== l) }, true);
          setWire({ from: l.from, out: l.out, x: p.x, y: p.y });
        }
      }
      return;
    }
    if (head) {
      const nid = head.dataset.nodeHead!;
      setSel(nid);
      const n = graph.nodes.find((x) => x.id === nid)!;
      drag.current = { kind: 'node', id: nid, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, base: graph };
      return;
    }
    if (!t.closest('.shed-node')) setSel(null);
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pinch.current.get(e.pointerId);
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.size === 2 && prev) {
      // Two fingers: zoom about their middle.
      const [a, b] = [...pinch.current.values()];
      const other = [...pinch.current.entries()].find(([k]) => k !== e.pointerId)![1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d0 > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d1 / d0);
      drag.current = null;
      return;
    }
    if (wire) {
      const p = local(e);
      setWire({ ...wire, x: p.x, y: p.y });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.kind === 'pan') setView({ ...view, x: d.ox + dx, y: d.oy + dy });
    else set({ ...d.base!, nodes: d.base!.nodes.map((n) => (n.id === d.id ? { ...n, x: Math.round(d.ox + dx / view.k), y: Math.round(d.oy + dy / view.k) } : n)) }, true);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pinch.current.delete(e.pointerId);
    if (wire) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-socket]') as HTMLElement | null;
      const [nid, dir, sid] = el?.dataset.socket?.split(':') ?? [];
      if (nid && dir === 'in') {
        store.commitPreview();
        const now = (s ? store.getState().doc.objects[o.id].materialSlots![s - 1] : store.getState().doc.objects[o.id].material).nodes!;
        try {
          set(connect(now, { from: wire.from, out: wire.out, to: nid, in: sid }));
          setErr(null);
        } catch (er) {
          setErr(er instanceof ShaderError ? er.message : String(er));
        }
      } else store.commitPreview();
      setWire(null);
      return;
    }
    if (drag.current?.kind === 'node') store.commitPreview();
    drag.current = null;
  };

  const zoomAt = (cx: number, cy: number, f: number) => {
    const r = box.current!.getBoundingClientRect();
    const k = Math.max(0.35, Math.min(2, view.k * f));
    const px = cx - r.left, py = cy - r.top;
    setView({ k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k });
  };

  const field = (n: ShaderNode, p: (typeof NODE_DEFS)[NodeType]['props'][number]) => {
    const v = propOf(n, p.id);
    if (p.kind === 'color')
      return <input type="color" aria-label={`${NODE_DEFS[n.type].label} ${p.label}`} value={String(v)} onChange={(e) => setProp(n, p.id, e.target.value, true)} onBlur={() => store.commitPreview()} />;
    if (p.kind === 'select')
      return (
        <select aria-label={`${NODE_DEFS[n.type].label} ${p.label}`} value={String(v)} onChange={(e) => setProp(n, p.id, e.target.value)}>
          {p.options!.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      );
    if (p.kind === 'image')
      return (
        <select aria-label="Image" value={String(v)} onChange={(e) => setProp(n, p.id, e.target.value)}>
          <option value="">(choose)</option>
          {images.length > 0 && (
            <optgroup label="Your images">
              {images.map((im) => (
                <option key={im.id} value={im.id}>
                  {im.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Library">
            {catalog?.textures.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
        </select>
      );
    return (
      <input
        type="number"
        aria-label={`${NODE_DEFS[n.type].label} ${p.label}`}
        min={p.min}
        max={p.max}
        step={p.step}
        defaultValue={Number(v)}
        key={`${n.id}.${p.id}.${String(v)}`}
        onBlur={(e) => {
          const x = Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, Number(e.target.value)));
          if (Number.isFinite(x) && x !== Number(v)) setProp(n, p.id, x);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    );
  };

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };
  const wireFrom = wire && graph.nodes.find((n) => n.id === wire.from);
  const wireStart = wireFrom && { x: wireFrom.x + NODE_W, y: wireFrom.y + (layout(wireFrom).outs.find((x) => x.id === wire!.out)?.y ?? 0) };

  return (
    <div className="shed" data-testid="shader-editor">
      {header}
      {adding && (
        <div className="shed-add" role="menu">
          {(['Input', 'Texture', 'Color', 'Converter', 'Vector'] as const).map((grp) => (
            <div key={grp} className="shed-add-group">
              <b>{grp}</b>
              {NODE_TYPES.filter((t) => NODE_DEFS[t].group === grp).map((t) => (
                <button key={t} className="tl-btn" data-add-node={t} onClick={() => addNode(t)}>
                  {NODE_DEFS[t].label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div
        className="shed-canvas"
        ref={box}
        tabIndex={0}
        data-testid="shader-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(e) => zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1)}
      >
        <div className="shed-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="shed-links" width={4000} height={3000} style={{ left: -1000, top: -1000 }} viewBox="-1000 -1000 4000 3000">
            {links.map(({ l, x1, y1, x2, y2, kind }) => (
              <path key={`${l.from}.${l.out}>${l.to}.${l.in}`} d={curve(x1, y1, x2, y2)} stroke={SOCKET_COLOR[kind]} strokeWidth={2.5} fill="none" data-link={`${l.from}.${l.out}>${l.to}.${l.in}`} />
            ))}
            {wire && wireStart && <path d={curve(wireStart.x, wireStart.y, wire.x, wire.y)} stroke="#fff" strokeDasharray="6 4" strokeWidth={2} fill="none" />}
          </svg>
          {graph.nodes.map((n) => {
            const { def, outs, inputs, settings, h } = layout(n);
            const linked = (sid: string) => graph.links.some((l) => l.to === n.id && l.in === sid);
            return (
              <div key={n.id} className={`shed-node g-${def.group.toLowerCase()}${sel === n.id ? ' sel' : ''}`} style={{ left: n.x, top: n.y, width: NODE_W, height: h }} data-node={n.id}>
                <div className="shed-head" data-node-head={n.id}>
                  {def.label}
                </div>
                {outs.map((so) => (
                  <div key={so.id} className="shed-row out" style={{ top: so.y - ROW / 2 }}>
                    <span>{so.label}</span>
                    <i className="shed-sock" style={{ background: SOCKET_COLOR[so.kind] }} data-socket={`${n.id}:out:${so.id}`} />
                  </div>
                ))}
                {inputs.map((si) => {
                  const p = def.props.find((x) => x.socket === si.id);
                  return (
                    <div key={si.id} className="shed-row in" style={{ top: si.y - ROW / 2 }}>
                      <i className="shed-sock" style={{ background: SOCKET_COLOR[si.kind] }} data-socket={`${n.id}:in:${si.id}`} />
                      <span>{si.label}</span>
                      {p && !linked(si.id) && field(n, p)}
                    </div>
                  );
                })}
                {settings.map((p, i) => (
                  <div key={p.id} className="shed-row set" style={{ top: HEAD + ROW * (outs.length + inputs.length + i) }}>
                    <span>{p.label}</span>
                    {field(n, p)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <p className="prop-hint">Drag from a dot on the right of a node to a dot on the left of another to connect. Select a node and press X (or Delete) to remove it. Pinch or scroll to zoom.</p>
    </div>
  );
}
