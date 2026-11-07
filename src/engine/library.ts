// Asset library: the curated CC0 models, HDRI skies and PBR textures that
// scripts/fetch-assets.mjs places in public/library/. Loaded lazily on demand.

export interface CatalogModel {
  id: string;
  name: string;
  categories: string[];
  /** Bounding box in metres, Blender X/Y/Z. */
  size: [number, number, number];
}
export interface CatalogHdri {
  id: string;
  name: string;
  categories: string[];
}
export interface CatalogTexture {
  id: string;
  name: string;
  categories: string[];
  maps: string[];
  tile: number;
}
export interface Catalog {
  models: CatalogModel[];
  hdris: CatalogHdri[];
  textures: CatalogTexture[];
}

/** Relative to the page, so it works on Cloudflare, in previews and in dev. */
export const LIBRARY_BASE = 'library/';

export const modelUrl = (id: string) => `${LIBRARY_BASE}models/${encodeURIComponent(id)}.glb`;
export const hdriUrl = (id: string) => `${LIBRARY_BASE}hdri/${encodeURIComponent(id)}.hdr`;
export const textureUrl = (id: string, map: 'diff' | 'nor' | 'arm' | 'rough') => `${LIBRARY_BASE}textures/${encodeURIComponent(id)}/${map}.webp`;
export const thumbUrl = (id: string) => `${LIBRARY_BASE}thumbs/${encodeURIComponent(id)}.webp`;

let catalogPromise: Promise<Catalog> | null = null;
let catalogSync: Catalog | null = null;

export function loadCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = fetch(`${LIBRARY_BASE}catalog.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`catalog ${r.status}`))))
      .then((c: Catalog) => (catalogSync = c))
      .catch(() => (catalogSync = { models: [], hdris: [], textures: [] }));
  }
  return catalogPromise;
}

/** Catalog if already loaded (for synchronous lookups), else null. */
export const catalogNow = () => catalogSync;
