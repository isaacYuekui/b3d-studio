// Your own images as textures (Blender: Image Texture node with an opened image). Photos are
// shrunk to at most 2048 px, stored on the device (IndexedDB) and referred to from materials as
// texture "img-<hash>". Project files carry them inside, like imported models.

export const IMAGE_PREFIX = 'img-';
const MAX_SIDE = 2048;
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export interface UserImageMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  created: string;
}

export const isUserImage = (id: string | null | undefined) => !!id && id.startsWith(IMAGE_PREFIX);

const DB = 'b3d-studio-images';
const META = 'meta';
const DATA = 'data';

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

const metaCache = new Map<string, UserImageMeta>();
const urlCache = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const onUserImagesChanged = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export async function listUserImages(): Promise<UserImageMeta[]> {
  try {
    const all = (await tx<UserImageMeta[]>([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [];
    all.forEach((m) => metaCache.set(m.id, m));
    return all.sort((a, b) => b.created.localeCompare(a.created));
  } catch {
    return [];
  }
}

export const userImageMetaNow = (id: string) => metaCache.get(id) ?? null;

async function hashId(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return IMAGE_PREFIX + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Shrink to at most 2048 px and re-encode (PNG when it has see-through parts, else JPEG). */
async function prepare(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * k)), height = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  g.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  const px = g.getImageData(0, 0, width, height).data;
  let alpha = false;
  for (let i = 3; i < px.length; i += 4 * 97) if (px[i] < 250) {
    alpha = true;
    break;
  }
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not read that image'))), alpha ? 'image/png' : 'image/jpeg', 0.9));
  return { blob, width, height };
}

/** Store an image (from a file the user picked); the same picture twice is stored once. */
export async function saveUserImage(file: Blob, name: string): Promise<UserImageMeta> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('That image is too big (40 MB max)');
  const { blob, width, height } = await prepare(file);
  const id = await hashId(await blob.arrayBuffer());
  const meta: UserImageMeta = metaCache.get(id) ?? { id, name: name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Image', width, height, created: new Date().toISOString() };
  await tx([META, DATA], 'readwrite', (t) => {
    t.objectStore(DATA).put(blob, id);
    t.objectStore(META).put(meta);
  });
  metaCache.set(id, meta);
  emit();
  return meta;
}

/** Restore an image with a known id (from a project file); returns false if the data doesn't match. */
async function saveWithId(id: string, blob: Blob, name: string): Promise<boolean> {
  if ((await hashId(await blob.arrayBuffer())) !== id) return false;
  const bmp = await createImageBitmap(blob);
  const meta: UserImageMeta = { id, name, width: bmp.width, height: bmp.height, created: new Date().toISOString() };
  bmp.close?.();
  await tx([META, DATA], 'readwrite', (t) => {
    t.objectStore(DATA).put(blob, id);
    t.objectStore(META).put(meta);
  });
  metaCache.set(id, meta);
  emit();
  return true;
}

export async function deleteUserImage(id: string) {
  await tx([META, DATA], 'readwrite', (t) => {
    t.objectStore(META).delete(id);
    t.objectStore(DATA).delete(id);
  });
  metaCache.delete(id);
  const u = urlCache.get(id);
  if (u) URL.revokeObjectURL(u);
  urlCache.delete(id);
  emit();
}

async function getBlob(id: string): Promise<Blob | null> {
  try {
    return (await tx<Blob>([DATA], 'readonly', (t) => t.objectStore(DATA).get(id))) ?? null;
  } catch {
    return null;
  }
}

/** Object URL for a stored image; null when this device doesn't have it. */
export async function userImageUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id);
  if (hit) return hit;
  const blob = await getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

// ---------------------------------------------------------------- project-file embedding

export interface EmbeddedImage {
  name: string;
  type: string;
  /** base64 */
  data: string;
}

export async function collectEmbeddedImages(ids: string[]): Promise<Record<string, EmbeddedImage>> {
  const out: Record<string, EmbeddedImage> = {};
  for (const id of new Set(ids.filter(isUserImage))) {
    const blob = await getBlob(id);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out[id] = { name: metaCache.get(id)?.name ?? 'Image', type: blob.type, data: btoa(s) };
  }
  return out;
}

export async function restoreEmbeddedImages(images: unknown): Promise<number> {
  if (typeof images !== 'object' || images === null) return 0;
  let n = 0;
  for (const [id, raw] of Object.entries(images as Record<string, unknown>)) {
    const im = raw as Partial<EmbeddedImage>;
    if (!isUserImage(id) || typeof im?.data !== 'string' || !/^image\/(png|jpeg|webp)$/.test(im.type ?? '')) continue;
    const bin = atob(im.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (await saveWithId(id, new Blob([bytes], { type: im.type }), typeof im.name === 'string' ? im.name.slice(0, 60) : 'Image')) n++;
  }
  return n;
}

/** Every user image a scene's materials use. */
export function imagesInDoc(doc: { objects: Record<string, { material: { texture: string | null }; materialSlots?: { texture: string | null }[] }> }): string[] {
  const out = new Set<string>();
  for (const o of Object.values(doc.objects)) for (const m of [o.material, ...(o.materialSlots ?? [])]) if (isUserImage(m.texture)) out.add(m.texture!);
  return [...out];
}
