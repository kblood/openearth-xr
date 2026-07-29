import {
  CompositeXyzTileProvider,
  validateXyzTileProvider,
  type XyzTileEventListener,
  type XyzTileRequest,
  XyzTileBounds,
  XyzTileProvider,
  XyzTileResult,
} from "../xr/XyzTileProvider";

export interface OpenMapsRasterSourceMetadata {
  readonly id: string;
  readonly layerIds: readonly string[];
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds?: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
  readonly overviewProvider?: XyzTileProvider;
}

export interface OpenMapsRasterTileStore {
  getRasterTile(
    z: number,
    x: number,
    y: number,
    layerIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Blob | null>;
  putRasterTile?(
    z: number,
    x: number,
    y: number,
    layerId: string,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<void>;
  close?(): void;
}

export const OPENEARTH_REGION_SCHEMA = "openearth-region-v1" as const;

export interface OpenEarthRegionRasterLayerV1 {
  /** Stable identifier within this manifest. */
  readonly id: string;
  /** OpenMaps store layers in highest-to-lowest priority order. */
  readonly layerIds: readonly string[];
  readonly attribution?: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly bounds?: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
}

/** Minimal portable metadata contract for stitching stored raster regions. */
export interface OpenEarthRegionManifestV1 {
  readonly schema: typeof OPENEARTH_REGION_SCHEMA;
  readonly id: string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
  readonly raster: ReadonlyArray<OpenEarthRegionRasterLayerV1>;
}

export type OpenEarthRegionStoreResolver = (
  manifest: OpenEarthRegionManifestV1,
  layer: OpenEarthRegionRasterLayerV1,
) => OpenMapsRasterTileStore;

export interface OpenEarthRegionProviderOptions {
  readonly id?: string;
  readonly attribution?: string;
  readonly fallbackProviders?: ReadonlyArray<XyzTileProvider>;
  readonly fallbackOnError?: boolean;
  readonly overviewProvider?: XyzTileProvider;
  readonly overviewFallbackColor?: string;
  readonly onTileEvent?: XyzTileEventListener;
}

/**
 * Creates one bounds-aware provider from one or more independently stored
 * region manifests. Manifest and raster order define routing priority.
 */
export function createOpenEarthRegionProvider(
  manifests:
    OpenEarthRegionManifestV1 | ReadonlyArray<OpenEarthRegionManifestV1>,
  storeOrResolver: OpenMapsRasterTileStore | OpenEarthRegionStoreResolver,
  options: OpenEarthRegionProviderOptions = {},
): CompositeXyzTileProvider {
  const regions = Array.isArray(manifests) ? [...manifests] : [manifests];
  if (regions.length === 0)
    throw new TypeError("At least one OpenEarth region manifest is required");
  const manifestIds = new Set<string>();
  const providers: XyzTileProvider[] = [];

  for (const manifest of regions) {
    validateOpenEarthRegionManifest(manifest);
    if (manifestIds.has(manifest.id))
      throw new TypeError(
        `Duplicate OpenEarth region manifest id '${manifest.id}'`,
      );
    manifestIds.add(manifest.id);
    for (const layer of manifest.raster) {
      const store =
        typeof storeOrResolver === "function"
          ? storeOrResolver(manifest, layer)
          : storeOrResolver;
      if (!store || typeof store.getRasterTile !== "function") {
        throw new TypeError(
          `Raster layer '${manifest.id}/${layer.id}' did not resolve to a tile store`,
        );
      }
      providers.push(
        new OpenMapsRasterProvider(store, {
          id: `${manifest.id}:${layer.id}`,
          layerIds: layer.layerIds,
          attribution: layer.attribution ?? manifest.attribution,
          minZoom: layer.minZoom ?? manifest.minZoom,
          maxZoom: layer.maxZoom ?? manifest.maxZoom,
          bounds: layer.bounds ?? manifest.bounds,
          overviewProvider: options.overviewProvider,
        }),
      );
    }
  }

  providers.push(...(options.fallbackProviders ?? []));
  return new CompositeXyzTileProvider({
    id:
      options.id ??
      `regions:${regions.map((manifest) => manifest.id).join("+")}`,
    providers,
    attribution: options.attribution,
    fallbackOnError: options.fallbackOnError,
    overviewProvider: options.overviewProvider,
    overviewFallbackColor: options.overviewFallbackColor,
    onTileEvent: options.onTileEvent,
  });
}

export function validateOpenEarthRegionManifest(
  manifest: unknown,
): asserts manifest is OpenEarthRegionManifestV1 {
  if (!isRegionManifest(manifest)) {
    throw new TypeError(
      "OpenEarth region manifest schema must be 'openearth-region-v1'",
    );
  }
  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    throw new TypeError("OpenEarth region manifest requires a non-empty id");
  }
  if (
    typeof manifest.attribution !== "string" ||
    !manifest.attribution.trim()
  ) {
    throw new TypeError(
      `OpenEarth region manifest '${manifest.id}' requires attribution`,
    );
  }
  if (!isManifestBounds(manifest.bounds)) {
    throw new TypeError(
      `OpenEarth region manifest '${manifest.id}' requires geographic bounds`,
    );
  }
  validateManifestCoverage(
    manifest.id,
    manifest.minZoom,
    manifest.maxZoom,
    manifest.bounds,
  );
  if (!Array.isArray(manifest.raster) || manifest.raster.length === 0) {
    throw new TypeError(
      `OpenEarth region manifest '${manifest.id}' requires at least one raster layer`,
    );
  }
  const layerIds = new Set<string>();
  for (const layer of manifest.raster) {
    if (
      !layer ||
      typeof layer !== "object" ||
      typeof layer.id !== "string" ||
      !layer.id.trim()
    ) {
      throw new TypeError(
        `OpenEarth region manifest '${manifest.id}' has a raster layer without an id`,
      );
    }
    if (layerIds.has(layer.id))
      throw new TypeError(
        `Duplicate raster layer id '${manifest.id}/${layer.id}'`,
      );
    layerIds.add(layer.id);
    if (
      !Array.isArray(layer.layerIds) ||
      layer.layerIds.length === 0 ||
      layer.layerIds.some((id: unknown) => typeof id !== "string" || !id.trim())
    ) {
      throw new TypeError(
        `Raster layer '${manifest.id}/${layer.id}' requires non-empty store layer ids`,
      );
    }
    if (
      layer.attribution !== undefined &&
      (typeof layer.attribution !== "string" || !layer.attribution.trim())
    ) {
      throw new TypeError(
        `Raster layer '${manifest.id}/${layer.id}' has invalid attribution`,
      );
    }
    if (layer.bounds !== undefined && !isManifestBounds(layer.bounds)) {
      throw new TypeError(
        `Raster layer '${manifest.id}/${layer.id}' has invalid geographic bounds`,
      );
    }
    if (layer.minZoom === null || layer.maxZoom === null) {
      throw new TypeError(
        `Raster layer '${manifest.id}/${layer.id}' has invalid zoom coverage`,
      );
    }
    const minZoom = layer.minZoom ?? manifest.minZoom;
    const maxZoom = layer.maxZoom ?? manifest.maxZoom;
    if (minZoom < manifest.minZoom || maxZoom > manifest.maxZoom) {
      throw new RangeError(
        `Raster layer '${manifest.id}/${layer.id}' zoom range exceeds its manifest`,
      );
    }
    validateManifestCoverage(
      `${manifest.id}:${layer.id}`,
      minZoom,
      maxZoom,
      layer.bounds ?? manifest.bounds,
    );
  }
}

/** Turns any OpenMaps/OPFS/native store into an OpenEarth raster provider. */
export class OpenMapsRasterProvider implements XyzTileProvider {
  readonly id: string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds?: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
  readonly overviewProvider?: XyzTileProvider;
  readonly metadata: OpenMapsRasterSourceMetadata;

  constructor(
    readonly store: OpenMapsRasterTileStore,
    metadata: OpenMapsRasterSourceMetadata,
  ) {
    if (
      !Array.isArray(metadata.layerIds) ||
      metadata.layerIds.length === 0 ||
      metadata.layerIds.some(
        (layerId: unknown) => typeof layerId !== "string" || !layerId.trim(),
      )
    )
      throw new TypeError(
        "OpenMaps raster source requires non-empty layer ids",
      );
    if (!store || typeof store.getRasterTile !== "function")
      throw new TypeError("OpenMaps raster source requires a tile store");
    this.metadata = { ...metadata, layerIds: [...metadata.layerIds] };
    this.id = this.metadata.id;
    this.attribution = this.metadata.attribution;
    this.minZoom = this.metadata.minZoom;
    this.maxZoom = this.metadata.maxZoom;
    this.bounds = this.metadata.bounds;
    this.overviewProvider = this.metadata.overviewProvider;
    validateXyzTileProvider(this);
  }

  async loadTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<XyzTileResult> {
    const blob = await this.store.getRasterTile(
      z,
      x,
      y,
      this.metadata.layerIds,
      signal,
    );
    if (!blob)
      return { status: "missing", retryAfterMs: Number.POSITIVE_INFINITY };
    if (signal?.aborted)
      throw new DOMException("OpenMaps tile cancelled", "AbortError");
    return {
      status: "loaded",
      image: await decodeBitmap(blob, signal),
      ownership: "transfer",
    };
  }
}

export interface LegacyOpenMapsIndexedDbOptions {
  readonly databaseName?: string;
  readonly storeName?: string;
}

/**
 * Read-only bridge to OpenMaps' `openmaps_global/tiles` compound-key store.
 * It opens existing databases without upgrading or taking ownership of them.
 */
export class LegacyOpenMapsIndexedDbStore implements OpenMapsRasterTileStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly options: LegacyOpenMapsIndexedDbOptions = {}) {}

  async getRasterTile(
    z: number,
    x: number,
    y: number,
    layerIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    validateTileCoordinate(z, x, y);
    if (signal?.aborted) throw abortError();
    const database = await this.open();
    if (signal?.aborted) throw abortError();
    for (const layerId of layerIds) {
      const record = await requestValue<LegacyTileRecord | undefined>(
        database
          .transaction(this.options.storeName ?? "tiles", "readonly")
          .objectStore(this.options.storeName ?? "tiles")
          .get([x, y, z, layerId]),
        signal,
      );
      const blob = record ? legacyDataBlob(record.data) : null;
      if (blob) return blob;
    }
    return null;
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }

  private open(): Promise<IDBDatabase> {
    const databasePromise =
      this.databasePromise ??
      new Promise<IDBDatabase>((resolve, reject) => {
        if (!globalThis.indexedDB) {
          reject(new Error("IndexedDB is unavailable"));
          return;
        }
        const request = indexedDB.open(
          this.options.databaseName ?? "openmaps_global",
        );
        request.onerror = () =>
          reject(
            request.error ?? new Error("Could not open OpenMaps database"),
          );
        request.onblocked = () =>
          reject(new Error("OpenMaps database is blocked by another tab"));
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          reject(
            new Error(
              `OpenMaps database '${this.options.databaseName ?? "openmaps_global"} does not exist`,
            ),
          );
        };
        request.onsuccess = () => {
          const database = request.result;
          if (
            !database.objectStoreNames.contains(
              this.options.storeName ?? "tiles",
            )
          ) {
            database.close();
            reject(
              new Error(
                `OpenMaps database has no '${this.options.storeName ?? "tiles"} store`,
              ),
            );
            return;
          }
          database.onversionchange = () => database.close();
          resolve(database);
        };
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    this.databasePromise = databasePromise;
    return databasePromise;
  }
}

export interface PersistentTileCacheOptions {
  readonly databaseName?: string;
  readonly maxBytes?: number;
}

type CachedTileRecord = {
  readonly key: string;
  readonly providerId: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly blob: Blob;
  readonly bytes: number;
  readonly checksum: string;
  lastAccessed: number;
};

/** Explicit persistent cache for sources whose terms allow offline storage. */
export class PersistentTileCache implements OpenMapsRasterTileStore {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private readonly maxBytes: number;

  constructor(
    private readonly providerId: string,
    private readonly options: PersistentTileCacheOptions = {},
  ) {
    if (!providerId.trim())
      throw new TypeError(
        "Persistent tile cache requires a non-empty provider id",
      );
    const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError(
        "Persistent tile cache maxBytes must be greater than zero",
      );
    }
    this.maxBytes = maxBytes;
  }

  async getRasterTile(
    z: number,
    x: number,
    y: number,
    _layerIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    validateTileCoordinate(z, x, y);
    if (signal?.aborted) throw abortError();
    const database = await this.open();
    const record = await requestValue<CachedTileRecord | undefined>(
      database
        .transaction("tiles", "readonly")
        .objectStore("tiles")
        .get(cacheKey(this.providerId, z, x, y)),
      signal,
    );
    if (!record) return null;
    if ((await sha256(record.blob, signal)) !== record.checksum) {
      const removal = database.transaction("tiles", "readwrite");
      removal.objectStore("tiles").delete(record.key);
      await transactionDone(removal, signal);
      return null;
    }
    record.lastAccessed = Date.now();
    const update = database.transaction("tiles", "readwrite");
    await Promise.all([
      requestValue(update.objectStore("tiles").put(record), signal),
      transactionDone(update, signal),
    ]);
    return record.blob;
  }

  async putRasterTile(
    z: number,
    x: number,
    y: number,
    _layerId: string,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<void> {
    validateTileCoordinate(z, x, y);
    if (signal?.aborted) throw abortError();
    const database = await this.open();
    const checksum = await sha256(blob, signal);
    const record: CachedTileRecord = {
      key: cacheKey(this.providerId, z, x, y),
      providerId: this.providerId,
      z,
      x,
      y,
      blob,
      bytes: blob.size,
      checksum,
      lastAccessed: Date.now(),
    };
    await requestValue(
      database
        .transaction("tiles", "readwrite")
        .objectStore("tiles")
        .put(record),
      signal,
    );
    await this.evict(database, signal);
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }

  private open(): Promise<IDBDatabase> {
    const databasePromise =
      this.databasePromise ??
      new Promise<IDBDatabase>((resolve, reject) => {
        if (!globalThis.indexedDB) {
          reject(new Error("IndexedDB is unavailable"));
          return;
        }
        const request = indexedDB.open(
          this.options.databaseName ?? "openearth_tiles_v1",
          1,
        );
        request.onerror = () =>
          reject(
            request.error ?? new Error("Could not open OpenEarth tile cache"),
          );
        request.onblocked = () =>
          reject(new Error("OpenEarth tile cache is blocked by another tab"));
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("tiles")) {
            const store = database.createObjectStore("tiles", {
              keyPath: "key",
            });
            store.createIndex("lastAccessed", "lastAccessed");
            store.createIndex("providerId", "providerId");
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("tiles")) {
            database.close();
            reject(new Error("OpenEarth tile cache has no 'tiles' store"));
            return;
          }
          database.onversionchange = () => database.close();
          resolve(database);
        };
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    this.databasePromise = databasePromise;
    return databasePromise;
  }

  private async evict(
    database: IDBDatabase,
    signal?: AbortSignal,
  ): Promise<void> {
    const records = await requestValue<CachedTileRecord[]>(
      database
        .transaction("tiles", "readonly")
        .objectStore("tiles")
        .index("providerId")
        .getAll(this.providerId),
      signal,
    );
    let total = records.reduce((sum, record) => sum + record.bytes, 0);
    if (total <= this.maxBytes) return;
    records.sort((left, right) => left.lastAccessed - right.lastAccessed);
    const transaction = database.transaction("tiles", "readwrite");
    for (const record of records) {
      if (total <= this.maxBytes * 0.9) break;
      transaction.objectStore("tiles").delete(record.key);
      total -= record.bytes;
    }
    await transactionDone(transaction, signal);
  }
}

export interface CachedNetworkXyzProviderOptions {
  readonly source: XyzTileProvider;
  readonly cache?: OpenMapsRasterTileStore;
  /** Defaults to `${source.id}-cached` so it cannot collide with the raw source in a scheduler cache. */
  readonly id?: string;
  readonly attribution?: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly bounds?: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
  readonly overviewProvider?: XyzTileProvider;
  readonly onCacheError?: (
    error: unknown,
    operation: "read" | "write",
    tile: XyzTileRequest,
  ) => void;
}

/** Online-to-persistent-cache adapter. Hosts must use it only when the source permits offline caching. */
export class CachedNetworkXyzProvider implements XyzTileProvider {
  readonly id: string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds?: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
  readonly overviewProvider?: XyzTileProvider;
  readonly hasTile?: (z: number, x: number, y: number) => boolean;
  private readonly cache: OpenMapsRasterTileStore;
  private readonly ownsCache: boolean;

  constructor(private readonly options: CachedNetworkXyzProviderOptions) {
    validateXyzTileProvider(options.source);
    if (!options.source.url)
      throw new TypeError(
        "Persistent network caching requires a URL-backed source",
      );
    this.id = options.id ?? `${options.source.id}-cached`;
    this.attribution = options.attribution ?? options.source.attribution;
    this.minZoom = options.minZoom ?? options.source.minZoom;
    this.maxZoom = options.maxZoom ?? options.source.maxZoom;
    this.bounds = options.bounds ?? options.source.bounds;
    this.overviewProvider =
      options.overviewProvider ?? options.source.overviewProvider;
    this.hasTile = options.source.hasTile
      ? (z, x, y) => options.source.hasTile!(z, x, y)
      : undefined;
    this.cache = options.cache ?? new PersistentTileCache(options.source.id);
    this.ownsCache = !options.cache;
    validateXyzTileProvider(this);
  }

  async loadTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<XyzTileResult> {
    let cached: Blob | null = null;
    try {
      cached = await this.cache.getRasterTile(
        z,
        x,
        y,
        [this.options.source.id],
        signal,
      );
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      this.reportCacheError(error, "read", { z, x, y });
    }
    if (cached) {
      try {
        return {
          status: "loaded",
          image: await decodeBitmap(cached, signal),
          ownership: "transfer",
        };
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        this.reportCacheError(error, "read", { z, x, y });
      }
    }
    try {
      const configured =
        typeof this.options.source.requestInit === "function"
          ? this.options.source.requestInit({ z, x, y })
          : this.options.source.requestInit;
      const response = await (this.options.source.fetch ?? fetch)(
        this.options.source.url!(z, x, y),
        {
          ...configured,
          mode: configured?.mode ?? "cors",
          signal: signal ?? configured?.signal,
        },
      );
      if (
        response.status === 404 ||
        response.status === 410 ||
        response.status === 204
      )
        return { status: "missing" };
      if (!response.ok)
        return {
          status: "error",
          error: new Error(`Tile failed (${response.status})`),
        };
      const blob = await response.blob();
      if (this.cache.putRasterTile) {
        try {
          await this.cache.putRasterTile(
            z,
            x,
            y,
            this.options.source.id,
            blob,
            signal,
          );
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) throw error;
          this.reportCacheError(error, "write", { z, x, y });
        }
      }
      return {
        status: "loaded",
        image: await decodeBitmap(blob, signal),
        ownership: "transfer",
      };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      return { status: "error", error };
    }
  }

  /** Releases only a cache created by this adapter; injected stores remain app-owned. */
  dispose(): void {
    if (this.ownsCache) this.cache.close?.();
  }

  private reportCacheError(
    error: unknown,
    operation: "read" | "write",
    tile: XyzTileRequest,
  ): void {
    try {
      this.options.onCacheError?.(error, operation, tile);
    } catch {
      // Cache telemetry must not affect rendering.
    }
  }
}

type LegacyTileRecord = { readonly data?: unknown };

function legacyDataBlob(data: unknown): Blob | null {
  if (data instanceof Blob) return data;
  if (!data || typeof data !== "object") return null;
  const encoded = data as {
    type?: unknown;
    content?: unknown;
    mimeType?: unknown;
  };
  if (encoded.type !== "base64" || typeof encoded.content !== "string")
    return null;
  const binary = atob(encoded.content);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], {
    type: typeof encoded.mimeType === "string" ? encoded.mimeType : "image/png",
  });
}

function requestValue<T>(
  request: IDBRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const abort = (): void => reject(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    request.onsuccess = () => {
      signal?.removeEventListener("abort", abort);
      resolve(request.result);
    };
    request.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(request.error);
    };
  });
}

function transactionDone(
  transaction: IDBTransaction,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      transaction.abort();
      reject(abortError());
      return;
    }
    const abort = (): void => {
      transaction.abort();
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    transaction.oncomplete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    transaction.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(transaction.error);
    };
    transaction.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(transaction.error ?? abortError());
    };
  });
}

function validateTileCoordinate(z: number, x: number, y: number): void {
  const count = 2 ** z;
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > 30 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= count ||
    y >= count
  ) {
    throw new RangeError(`Invalid XYZ tile ${z}/${x}/${y}`);
  }
}

function cacheKey(providerId: string, z: number, x: number, y: number): string {
  return `${providerId}/${z}/${x}/${y}`;
}

async function sha256(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `size-${blob.size}`;
  const digest = new Uint8Array(
    await subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  if (signal?.aborted) throw abortError();
  return [...digest]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function abortError(): DOMException {
  return new DOMException("Tile operation cancelled", "AbortError");
}

function isRegionManifest(value: unknown): value is OpenEarthRegionManifestV1 {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schema?: unknown }).schema === OPENEARTH_REGION_SCHEMA,
  );
}

function isManifestBounds(
  value: unknown,
): value is XyzTileBounds | ReadonlyArray<XyzTileBounds> {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (typeof value[0] === "number") return value.length === 4;
  return value.every((bounds) => Array.isArray(bounds) && bounds.length === 4);
}

function validateManifestCoverage(
  id: string,
  minZoom: number,
  maxZoom: number,
  bounds: XyzTileBounds | ReadonlyArray<XyzTileBounds>,
): void {
  validateXyzTileProvider({
    id: `manifest:${id}`,
    attribution: "",
    minZoom,
    maxZoom,
    bounds,
    url: () => "",
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function decodeBitmap(
  blob: Blob,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  if (signal?.aborted) throw abortError();
  const image = await createImageBitmap(blob);
  if (signal?.aborted) {
    image.close();
    throw abortError();
  }
  return image;
}
