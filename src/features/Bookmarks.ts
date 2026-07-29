import { normalizeView, type GeodeticView } from '../core/Geo';

export interface OpenEarthBookmark {
  readonly id: string;
  readonly name: string;
  readonly view: GeodeticView;
  readonly createdAt: string;
}

export interface BookmarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEFAULT_STORAGE_KEY = 'openearth.bookmarks.v1';
const MAX_BOOKMARKS = 500;
const MAX_IMPORT_CHARACTERS = 2_000_000;

/** Small host-friendly bookmark repository; applications may inject any Storage-compatible backend. */
export class BookmarkStore extends EventTarget {
  constructor(
    private readonly storage: BookmarkStorage = globalThis.localStorage,
    private readonly storageKey = DEFAULT_STORAGE_KEY,
  ) { super(); }

  list(): readonly OpenEarthBookmark[] {
    try {
      const value = this.storage.getItem(this.storageKey);
      if (!value) return [];
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry) => {
        try { return [normalizeBookmark(entry)]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }

  add(name: string, view: GeodeticView): OpenEarthBookmark {
    const safeName = name.trim().slice(0, 120);
    if (!safeName) throw new TypeError('Bookmark name is required');
    const current = this.list();
    if (current.length >= MAX_BOOKMARKS) throw new RangeError(`Bookmark limit (${MAX_BOOKMARKS}) reached`);
    const bookmark: OpenEarthBookmark = {
      id: globalThis.crypto?.randomUUID?.() ?? `bookmark-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: safeName,
      view: normalizeView(view),
      createdAt: new Date().toISOString(),
    };
    this.save([...current, bookmark]);
    return bookmark;
  }

  remove(id: string): boolean {
    const current = this.list();
    const next = current.filter((bookmark) => bookmark.id !== id);
    if (next.length === current.length) return false;
    this.save(next);
    return true;
  }

  clear(): void { this.save([]); }

  export(): string {
    return JSON.stringify({ format: 'openearth-bookmarks-v1', bookmarks: this.list() }, null, 2);
  }

  import(serialized: string, replace = false): number {
    if (serialized.length > MAX_IMPORT_CHARACTERS) throw new RangeError('Bookmark file is too large');
    const parsed = JSON.parse(serialized) as { format?: unknown; bookmarks?: unknown };
    if (parsed.format !== 'openearth-bookmarks-v1' || !Array.isArray(parsed.bookmarks)) {
      throw new TypeError('Unsupported OpenEarth bookmark file');
    }
    if (parsed.bookmarks.length > MAX_BOOKMARKS) throw new RangeError(`Bookmark file exceeds the ${MAX_BOOKMARKS} item limit`);
    const imported = parsed.bookmarks.map(normalizeBookmark);
    const current = replace ? [] : [...this.list()];
    const byId = new Map(current.map((bookmark) => [bookmark.id, bookmark]));
    for (const bookmark of imported) byId.set(bookmark.id, bookmark);
    if (byId.size > MAX_BOOKMARKS) throw new RangeError(`Combined bookmarks exceed the ${MAX_BOOKMARKS} item limit`);
    this.save([...byId.values()]);
    return imported.length;
  }

  private save(bookmarks: readonly OpenEarthBookmark[]): void {
    this.storage.setItem(this.storageKey, JSON.stringify(bookmarks));
    this.dispatchEvent(new Event('change'));
  }
}

function normalizeBookmark(value: unknown): OpenEarthBookmark {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid bookmark');
  const entry = value as Partial<OpenEarthBookmark>;
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.createdAt !== 'string' || !entry.view) {
    throw new TypeError('Invalid bookmark fields');
  }
  const id = entry.id.trim().slice(0, 160);
  const name = entry.name.trim().slice(0, 120);
  if (!id || !name) throw new TypeError('Bookmark id and name are required');
  return {
    id,
    name,
    createdAt: Number.isFinite(Date.parse(entry.createdAt)) ? entry.createdAt : new Date(0).toISOString(),
    view: normalizeView(entry.view),
  };
}
