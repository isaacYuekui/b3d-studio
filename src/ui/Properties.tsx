import { useState } from 'react';
import type { ReactNode } from 'react';
import { useApp, useCtx } from './context';
import { NumberField } from './NumberField';
import { Icon } from './icons';
import { subtree } from '../core/commands';
import type { Command } from '../core/commands';
import type { Vec3 } from '../core/types';
import { runAction } from './actions';

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
  const o = sel ? doc.objects[sel] : null;

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
      </div>
    );
  }

  const vecField = (key: 'position' | 'rotation' | 'scale', label: string, opts: { step: number; rate: number; suffix?: string }) => (
    <Section title={label}>
      <div className="vec3">
        {AXES.map((ax, i) => {
          const make = (v: number): Command => {
            const next = [...o.transform[key]] as Vec3;
            next[i] = v;
            return { type: 'transform', id: o.id, [key]: next };
          };
          return (
            <NumberField
              key={ax}
              axis={ax}
              label={ax.toUpperCase()}
              value={o.transform[key][i]}
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

      {vecField('position', 'Location', { step: 0.1, rate: 0.01, suffix: ' m' })}
      {vecField('rotation', 'Rotation', { step: 1, rate: 0.5, suffix: '°' })}
      {vecField('scale', 'Scale', { step: 0.1, rate: 0.005 })}

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

      <Section title="Viewport Display">
        <label className="prop-row">
          <span>Colour</span>
          <input
            type="color"
            aria-label="Object colour"
            value={o.color}
            onChange={(e) => store.preview({ type: 'setColor', id: o.id, color: e.target.value })}
            onBlur={() => store.commitPreview()}
          />
        </label>
        <label className="prop-row">
          <span>Visible</span>
          <input type="checkbox" checked={o.visible} onChange={(e) => store.dispatch({ type: 'setVisible', id: o.id, visible: e.target.checked }, { select: false })} />
        </label>
        <div className="prop-row"><span>Type</span><b style={{ textTransform: 'capitalize' }}>{o.type}</b></div>
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
