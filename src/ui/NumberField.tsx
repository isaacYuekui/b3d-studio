import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  value: number;
  step?: number;
  /** Units per pixel when drag-scrubbing. */
  dragRate?: number;
  suffix?: string;
  axis?: 'x' | 'y' | 'z';
  onPreview: (v: number) => void;
  onCommit: (v: number) => void;
  onCancel: () => void;
}

const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return (Object.is(r, -0) ? 0 : r).toString();
};

/** Safe arithmetic for typed values like "2*3" or "1.5+0.25" — no eval. */
export function parseNumberExpr(text: string): number | null {
  const src = text.replace(/[^0-9+\-*/().\s]/g, '');
  if (!src.trim() || src.length > 64) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === ' ') i++;
  };
  const num = (): number => {
    skip();
    if (peek() === '(') {
      i++;
      const v = expr();
      skip();
      if (peek() !== ')') throw new Error();
      i++;
      return v;
    }
    if (peek() === '-') {
      i++;
      return -num();
    }
    const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw new Error();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number => {
    let v = num();
    for (skip(); peek() === '*' || peek() === '/'; skip()) {
      const op = src[i++];
      const r = num();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    for (skip(); peek() === '+' || peek() === '-'; skip()) {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = expr();
    skip();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Blender-style number field: drag horizontally to scrub (live preview, one undo
 * step on release), tap/click to type. Works with mouse, pen and touch.
 */
export function NumberField({ label, value, step = 0.1, dragRate = 0.01, suffix, axis, onPreview, onCommit, onCancel }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fmt(value));
  const [scrub, setScrub] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number; moved: boolean; id: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setText(fmt(value));
  }, [value, editing]);

  const shown = scrub ?? value;

  if (editing) {
    return (
      <label className={`num-field editing${axis ? ` axis-${axis}` : ''}`}>
        <span className="num-label">{label}</span>
        <input
          ref={inputRef}
          className="num-input"
          inputMode="decimal"
          value={text}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') inputRef.current?.blur();
            if (e.key === 'Escape') {
              setText(fmt(value));
              setEditing(false);
            }
          }}
          onBlur={() => {
            const v = parseNumberExpr(text);
            setEditing(false);
            if (v !== null && v !== value) onCommit(v);
          }}
        />
      </label>
    );
  }

  return (
    <div
      className={`num-field${axis ? ` axis-${axis}` : ''}${scrub !== null ? ' scrubbing' : ''}`}
      role="spinbutton"
      aria-label={label}
      aria-valuenow={shown}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setEditing(true);
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          onCommit(value + step);
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          onCommit(value - step);
        }
      }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, start: value, moved: false, id: e.pointerId };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 5) return;
        d.moved = true;
        const rate = e.shiftKey ? dragRate / 10 : dragRate;
        const v = Math.round((d.start + dx * rate) / (step / 10)) * (step / 10);
        setScrub(v);
        onPreview(v);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.id !== e.pointerId) return;
        if (d.moved) {
          const v = scrub ?? value;
          setScrub(null);
          onCommit(v);
        } else {
          setEditing(true);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setScrub(null);
        onCancel();
      }}
    >
      <span className="num-label">{label}</span>
      <span className="num-value">
        {fmt(shown)}
        {suffix}
      </span>
    </div>
  );
}
