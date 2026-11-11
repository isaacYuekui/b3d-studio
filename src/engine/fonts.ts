// Fonts for 3D text, bundled with the app (SIL Open Font License) and parsed on first use.
import { isFontLoaded, registerFont } from '../core/text';
import type { FontId } from '../core/text';

const FILES: Record<FontId, () => Promise<{ default: string }>> = {
  sans: () => import('@fontsource/inter/files/inter-latin-700-normal.woff?url'),
  serif: () => import('@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff?url'),
  display: () => import('@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url'),
};

const pending = new Map<FontId, Promise<void>>();

/** Make a font ready for text commands (downloads ~30 KB once, from our own site). */
export function loadFont(id: FontId): Promise<void> {
  if (isFontLoaded(id)) return Promise.resolve();
  let p = pending.get(id);
  if (!p) {
    p = (async () => {
      const [{ default: url }, opentype] = await Promise.all([FILES[id](), import('opentype.js')]);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't load the ${id} font`);
      registerFont(id, (opentype.default ?? opentype).parse(await res.arrayBuffer()));
    })();
    pending.set(id, p);
    p.catch(() => pending.delete(id));
  }
  return p;
}
