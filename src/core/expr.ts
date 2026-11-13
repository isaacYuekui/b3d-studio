// A small, safe maths-expression language for drivers (Blender's "Scripted Expression", minus
// Python). It is parsed and evaluated here — never handed to eval / Function — so a driver can
// only do arithmetic on numbers: + − × ÷ % ^, comparisons, `a if c else b`-style `c ? a : b`,
// parentheses, named variables and the functions below.

const FUNCS: Record<string, { n: [number, number]; f: (...a: number[]) => number }> = {
  sin: { n: [1, 1], f: Math.sin },
  cos: { n: [1, 1], f: Math.cos },
  tan: { n: [1, 1], f: Math.tan },
  asin: { n: [1, 1], f: Math.asin },
  acos: { n: [1, 1], f: Math.acos },
  atan: { n: [1, 1], f: Math.atan },
  atan2: { n: [2, 2], f: Math.atan2 },
  sqrt: { n: [1, 1], f: Math.sqrt },
  abs: { n: [1, 1], f: Math.abs },
  floor: { n: [1, 1], f: Math.floor },
  ceil: { n: [1, 1], f: Math.ceil },
  round: { n: [1, 1], f: Math.round },
  exp: { n: [1, 1], f: Math.exp },
  log: { n: [1, 2], f: (x, b) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b)) },
  pow: { n: [2, 2], f: Math.pow },
  min: { n: [1, 8], f: Math.min },
  max: { n: [1, 8], f: Math.max },
  clamp: { n: [1, 3], f: (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x)) },
  lerp: { n: [3, 3], f: (a, b, t) => a + (b - a) * t },
  radians: { n: [1, 1], f: (d) => (d * Math.PI) / 180 },
  degrees: { n: [1, 1], f: (r) => (r * 180) / Math.PI },
  sign: { n: [1, 1], f: Math.sign },
  noise: { n: [1, 1], f: (x) => smoothNoise(x) },
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

export const EXPR_FUNCTIONS = Object.keys(FUNCS);
export const MAX_EXPR = 240;

/** Smooth 1-D value noise in −1..1 (for wobble: `noise(frame/10)`). */
function smoothNoise(x: number): number {
  const h = (i: number) => {
    const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(x), f = x - i;
  const t = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * t;
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'neg'; a: Node }
  | { k: 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'if'; c: Node; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

export class ExprError extends Error {}

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: parseFloat(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['**', '<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two === '**' ? '^' : two });
      i += 2;
      continue;
    }
    if ('+-*/%^()<>,?:!'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected “${c}”`);
  }
  return out;
}

/** Parse an expression (throws ExprError with a readable message). */
export function parseExpr(src: string): Node {
  if (src.length > MAX_EXPR) throw new ExprError(`Keep expressions under ${MAX_EXPR} characters`);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const eat = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected “${v}”`);
    p++;
  };
  let depth = 0;
  const guard = <T>(f: () => T): T => {
    if (++depth > 64) throw new ExprError('Expression nests too deeply');
    try {
      return f();
    } finally {
      depth--;
    }
  };
  const ternary = (): Node =>
    guard(() => {
      const c = or();
      if (isOp('?')) {
        p++;
        const a = ternary();
        eat(':');
        const b = ternary();
        return { k: 'if', c, a, b };
      }
      return c;
    });
  const binLevel = (ops: string[], next: () => Node) => (): Node => {
    let a = next();
    while (peek()?.t === 'op' && ops.includes(peek()!.v as string)) {
      const op = (toks[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  };
  const unary = (): Node =>
    guard(() => {
      if (isOp('-')) return p++, { k: 'neg', a: unary() };
      if (isOp('+')) return p++, unary();
      if (isOp('!')) return p++, { k: 'not', a: unary() };
      return power();
    });
  const power = (): Node => {
    const a = atom();
    if (isOp('^')) {
      p++;
      return { k: 'bin', op: '^', a, b: unary() };
    }
    return a;
  };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new ExprError('Expression ends too early');
    if (t.t === 'num') return p++, { k: 'num', v: t.v };
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        const fn = FUNCS[t.v];
        if (!fn) throw new ExprError(`Unknown function ${t.v}()`);
        p++;
        const args: Node[] = [];
        if (!isOp(')'))
          for (;;) {
            args.push(ternary());
            if (isOp(',')) p++;
            else break;
          }
        eat(')');
        if (args.length < fn.n[0] || args.length > fn.n[1]) throw new ExprError(`${t.v}() takes ${fn.n[0] === fn.n[1] ? fn.n[0] : `${fn.n[0]}–${fn.n[1]}`} value${fn.n[1] > 1 ? 's' : ''}`);
        return { k: 'call', name: t.v, args };
      }
      if (t.v in CONSTS) return { k: 'num', v: CONSTS[t.v] };
      return { k: 'var', name: t.v };
    }
    if (t.v === '(') {
      p++;
      const e = ternary();
      eat(')');
      return e;
    }
    throw new ExprError(`Unexpected “${t.v}”`);
  };
  const mul = binLevel(['*', '/', '%'], unary);
  const add = binLevel(['+', '-'], mul);
  const cmp = binLevel(['<', '>', '<=', '>=', '==', '!='], add);
  const and = binLevel(['&&'], cmp);
  const or = binLevel(['||'], and);
  if (!toks.length) throw new ExprError('Empty expression');
  const e = ternary();
  if (p < toks.length) throw new ExprError(`Unexpected “${(toks[p] as { v: unknown }).v}”`);
  return e;
}

/** Variable names an expression uses. */
export function exprVariables(n: Node, out = new Set<string>()): Set<string> {
  if (n.k === 'var') out.add(n.name);
  else if (n.k === 'neg' || n.k === 'not') exprVariables(n.a, out);
  else if (n.k === 'bin') exprVariables(n.a, out), exprVariables(n.b, out);
  else if (n.k === 'if') exprVariables(n.c, out), exprVariables(n.a, out), exprVariables(n.b, out);
  else if (n.k === 'call') n.args.forEach((a) => exprVariables(a, out));
  return out;
}

export function evalExpr(n: Node, vars: Record<string, number>): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'var':
      if (!(n.name in vars)) throw new ExprError(`Unknown name ${n.name}`);
      return vars[n.name];
    case 'neg':
      return -evalExpr(n.a, vars);
    case 'not':
      return evalExpr(n.a, vars) ? 0 : 1;
    case 'if':
      return evalExpr(n.c, vars) ? evalExpr(n.a, vars) : evalExpr(n.b, vars);
    case 'call':
      return FUNCS[n.name].f(...n.args.map((a) => evalExpr(a, vars)));
    case 'bin': {
      const a = evalExpr(n.a, vars), b = evalExpr(n.b, vars);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '%': return b === 0 ? 0 : ((a % b) + b) % b;
        case '^': return Math.pow(a, b);
        case '<': return +(a < b);
        case '>': return +(a > b);
        case '<=': return +(a <= b);
        case '>=': return +(a >= b);
        case '==': return +(a === b);
        case '!=': return +(a !== b);
        case '&&': return +(!!a && !!b);
        case '||': return +(!!a || !!b);
      }
    }
  }
  throw new ExprError('Bad expression');
}

const cache = new Map<string, Node | ExprError>();

/** Evaluate with a parse cache; bad expressions or results give null. */
export function runExpr(src: string, vars: Record<string, number>): number | null {
  let n = cache.get(src);
  if (!n) {
    try {
      n = parseExpr(src);
    } catch (e) {
      n = e instanceof ExprError ? e : new ExprError(String(e));
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, n);
  }
  if (n instanceof ExprError) return null;
  try {
    const v = evalExpr(n, vars);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** A readable problem with an expression and its variables, or null. */
export function exprProblem(src: string, names: string[]): string | null {
  try {
    const n = parseExpr(src);
    const known = new Set([...names, 'frame', 'time']);
    for (const v of exprVariables(n)) if (!known.has(v)) return `Unknown name ${v} (add it as a variable)`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
