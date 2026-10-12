// Token logos come from the explorer at whatever size the token's creator uploaded: the registered tokens
// range from 11 KB to 443 KB (1.8 MB for 13) and they are shown at 20-36 px. The first time an icon loads
// we keep a 64 px thumbnail in localStorage, so every later visit paints it instantly from a few KB.
//
// The thumbnail is drawn from the <img> that already loaded, so there is no second download. It needs the
// image to have been fetched with CORS (the explorer sends Access-Control-Allow-Origin: *); when that is
// not the case the drawing throws and we simply keep using the remote URL.

const KEY = 'circleswap.icon-thumbs.v1';
const SIZE = 64;
const MAX_ENTRIES = 48;
const MAX_DATA_URL = 30_000;

interface Thumb { d: string; t: number }
type Store = Record<string, Thumb>;

let memory: Store | null = null;

function load(): Store {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    memory = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    memory = {};
  }
  // drop anything that is not a small raster data URL (the store is ours, but storage is user-writable)
  for (const [url, thumb] of Object.entries(memory)) {
    if (!thumb || typeof thumb.d !== 'string' || !/^data:image\/(webp|png|jpeg);base64,/.test(thumb.d) || thumb.d.length > MAX_DATA_URL) {
      delete memory[url];
    }
  }
  return memory;
}

function save(store: Store): void {
  try {
    const entries = Object.entries(store).sort((a, b) => b[1].t - a[1].t).slice(0, MAX_ENTRIES);
    memory = Object.fromEntries(entries);
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // quota or private mode: thumbnails are an optimisation only
  }
}

/** A previously stored thumbnail for this icon URL, if any. */
export function cachedThumb(url: string): string | undefined {
  return load()[url]?.d;
}

/** Draw an already-loaded <img> to a small canvas and remember it. Returns the data URL, or undefined. */
export function rememberThumb(url: string, image: HTMLImageElement): string | undefined {
  try {
    if (url.startsWith('data:') || !image.naturalWidth || !image.naturalHeight) return undefined;
    const store = load();
    if (store[url]) return store[url].d;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    // cover-crop the centre square
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = (image.naturalWidth - side) / 2;
    const sy = (image.naturalHeight - side) / 2;
    ctx.drawImage(image, sx, sy, side, side, 0, 0, SIZE, SIZE);
    const data = canvas.toDataURL('image/webp', 0.82); // PNG when the browser has no WebP encoder
    if (data.length > MAX_DATA_URL) return undefined;
    store[url] = { d: data, t: Date.now() };
    save(store);
    return data;
  } catch {
    return undefined; // tainted canvas (no CORS) or storage failure
  }
}
