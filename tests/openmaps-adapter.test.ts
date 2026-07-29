import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CachedNetworkXyzProvider,
  createOpenEarthRegionProvider,
  LegacyOpenMapsIndexedDbStore,
  OpenMapsRasterProvider,
  PersistentTileCache,
  validateOpenEarthRegionManifest,
  type OpenEarthRegionManifestV1,
  type OpenMapsRasterTileStore,
} from "../src/adapters/OpenMaps";
import type { XyzTileProvider } from "../src/xr/XyzTileProvider";

describe("OpenMaps raster provider", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => bitmap(await blob.text())),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("validates metadata, snapshots layer priority, and transfers decoded tiles", async () => {
    const layerIds = ["streets", "satellite"];
    const getRasterTile = vi.fn(async () => new Blob(["tile"]));
    const provider = new OpenMapsRasterProvider(
      { getRasterTile },
      {
        id: "denmark-pack",
        layerIds,
        attribution: "OpenMaps test data",
        minZoom: 0,
        maxZoom: 18,
      },
    );
    layerIds.reverse();

    const result = await provider.loadTile(2, 1, 1);

    expect(getRasterTile).toHaveBeenCalledWith(
      2,
      1,
      1,
      ["streets", "satellite"],
      undefined,
    );
    expect(result).toMatchObject({
      status: "loaded",
      ownership: "transfer",
      image: { label: "tile" },
    });
    expect(
      () =>
        new OpenMapsRasterProvider(
          { getRasterTile },
          {
            id: "",
            layerIds: ["streets"],
            attribution: "",
            minZoom: 0,
            maxZoom: 18,
          },
        ),
    ).toThrow(/non-empty id/);
  });

  it("reports stable misses and does not decode after cancellation", async () => {
    const missing = new OpenMapsRasterProvider(
      { getRasterTile: async () => null },
      metadata(),
    );
    await expect(missing.loadTile(1, 0, 0)).resolves.toEqual({
      status: "missing",
      retryAfterMs: Number.POSITIVE_INFINITY,
    });

    const controller = new AbortController();
    const cancelled = new OpenMapsRasterProvider(
      {
        getRasterTile: async () => {
          controller.abort();
          return new Blob(["late"]);
        },
      },
      metadata(),
    );
    await expect(
      cancelled.loadTile(1, 0, 0, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe("legacy OpenMaps IndexedDB bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads compound XYZ/layer keys in priority order and decodes imported base64", async () => {
    const indexedDb = new MemoryIndexedDb();
    indexedDb.seed("maps", "tiles", [
      {
        x: 3,
        y: 2,
        z: 3,
        layerId: "fallback",
        data: {
          type: "base64",
          content: btoa("offline-tile"),
          mimeType: "image/webp",
        },
      },
    ]);
    vi.stubGlobal("indexedDB", indexedDb.factory);
    const store = new LegacyOpenMapsIndexedDbStore({ databaseName: "maps" });

    const blob = await store.getRasterTile(3, 3, 2, ["preferred", "fallback"]);

    expect(await blob?.text()).toBe("offline-tile");
    expect(blob?.type).toBe("image/webp");
    expect(indexedDb.readKeys).toEqual([
      [3, 2, 3, "preferred"],
      [3, 2, 3, "fallback"],
    ]);
  });

  it("rejects invalid coordinates and an abort that happens while opening", async () => {
    const indexedDb = new MemoryIndexedDb();
    indexedDb.seed("maps", "tiles", []);
    vi.stubGlobal("indexedDB", indexedDb.factory);
    const store = new LegacyOpenMapsIndexedDbStore({ databaseName: "maps" });
    await expect(store.getRasterTile(2, 4, 0, ["streets"])).rejects.toThrow(
      /Invalid XYZ/,
    );

    const controller = new AbortController();
    const pending = store.getRasterTile(
      1,
      0,
      0,
      ["streets"],
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(indexedDb.readKeys).toEqual([]);
  });
});

describe("OpenEarth regional manifest", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => bitmap(await blob.text())),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stitches independently stored manifests by bounds before a global fallback", async () => {
    const westStore = memoryCache(null);
    westStore.getRasterTile.mockResolvedValue(new Blob(["west"]));
    const eastStore = memoryCache(null);
    eastStore.getRasterTile.mockResolvedValue(new Blob(["east"]));
    const fallbackLoad = vi.fn(async () => bitmap("fallback"));
    const fallback = urlProvider({
      id: "global",
      minZoom: 0,
      maxZoom: 4,
      loadTile: fallbackLoad,
      url: undefined,
    });
    const west = regionManifest("west-pack", [-180, -60, -1, 60], "west-map");
    const east = regionManifest("east-pack", [1, -60, 180, 60], "east-map");
    const resolver = vi.fn((manifest: OpenEarthRegionManifestV1) =>
      manifest.id === west.id ? westStore : eastStore,
    );
    const stitched = createOpenEarthRegionProvider([west, east], resolver, {
      fallbackProviders: [fallback],
    });

    const westResult = await stitched.loadTile(2, 0, 2);
    expect(westResult.status).toBe("loaded");
    expect(westStore.getRasterTile).toHaveBeenCalledWith(
      2,
      0,
      2,
      ["west-map"],
      undefined,
    );
    expect(eastStore.getRasterTile).not.toHaveBeenCalled();

    westStore.getRasterTile.mockClear();
    const eastResult = await stitched.loadTile(2, 3, 2);
    expect(eastResult.status).toBe("loaded");
    expect(eastStore.getRasterTile).toHaveBeenCalledWith(
      2,
      3,
      2,
      ["east-map"],
      undefined,
    );
    expect(westStore.getRasterTile).not.toHaveBeenCalled();

    const fallbackResult = await stitched.loadTile(2, 1, 0);
    expect(fallbackResult.status).toBe("loaded");
    expect(fallbackLoad).toHaveBeenCalledOnce();
    if (westResult.status === "loaded") westResult.image.close();
    if (eastResult.status === "loaded") eastResult.image.close();
    if (fallbackResult.status === "loaded") fallbackResult.image.close();
  });

  it("rejects incompatible schemas, duplicate packs, and layer ranges outside a pack", () => {
    expect(() =>
      validateOpenEarthRegionManifest({ schema: "openearth-region-v2" }),
    ).toThrow(/openearth-region-v1/);
    expect(() =>
      validateOpenEarthRegionManifest({
        schema: "openearth-region-v1",
        id: "unbounded",
        attribution: "Test",
        minZoom: 0,
        maxZoom: 1,
        raster: [{ id: "base", layerIds: ["streets"] }],
      }),
    ).toThrow(/geographic bounds/);
    expect(() =>
      validateOpenEarthRegionManifest({
        ...regionManifest("empty-bounds", [-10, -10, 10, 10], "streets"),
        bounds: [],
      }),
    ).toThrow(/geographic bounds/);

    const manifest = regionManifest("pack", [-10, -10, 10, 10], "streets");
    expect(() =>
      createOpenEarthRegionProvider([manifest, manifest], memoryCache(null)),
    ).toThrow(/Duplicate.*manifest id/);

    expect(() =>
      validateOpenEarthRegionManifest({
        ...manifest,
        raster: [{ ...manifest.raster[0], maxZoom: 19 }],
      }),
    ).toThrow(/zoom range exceeds/);
  });
});

describe("persistent tile cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips blobs, honors small budgets, and evicts only its provider", async () => {
    const indexedDb = new MemoryIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.factory);
    const left = new PersistentTileCache("left", {
      databaseName: "cache",
      maxBytes: 5,
    });
    const right = new PersistentTileCache("right", {
      databaseName: "cache",
      maxBytes: 5,
    });

    await left.putRasterTile(1, 0, 0, "ignored", new Blob(["old"]));
    await right.putRasterTile(1, 0, 0, "ignored", new Blob(["two"]));
    expect(await left.getRasterTile(1, 0, 0, [])).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 2));
    await left.putRasterTile(1, 1, 0, "ignored", new Blob(["new"]));

    expect(await left.getRasterTile(1, 0, 0, [])).toBeNull();
    expect(await left.getRasterTile(1, 1, 0, [])).not.toBeNull();
    expect(await right.getRasterTile(1, 0, 0, [])).not.toBeNull();
    await expect(
      left.putRasterTile(1, 2, 0, "ignored", new Blob(["bad"])),
    ).rejects.toThrow(/Invalid XYZ/);
  });

  it("reports unavailable IndexedDB without poisoning future opens", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const cache = new PersistentTileCache("source", { databaseName: "cache" });
    await expect(cache.getRasterTile(0, 0, 0, [])).rejects.toThrow(
      /IndexedDB is unavailable/,
    );

    const indexedDb = new MemoryIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.factory);
    await expect(cache.getRasterTile(0, 0, 0, [])).resolves.toBeNull();
  });

  it("rejects and removes a cached blob whose checksum no longer matches", async () => {
    const indexedDb = new MemoryIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.factory);
    const cache = new PersistentTileCache("source", { databaseName: "cache" });
    await cache.putRasterTile(0, 0, 0, "ignored", new Blob(["original"]));
    indexedDb.mutate("cache", "tiles", "source/0/0/0", (record) => ({
      ...(record as object),
      blob: new Blob(["tampered payload"]),
    }));

    await expect(cache.getRasterTile(0, 0, 0, [])).resolves.toBeNull();
    expect(indexedDb.has("cache", "tiles", "source/0/0/0")).toBe(false);
  });
});

describe("cached URL provider", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => bitmap(await blob.text())),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("inherits source metadata and serves a cache hit without fetching", async () => {
    const fetcher = vi.fn(async () => new Response("network"));
    const source = urlProvider({ fetch: fetcher as typeof fetch });
    const cache = memoryCache(new Blob(["cached"]));
    const provider = new CachedNetworkXyzProvider({ source, cache });

    const result = await provider.loadTile(2, 1, 1);

    expect(provider).toMatchObject({
      id: "network-cached",
      attribution: "Network tiles",
      minZoom: 1,
      maxZoom: 17,
      bounds: [-10, 35, 30, 70],
    });
    expect(result).toMatchObject({
      status: "loaded",
      image: { label: "cached" },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.putRasterTile).not.toHaveBeenCalled();
  });

  it("preserves the caller abort signal over source request defaults", async () => {
    const fetcher = vi.fn(async () => new Response("network"));
    const configuredController = new AbortController();
    const source = urlProvider({
      fetch: fetcher as typeof fetch,
      requestInit: { signal: configuredController.signal },
    });
    const cache = memoryCache(null);
    const provider = new CachedNetworkXyzProvider({ source, cache });
    const callerController = new AbortController();

    const result = await provider.loadTile(2, 1, 1, callerController.signal);

    expect(result.status).toBe("loaded");
    expect(fetcher).toHaveBeenCalledWith(
      "https://tiles.example/2/1/1.png",
      expect.objectContaining({ signal: callerController.signal }),
    );
    expect(cache.putRasterTile).toHaveBeenCalledOnce();
  });

  it("keeps online rendering available when persistent cache reads or writes fail", async () => {
    const fetcher = vi.fn(async () => new Response("network"));
    const cacheError = new Error("storage denied");
    const cache = memoryCache(null);
    cache.getRasterTile.mockRejectedValueOnce(cacheError);
    cache.putRasterTile.mockRejectedValueOnce(cacheError);
    const onCacheError = vi.fn();
    const provider = new CachedNetworkXyzProvider({
      source: urlProvider({ fetch: fetcher as typeof fetch }),
      cache,
      onCacheError,
    });

    const result = await provider.loadTile(2, 1, 1);

    expect(result).toMatchObject({
      status: "loaded",
      image: { label: "network" },
    });
    expect(onCacheError).toHaveBeenNthCalledWith(1, cacheError, "read", {
      z: 2,
      x: 1,
      y: 1,
    });
    expect(onCacheError).toHaveBeenNthCalledWith(2, cacheError, "write", {
      z: 2,
      x: 1,
      y: 1,
    });
  });

  it("replaces an undecodable cached blob from the network", async () => {
    const decodeError = new Error("invalid image");
    vi.mocked(createImageBitmap).mockRejectedValueOnce(decodeError);
    const fetcher = vi.fn(async () => new Response("fresh"));
    const cache = memoryCache(new Blob(["corrupt"]));
    const onCacheError = vi.fn();
    const provider = new CachedNetworkXyzProvider({
      source: urlProvider({ fetch: fetcher as typeof fetch }),
      cache,
      onCacheError,
    });

    const result = await provider.loadTile(2, 1, 1);

    expect(result).toMatchObject({
      status: "loaded",
      image: { label: "fresh" },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cache.putRasterTile).toHaveBeenCalledOnce();
    expect(onCacheError).toHaveBeenCalledWith(decodeError, "read", {
      z: 2,
      x: 1,
      y: 1,
    });
  });

  it("returns structured misses and HTTP errors", async () => {
    const missing = new CachedNetworkXyzProvider({
      source: urlProvider({
        fetch: (async () =>
          new Response(null, { status: 404 })) as typeof fetch,
      }),
      cache: memoryCache(null),
    });
    await expect(missing.loadTile(2, 1, 1)).resolves.toEqual({
      status: "missing",
    });

    const broken = new CachedNetworkXyzProvider({
      source: urlProvider({
        fetch: (async () =>
          new Response(null, { status: 503 })) as typeof fetch,
      }),
      cache: memoryCache(null),
    });
    const result = await broken.loadTile(2, 1, 1);
    expect(result.status).toBe("error");
    if (result.status === "error")
      expect(result.error).toEqual(expect.any(Error));
  });
});

function metadata() {
  return {
    id: "pack",
    layerIds: ["streets"],
    attribution: "OpenMaps test data",
    minZoom: 0,
    maxZoom: 18,
  } as const;
}

function urlProvider(
  overrides: Partial<XyzTileProvider> = {},
): XyzTileProvider {
  return {
    id: "network",
    attribution: "Network tiles",
    minZoom: 1,
    maxZoom: 17,
    bounds: [-10, 35, 30, 70],
    url: (z, x, y) => `https://tiles.example/${z}/${x}/${y}.png`,
    ...overrides,
  };
}

function regionManifest(
  id: string,
  bounds: OpenEarthRegionManifestV1["bounds"],
  layerId: string,
): OpenEarthRegionManifestV1 {
  return {
    schema: "openearth-region-v1",
    id,
    attribution: "Regional test data",
    minZoom: 0,
    maxZoom: 18,
    bounds,
    raster: [{ id: "base", layerIds: [layerId] }],
  };
}

function memoryCache(initial: Blob | null) {
  return {
    getRasterTile: vi.fn(async () => initial),
    putRasterTile: vi.fn(async () => undefined),
    close: vi.fn(),
  } satisfies OpenMapsRasterTileStore;
}

function bitmap(label: string) {
  return {
    label,
    width: 256,
    height: 256,
    close: vi.fn(),
  } as unknown as ImageBitmap & { label: string };
}

type MemoryStoreData = {
  readonly keyPath: string | readonly string[];
  readonly records: Map<string, unknown>;
  readonly indexes: Map<string, string>;
};

class MemoryIndexedDb {
  readonly readKeys: IDBValidKey[] = [];
  private readonly databases = new Map<string, MemoryDatabase>();
  readonly factory = {
    open: (name: string, version?: number) => this.open(name, version),
  } as IDBFactory;

  seed(name: string, storeName: string, records: readonly object[]): void {
    const database = new MemoryDatabase(this.readKeys);
    const store = database.addStore(storeName, ["x", "y", "z", "layerId"]);
    for (const record of records) {
      const key = keyFromValue(record, store.keyPath);
      store.records.set(serializeKey(key), record);
    }
    this.databases.set(name, database);
  }

  mutate(
    databaseName: string,
    storeName: string,
    key: IDBValidKey,
    update: (value: unknown) => unknown,
  ): void {
    this.databases.get(databaseName)?.mutate(storeName, key, update);
  }

  has(databaseName: string, storeName: string, key: IDBValidKey): boolean {
    return this.databases.get(databaseName)?.has(storeName, key) ?? false;
  }

  private open(name: string, _version?: number): IDBOpenDBRequest {
    const request = {
      result: undefined as unknown as IDBDatabase,
      error: null,
      transaction: null as IDBTransaction | null,
      onblocked: null,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const isNew = !database;
      if (!database) {
        database = new MemoryDatabase(this.readKeys);
        this.databases.set(name, database);
      }
      request.result = database as unknown as IDBDatabase;
      if (isNew) {
        const transaction = new MemoryTransaction(database);
        request.transaction = transaction as unknown as IDBTransaction;
        (request.onupgradeneeded as IDBOpenDBRequest["onupgradeneeded"])?.call(
          request as unknown as IDBOpenDBRequest,
          {} as IDBVersionChangeEvent,
        );
        if (transaction.aborted) return;
      }
      (request.onsuccess as IDBOpenDBRequest["onsuccess"])?.call(
        request as unknown as IDBOpenDBRequest,
        {} as Event,
      );
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

class MemoryDatabase {
  onversionchange:
    ((this: IDBDatabase, event: IDBVersionChangeEvent) => unknown) | null =
    null;
  private readonly stores = new Map<string, MemoryStoreData>();

  constructor(private readonly readKeys: IDBValidKey[]) {}

  get objectStoreNames(): DOMStringList {
    const names = [...this.stores.keys()];
    return {
      contains: (name: string) => this.stores.has(name),
      item: (index: number) => names[index] ?? null,
      length: names.length,
      [Symbol.iterator]: () => names[Symbol.iterator](),
    } as DOMStringList;
  }

  addStore(name: string, keyPath: string | readonly string[]): MemoryStoreData {
    const data = {
      keyPath,
      records: new Map<string, unknown>(),
      indexes: new Map<string, string>(),
    };
    this.stores.set(name, data);
    return data;
  }

  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters,
  ): IDBObjectStore {
    const keyPath = options?.keyPath;
    if (typeof keyPath !== "string" && !Array.isArray(keyPath)) {
      throw new Error("The memory test database requires a key path");
    }
    const data = this.addStore(name, keyPath);
    return new MemoryObjectStore(
      data,
      new MemoryTransaction(this),
      this.readKeys,
    ) as unknown as IDBObjectStore;
  }

  transaction(
    storeNames: string | string[],
    _mode?: IDBTransactionMode,
  ): IDBTransaction {
    const name = typeof storeNames === "string" ? storeNames : storeNames[0];
    if (!name || !this.stores.has(name))
      throw new Error(`Unknown store '${name}'`);
    return new MemoryTransaction(this) as unknown as IDBTransaction;
  }

  objectStore(name: string, transaction: MemoryTransaction): MemoryObjectStore {
    const data = this.stores.get(name);
    if (!data) throw new Error(`Unknown store '${name}'`);
    return new MemoryObjectStore(data, transaction, this.readKeys);
  }

  mutate(
    storeName: string,
    key: IDBValidKey,
    update: (value: unknown) => unknown,
  ): void {
    const records = this.stores.get(storeName)?.records;
    const serialized = serializeKey(key);
    if (records?.has(serialized)) {
      records.set(serialized, update(records.get(serialized)));
    }
  }

  has(storeName: string, key: IDBValidKey): boolean {
    return this.stores.get(storeName)?.records.has(serializeKey(key)) ?? false;
  }

  close(): void {}
}

class MemoryTransaction {
  error: DOMException | null = null;
  onabort: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  private completeHandler:
    ((this: IDBTransaction, event: Event) => unknown) | null = null;
  private pending = 0;
  private completeScheduled = false;
  aborted = false;

  constructor(private readonly database: MemoryDatabase) {}

  get oncomplete(): ((this: IDBTransaction, event: Event) => unknown) | null {
    return this.completeHandler;
  }

  set oncomplete(
    handler: ((this: IDBTransaction, event: Event) => unknown) | null,
  ) {
    this.completeHandler = handler;
    this.scheduleComplete();
  }

  objectStore(name: string): IDBObjectStore {
    return this.database.objectStore(name, this) as unknown as IDBObjectStore;
  }

  request<T>(operation: () => T): IDBRequest<T> {
    this.pending += 1;
    const request = {
      result: undefined as T,
      error: null as DOMException | null,
      onsuccess: null as
        ((this: IDBRequest<T>, event: Event) => unknown) | null,
      onerror: null as ((this: IDBRequest<T>, event: Event) => unknown) | null,
    };
    queueMicrotask(() => {
      if (this.aborted) return;
      try {
        request.result = operation();
        request.onsuccess?.call(
          request as unknown as IDBRequest<T>,
          {} as Event,
        );
      } catch (error) {
        request.error =
          error instanceof DOMException
            ? error
            : new DOMException(String(error));
        request.onerror?.call(request as unknown as IDBRequest<T>, {} as Event);
      } finally {
        this.pending -= 1;
        this.scheduleComplete();
      }
    });
    return request as unknown as IDBRequest<T>;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.onabort?.call(this as unknown as IDBTransaction, {} as Event);
  }

  private scheduleComplete(): void {
    if (this.completeScheduled || this.aborted) return;
    this.completeScheduled = true;
    queueMicrotask(() => {
      this.completeScheduled = false;
      if (this.pending > 0 || !this.completeHandler || this.aborted) return;
      this.completeHandler.call(this as unknown as IDBTransaction, {} as Event);
    });
  }
}

class MemoryObjectStore {
  constructor(
    private readonly data: MemoryStoreData,
    private readonly transaction: MemoryTransaction,
    private readonly readKeys: IDBValidKey[],
  ) {}

  get(key: IDBValidKey): IDBRequest<unknown> {
    this.readKeys.push(key);
    return this.transaction.request(() =>
      this.data.records.get(serializeKey(key)),
    );
  }

  getAll(): IDBRequest<unknown[]> {
    return this.transaction.request(() => [...this.data.records.values()]);
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    return this.transaction.request(() => {
      const key = keyFromValue(value, this.data.keyPath);
      this.data.records.set(serializeKey(key), value);
      return key;
    });
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.transaction.request(() => {
      this.data.records.delete(serializeKey(key));
      return undefined;
    });
  }

  createIndex(name: string, keyPath: string | string[]): IDBIndex {
    if (typeof keyPath !== "string")
      throw new Error("Test indexes use string keys");
    this.data.indexes.set(name, keyPath);
    return {} as IDBIndex;
  }

  index(name: string): IDBIndex {
    const keyPath = this.data.indexes.get(name);
    if (!keyPath) throw new Error(`Unknown index '${name}'`);
    return {
      getAll: (query?: IDBValidKey) =>
        this.transaction.request(() =>
          [...this.data.records.values()].filter(
            (value) =>
              query === undefined ||
              (value as Record<string, unknown>)[keyPath] === query,
          ),
        ),
    } as IDBIndex;
  }
}

function keyFromValue(
  value: unknown,
  keyPath: string | readonly string[],
): IDBValidKey {
  const record = value as Record<string, IDBValidKey>;
  return typeof keyPath === "string"
    ? record[keyPath]
    : keyPath.map((part) => record[part]);
}

function serializeKey(key: IDBValidKey): string {
  return JSON.stringify(key);
}
