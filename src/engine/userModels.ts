// User-imported 3D models (GLB, glTF, or a ZIP of glTF + files, e.g. a Sketchfab download).
//
// Storage: IndexedDB on the device, so a model is imported once and survives reloads.
// The scene refers to it as an ordinary 'model' object with asset id "user-<hash>".
// Project files embed these models so a scene can move between devices.

export const USER_PREFIX = 'user-';
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

export interface UserModelMeta {
  id: string;
  name: string;
  bytes: number;
  /** Bounds in the file's own units, glTF space (Y up): measured once after import. */
  min?: [number, number, number];
  max?: [number, number, number];
  created: string;
}

export const isUserAsset = (id: string | undefined) => !!id && id.startsWith(USER_PREFIX);

// ---------------------------------------------------------------- pure helpers (unit tested)

/**
 * Guess the file's units from its size: artists often export in centimetres or millimetres.
 * Returns the factor that brings the model into metres.
 */
export function guessUnitScale(longestSide: number): number {
  if (!Number.isFinite(longestSide) || longestSide <= 0) return 1;
  if (longestSide > 5000) return 0.001; // millimetres
  // Most imported things (cars, people, props, furniture) are under 20 m; a file
  // that measures 25+ units is far more often centimetres than a 25 m object.
  if (longestSide > 25) return 0.01; // centimetres
  return 1;
}

/** Short, stable content id so importing the same file twice reuses it. */
export async function contentId(bytes: Uint8Array): Promise<string> {
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return USER_PREFIX + hex.slice(0, 16);
}

export const isGlb = (bytes: Uint8Array) => bytes.length > 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46; // "glTF"
const isZip = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"

/** Normalise a path inside a zip/gltf ("./textures\\a.png" -> "textures/a.png"). */
const norm = (p: string) =>
  decodeURIComponent(p)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
    .reduce<string[]>((acc, s) => (s === '..' ? acc.slice(0, -1) : [...acc, s]), [])
    .join('/');

/**
 * Turn whatever the user picked into a single self-contained GLB.
 * - .glb: used as-is
 * - .gltf with embedded data: packed to GLB
 * - .zip containing a .gltf (+ .bin + textures) or a .glb: unpacked and packed to GLB
 */
export async function toGlb(name: string, bytes: Uint8Array): Promise<{ glb: Uint8Array; name: string }> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error(`That file is ${(bytes.byteLength / 1e6).toFixed(0)} MB. The limit is ${MAX_IMPORT_BYTES / 1e6} MB; try a lower-resolution download.`);
  const base = name.replace(/\.[^.]+$/, '');
  if (isGlb(bytes)) return { glb: bytes, name: base };

  let files: Record<string, Uint8Array>;
  if (isZip(bytes)) {
    const { unzipSync } = await import('fflate');
    const raw = unzipSync(bytes, { filter: (f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('/') });
    files = Object.fromEntries(Object.entries(raw).map(([k, v]) => [norm(k), v]));
    const glbName = Object.keys(files).find((k) => k.toLowerCase().endsWith('.glb'));
    if (glbName) return { glb: files[glbName], name: base };
  } else if (/\.gltf$/i.test(name) || (bytes[0] === 0x7b /* { */)) {
    files = { [norm(name)]: bytes };
  } else {
    throw new Error('Unsupported file. Use a .glb, a .gltf, or a .zip that contains a glTF model.');
  }

  const gltfName = Object.keys(files)
    .filter((k) => k.toLowerCase().endsWith('.gltf'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!gltfName) throw new Error('No .gltf or .glb model found inside that ZIP.');
  const dir = gltfName.includes('/') ? gltfName.slice(0, gltfName.lastIndexOf('/') + 1) : '';
  const json = JSON.parse(new TextDecoder().decode(files[gltfName]));

  // Resources referenced by relative path, resolved against the .gltf's folder.
  const resources: Record<string, Uint8Array> = {};
  const refs = [...(json.buffers ?? []), ...(json.images ?? [])].map((r: { uri?: string }) => r.uri).filter((u): u is string => !!u && !u.startsWith('data:'));
  for (const uri of refs) {
    const data = files[norm(dir + uri)] ?? files[norm(uri)];
    if (!data) throw new Error(`The model needs “${uri}”, which is missing. Import the whole ZIP rather than the .gltf alone.`);
    resources[uri] = data;
  }

  const [{ WebIO }, { ALL_EXTENSIONS }] = await Promise.all([import('@gltf-transform/core'), import('@gltf-transform/extensions')]);
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  try {
    const doc = await io.readJSON({ json, resources: resources as Record<string, Uint8Array<ArrayBuffer>> });
    return { glb: await io.writeBinary(doc), name: base };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/draco|meshopt/i.test(msg)) throw new Error('This model uses mesh compression that only works in its GLB form. Download the GLB version instead.');
    throw new Error(`Could not read that model: ${msg}`);
  }
}

// ---------------------------------------------------------------- IndexedDB storage

const DB = 'b3d-studio';
const META = 'userModelMeta';
const DATA = 'userModelData';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META, { keyPath: 'id' });
      req.result.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage unavailable'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = d.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error ?? new Error('Storage error'));
        t.onabort = () => reject(t.error ?? new Error('Storage full or blocked'));
      }),
  );
}

const metaCache = new Map<string, UserModelMeta>();
const urlCache = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const onUserModelsChanged = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export async function listUserModels(): Promise<UserModelMeta[]> {
  try {
    const all = (await tx<UserModelMeta[]>([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [];
    all.forEach((m) => metaCache.set(m.id, m));
    return all.sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}

export const userModelMetaNow = (id: string) => metaCache.get(id) ?? null;

export async function saveUserModel(glb: Uint8Array, name: string): Promise<UserModelMeta> {
  const id = await contentId(glb);
  const existing = metaCache.get(id) ?? (await tx<UserModelMeta>([META], 'readonly', (t) => t.objectStore(META).get(id)));
  if (existing) return existing;
  const meta: UserModelMeta = { id, name: name.slice(0, 80) || 'Imported model', bytes: glb.byteLength, created: new Date().toISOString() };
  await tx([META, DATA], 'readwrite', (t) => {
    t.objectStore(DATA).put(new Blob([glb as BlobPart], { type: 'model/gltf-binary' }), id);
    t.objectStore(META).put(meta);
  });
  metaCache.set(id, meta);
  emit();
  return meta;
}

export async function updateUserModelMeta(id: string, patch: Partial<UserModelMeta>) {
  const cur = metaCache.get(id) ?? (await tx<UserModelMeta>([META], 'readonly', (t) => t.objectStore(META).get(id)));
  if (!cur) return;
  const next = { ...cur, ...patch, id };
  metaCache.set(id, next);
  await tx([META], 'readwrite', (t) => {
    t.objectStore(META).put(next);
  }).catch(() => {});
  emit();
}

export async function deleteUserModel(id: string) {
  await tx([META, DATA], 'readwrite', (t) => {
    t.objectStore(META).delete(id);
    t.objectStore(DATA).delete(id);
  });
  metaCache.delete(id);
  const url = urlCache.get(id);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(id);
  emit();
}

export async function getUserModelBlob(id: string): Promise<Blob | null> {
  try {
    return (await tx<Blob>([DATA], 'readonly', (t) => t.objectStore(DATA).get(id))) ?? null;
  } catch {
    return null;
  }
}

/** Object URL for loading into Babylon; null if this device doesn't have the model. */
export async function userModelUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const blob = await getUserModelBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  if (!metaCache.has(id)) await listUserModels();
  return url;
}

// ---------------------------------------------------------------- project-file embedding

export interface EmbeddedModel {
  name: string;
  /** base64 GLB */
  data: string;
}

const toB64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function collectEmbeddedModels(ids: string[]): Promise<Record<string, EmbeddedModel>> {
  const out: Record<string, EmbeddedModel> = {};
  for (const id of new Set(ids.filter(isUserAsset))) {
    const blob = await getUserModelBlob(id);
    if (blob) out[id] = { name: metaCache.get(id)?.name ?? id, data: await toB64(blob) };
  }
  return out;
}

/** Restore models embedded in a project file. Returns how many were added. */
export async function restoreEmbeddedModels(models: unknown): Promise<number> {
  if (typeof models !== 'object' || models === null) return 0;
  let n = 0;
  for (const [id, m] of Object.entries(models as Record<string, unknown>)) {
    const em = m as Partial<EmbeddedModel>;
    if (!isUserAsset(id) || typeof em?.data !== 'string') continue;
    const bin = atob(em.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!isGlb(bytes)) continue;
    const meta = await saveUserModel(bytes, typeof em.name === 'string' ? em.name : 'Imported model');
    if (meta.id !== id) continue; // content doesn't match its id: ignore
    n++;
  }
  return n;
}
