export type XyzTileBounds = readonly [
  westDegrees: number,
  southDegrees: number,
  eastDegrees: number,
  northDegrees: number,
];

export interface XyzTileCoordinate {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface XyzTileLoadedResult {
  readonly status: "loaded";
  /**
   * Ownership is transferred to OpenEarth. The provider must return a unique
   * bitmap (or a clone) and must not close or reuse it after this promise
   * resolves. OpenEarth closes it on cache eviction or disposal.
   */
  readonly image: ImageBitmap;
  readonly ownership?: "transfer";
}

export interface XyzTileMissingResult {
  readonly status: "missing";
  /** Override the scheduler's negative-cache duration for this tile. */
  readonly retryAfterMs?: number;
}

export interface XyzTileErrorResult {
  readonly status: "error";
  readonly error: unknown;
  /** Override the scheduler's exponential retry delay for this failure. */
  readonly retryAfterMs?: number;
}

export type XyzTileResult =
  XyzTileLoadedResult | XyzTileMissingResult | XyzTileErrorResult;

/**
 * `ImageBitmap | null` is retained for v0.4 provider compatibility. A bare
 * bitmap also transfers ownership to OpenEarth; `null` means a stable miss.
 */
export type XyzTileProviderResponse = ImageBitmap | null | XyzTileResult;

export interface XyzTileRequest {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface XyzTileProvider {
  readonly id: string;
  /** Network-backed providers can expose a URL for each Web-Mercator XYZ tile. */
  readonly url?: (z: number, x: number, y: number) => string;
  /**
   * App-owned providers can load decoded images from OPFS, IndexedDB, native
   * bridges, or another map SDK. Every returned bitmap transfers ownership to
   * OpenEarth and must be unique to that result. Return `missing`/`null` for a
   * known absent tile and `error` (or throw) for a transient failure.
   */
  readonly loadTile?: (
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ) => Promise<XyzTileProviderResponse>;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Geographic coverage in degrees. West greater than east crosses ±180°. */
  readonly bounds?: XyzTileBounds | ReadonlyArray<XyzTileBounds>;
  /** Optional exact coverage check, evaluated after zoom and bounds checks. */
  readonly hasTile?: (z: number, x: number, y: number) => boolean;
  /**
   * Low-resolution source for the orbital overview when this provider starts
   * above overview-safe zoom. This is also honored by the legacy overview API.
   */
  readonly overviewProvider?: XyzTileProvider;
  /** Safe no-network overview used when neither source can provide zoom <= 4. */
  readonly overviewFallbackColor?: string;
  /** Optional fetch implementation and request policy for URL providers. */
  readonly fetch?: typeof globalThis.fetch;
  readonly requestInit?: RequestInit | ((tile: XyzTileRequest) => RequestInit);
}

export type XyzTileEventType =
  | "queued"
  | "cache-hit"
  | "loaded"
  | "missing"
  | "error"
  | "retry-blocked"
  | "cancelled";

export interface XyzTileEvent extends XyzTileCoordinate {
  readonly type: XyzTileEventType;
  readonly providerId: string;
  readonly error?: unknown;
  readonly retryAt?: number;
  readonly fromCache?: boolean;
}

export type XyzTileEventListener = (event: XyzTileEvent) => void;

export interface CompositeXyzTileProviderOptions {
  readonly id: string;
  /** Highest-priority provider first. */
  readonly providers: ReadonlyArray<XyzTileProvider>;
  readonly attribution?: string;
  /** Continue to a lower-priority source after an error, not only a miss. */
  readonly fallbackOnError?: boolean;
  readonly overviewProvider?: XyzTileProvider;
  readonly overviewFallbackColor?: string;
  readonly onTileEvent?: XyzTileEventListener;
}

/** Routes a tile to the first matching regional/global provider. */
export class CompositeXyzTileProvider implements XyzTileProvider {
  readonly id: string;
  readonly providers: ReadonlyArray<XyzTileProvider>;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly overviewProvider?: XyzTileProvider;
  readonly overviewFallbackColor?: string;
  private readonly fallbackOnError: boolean;
  private readonly onTileEvent?: XyzTileEventListener;

  constructor(options: CompositeXyzTileProviderOptions) {
    if (options.providers.length === 0)
      throw new Error("Composite XYZ provider requires at least one source");
    this.id = options.id;
    this.providers = [...options.providers];
    for (const provider of this.providers) validateXyzTileProvider(provider);
    this.minZoom = Math.min(
      ...this.providers.map((provider) => provider.minZoom),
    );
    this.maxZoom = Math.max(
      ...this.providers.map((provider) => provider.maxZoom),
    );
    this.attribution =
      options.attribution ??
      [
        ...new Set(
          this.providers
            .map((provider) => provider.attribution.trim())
            .filter(Boolean),
        ),
      ].join(" · ");
    this.fallbackOnError = options.fallbackOnError ?? false;
    this.overviewProvider =
      options.overviewProvider ??
      this.providers.find((provider) => provider.overviewProvider)
        ?.overviewProvider ??
      this.providers.find((provider) => provider.minZoom <= 4);
    this.overviewFallbackColor =
      options.overviewFallbackColor ??
      this.providers.find((provider) => provider.overviewFallbackColor)
        ?.overviewFallbackColor;
    this.onTileEvent = options.onTileEvent;
    validateXyzTileProvider(this);
  }

  hasTile = (z: number, x: number, y: number): boolean =>
    this.providers.some((provider) => providerContainsTile(provider, z, x, y));

  async loadTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<XyzTileResult> {
    let lastError: unknown;
    for (const provider of this.providers) {
      if (!providerContainsTile(provider, z, x, y)) continue;
      const result = await loadXyzProviderTile(provider, z, x, y, signal);
      if (result.status === "loaded") return result;
      if (result.status === "missing") continue;
      lastError = result.error;
      try {
        this.onTileEvent?.({
          type: "error",
          providerId: provider.id,
          z,
          x,
          y,
          error: result.error,
        });
      } catch {
        // Routing must remain independent from host telemetry failures.
      }
      if (!this.fallbackOnError) return result;
    }
    return lastError === undefined
      ? { status: "missing" }
      : { status: "error", error: lastError };
  }
}

export function validateXyzTileProvider(provider: XyzTileProvider): void {
  if (!provider || typeof provider !== "object")
    throw new TypeError("XYZ tile provider must be an object");
  if (typeof provider.id !== "string" || provider.id.trim().length === 0) {
    throw new TypeError("XYZ tile provider requires a non-empty id");
  }
  if (typeof provider.attribution !== "string") {
    throw new TypeError(
      `XYZ tile provider '${provider.id}' requires an attribution string`,
    );
  }
  validateZoom(provider.minZoom, "minZoom", provider.id);
  validateZoom(provider.maxZoom, "maxZoom", provider.id);
  if (provider.minZoom > provider.maxZoom) {
    throw new RangeError(
      `XYZ tile provider '${provider.id}' has minZoom greater than maxZoom`,
    );
  }
  if (!provider.url && !provider.loadTile) {
    throw new TypeError(
      `XYZ tile provider '${provider.id}' must define url or loadTile`,
    );
  }
  if (provider.bounds) {
    for (const bounds of normalizeBounds(provider.bounds))
      validateBounds(bounds, provider.id);
  }
}

export function providerContainsTile(
  provider: XyzTileProvider,
  z: number,
  x: number,
  y: number,
): boolean {
  if (!Number.isInteger(z) || z < provider.minZoom || z > provider.maxZoom)
    return false;
  const count = 2 ** z;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= count ||
    y < 0 ||
    y >= count
  )
    return false;
  if (
    provider.bounds &&
    !normalizeBounds(provider.bounds).some((bounds) =>
      tileIntersectsBounds(z, x, y, bounds),
    )
  ) {
    return false;
  }
  return provider.hasTile?.(z, x, y) ?? true;
}

export async function loadXyzProviderTile(
  provider: XyzTileProvider,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<XyzTileResult> {
  if (!providerContainsTile(provider, z, x, y))
    return { status: "missing", retryAfterMs: Number.POSITIVE_INFINITY };
  try {
    if (signal?.aborted) throw abortError();
    if (provider.loadTile)
      return normalizeXyzTileResponse(await provider.loadTile(z, x, y, signal));
    const fetcher = provider.fetch ?? globalThis.fetch;
    if (!fetcher)
      throw new Error(`XYZ tile provider '${provider.id}' needs fetch support`);
    const tile = { z, x, y };
    const configured =
      typeof provider.requestInit === "function"
        ? provider.requestInit(tile)
        : provider.requestInit;
    const response = await fetcher(provider.url!(z, x, y), {
      ...configured,
      mode: configured?.mode ?? "cors",
      signal,
    });
    if (
      response.status === 404 ||
      response.status === 410 ||
      response.status === 204
    )
      return { status: "missing" };
    if (!response.ok) {
      return {
        status: "error",
        error: new Error(
          `XYZ tile ${provider.id}/${z}/${x}/${y} failed (${response.status})`,
        ),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    return {
      status: "loaded",
      image: await createImageBitmap(await response.blob()),
      ownership: "transfer",
    };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return { status: "error", error };
  }
}

export function normalizeXyzTileResponse(
  response: XyzTileProviderResponse,
): XyzTileResult {
  if (response === null) return { status: "missing" };
  if (isImageBitmap(response))
    return { status: "loaded", image: response, ownership: "transfer" };
  if (response.status === "loaded") {
    if (!isImageBitmap(response.image))
      throw new TypeError("Loaded XYZ tile result requires an ImageBitmap");
    if (response.ownership && response.ownership !== "transfer") {
      throw new TypeError("XYZ tile bitmap ownership must be 'transfer'");
    }
  }
  return response;
}

export function xyzTileKey(
  provider: XyzTileProvider,
  z: number,
  x: number,
  y: number,
): string {
  return `${provider.id}/${z}/${x}/${y}`;
}

function validateZoom(value: number, name: string, id: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 30) {
    throw new RangeError(
      `XYZ tile provider '${id}' ${name} must be an integer from 0 to 30`,
    );
  }
}

function normalizeBounds(
  bounds: XyzTileBounds | ReadonlyArray<XyzTileBounds>,
): ReadonlyArray<XyzTileBounds> {
  return typeof bounds[0] === "number"
    ? [bounds as XyzTileBounds]
    : (bounds as ReadonlyArray<XyzTileBounds>);
}

function validateBounds(bounds: XyzTileBounds, id: string): void {
  const [west, south, east, north] = bounds;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    south >= north
  ) {
    throw new RangeError(
      `XYZ tile provider '${id}' has invalid Web-Mercator bounds`,
    );
  }
}

function tileIntersectsBounds(
  z: number,
  x: number,
  y: number,
  bounds: XyzTileBounds,
): boolean {
  const count = 2 ** z;
  const tileWest = (x / count) * 360 - 180;
  const tileEast = ((x + 1) / count) * 360 - 180;
  const tileNorth = tileYToLatitudeDegrees(y, count);
  const tileSouth = tileYToLatitudeDegrees(y + 1, count);
  const [west, south, east, north] = bounds;
  if (tileNorth < south || tileSouth > north) return false;
  if (west <= east) return tileEast >= west && tileWest <= east;
  return tileEast >= west || tileWest <= east;
}

function tileYToLatitudeDegrees(tileY: number, count: number): number {
  return (
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / count))) * 180) / Math.PI
  );
}

function isImageBitmap(value: unknown): value is ImageBitmap {
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap)
    return true;
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ImageBitmap).close === "function" &&
    typeof (value as ImageBitmap).width === "number" &&
    typeof (value as ImageBitmap).height === "number",
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : undefined;
}

function abortError(): DOMException {
  return new DOMException("XYZ tile request cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
