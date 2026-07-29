import { VectorTile } from "@mapbox/vector-tile";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { PbfReader } from "pbf";

export type BuildingPosition = readonly [longitude: number, latitude: number];

/** A single extrudable footprint. The first ring is the exterior; later rings are holes. */
export interface BuildingFootprint {
  readonly id?: string | number;
  readonly rings: ReadonlyArray<ReadonlyArray<BuildingPosition>>;
  readonly heightMeters: number;
  readonly minHeightMeters: number;
  readonly color?: string;
}

/** Renderer-independent building tiles for online, cached, and OpenMaps adapters. */
export interface BuildingTileProvider {
  readonly id: string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Synchronous availability hint. False means renderers must not request the tile. */
  readonly hasTile?: (z: number, x: number, y: number) => boolean;
  loadTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<BuildingFootprint>>;
}

export type BuildingProviderErrorCode =
  | "ABORTED"
  | "INVALID_CONFIGURATION"
  | "INVALID_TILE"
  | "OUT_OF_BOUNDS"
  | "HTTP"
  | "TILE_TOO_LARGE"
  | "DECODE_LIMIT"
  | "DECODE";

export class BuildingProviderError extends Error {
  readonly name = "BuildingProviderError";

  constructor(
    readonly code: BuildingProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details: {
      readonly z?: number;
      readonly x?: number;
      readonly y?: number;
      readonly status?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
  }
}

export interface BuildingDecodeLimits {
  readonly maxFeatures?: number;
  readonly maxFootprints?: number;
  readonly maxVertices?: number;
}

export interface MvtBuildingProviderOptions extends BuildingDecodeLimits {
  readonly id: string;
  readonly attribution: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Direct vector-tile URL. Use this for OpenMaps/offline bundle adapters. */
  readonly url?: (z: number, x: number, y: number) => string;
  /** Optional alternative endpoints, selected deterministically per tile. */
  readonly urls?: ReadonlyArray<(z: number, x: number, y: number) => string>;
  /** TileJSON document used to resolve versioned URL templates at runtime. */
  readonly tileJsonUrl?: string;
  readonly sourceLayer?: string;
  readonly defaultHeightMeters?: number;
  readonly bounds?: readonly [
    west: number,
    south: number,
    east: number,
    north: number,
  ];
  readonly maxTileBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

type TileJson = {
  readonly tiles?: readonly string[];
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly bounds?: readonly number[];
  readonly vector_layers?: ReadonlyArray<{
    readonly id?: string;
    readonly minzoom?: number;
    readonly maxzoom?: number;
  }>;
};

type ResolvedTileJson = {
  readonly templates: readonly string[];
  readonly bounds?: readonly [number, number, number, number];
};

const DEFAULT_LIMITS = {
  maxTileBytes: 5 * 1024 * 1024,
  maxFeatures: 25_000,
  maxFootprints: 25_000,
  maxVertices: 400_000,
} as const;

/**
 * Decodes standard MVT building polygons into a small, renderer-neutral form.
 * Its byte-in / plain-data-out boundary is deliberately structured-clone safe,
 * so a host can move this exact function behind a Worker without renderer APIs.
 */
export class MvtBuildingProvider implements BuildingTileProvider {
  readonly id: string;
  readonly attribution: string;
  minZoom: number;
  maxZoom: number;
  private readonly sourceLayer: string;
  private readonly defaultHeightMeters: number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly directUrls: ReadonlyArray<
    (z: number, x: number, y: number) => string
  >;
  private readonly maxTileBytes: number;
  private readonly limits: Required<BuildingDecodeLimits>;
  private bounds?: readonly [number, number, number, number];
  private tileJsonPromise: Promise<ResolvedTileJson> | null = null;
  private tileJsonController: AbortController | null = null;
  private tileJsonWaiters = 0;
  private tileJsonPending = false;

  constructor(private readonly options: MvtBuildingProviderOptions) {
    if (
      !options.url &&
      (!options.urls || options.urls.length === 0) &&
      !options.tileJsonUrl
    ) {
      throw configurationError(
        "MVT building provider requires url, urls, or tileJsonUrl",
      );
    }
    if (!options.id.trim())
      throw configurationError("MVT building provider id must not be empty");
    if (
      !Number.isInteger(options.minZoom ?? 13) ||
      !Number.isInteger(options.maxZoom ?? 14) ||
      (options.minZoom ?? 13) < 0 ||
      (options.maxZoom ?? 14) > 30 ||
      (options.minZoom ?? 13) > (options.maxZoom ?? 14)
    ) {
      throw configurationError(
        "MVT building zoom range must be integers with 0 <= minZoom <= maxZoom <= 30",
      );
    }
    if (
      !Number.isFinite(options.defaultHeightMeters ?? 9) ||
      (options.defaultHeightMeters ?? 9) <= 0
    ) {
      throw configurationError("MVT default building height must be positive");
    }
    this.id = options.id;
    this.attribution = options.attribution;
    this.minZoom = options.minZoom ?? 13;
    this.maxZoom = options.maxZoom ?? 14;
    this.sourceLayer = options.sourceLayer ?? "building";
    this.defaultHeightMeters = options.defaultHeightMeters ?? 9;
    this.fetcher =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.directUrls = [options.url, ...(options.urls ?? [])].filter(
      (entry): entry is (z: number, x: number, y: number) => string =>
        Boolean(entry),
    );
    this.maxTileBytes = positiveInteger(
      options.maxTileBytes,
      DEFAULT_LIMITS.maxTileBytes,
      "maxTileBytes",
    );
    this.limits = {
      maxFeatures: positiveInteger(
        options.maxFeatures,
        DEFAULT_LIMITS.maxFeatures,
        "maxFeatures",
      ),
      maxFootprints: positiveInteger(
        options.maxFootprints,
        DEFAULT_LIMITS.maxFootprints,
        "maxFootprints",
      ),
      maxVertices: positiveInteger(
        options.maxVertices,
        DEFAULT_LIMITS.maxVertices,
        "maxVertices",
      ),
    };
    this.bounds = options.bounds ? validateBounds(options.bounds) : undefined;
  }

  readonly hasTile = (z: number, x: number, y: number): boolean => {
    if (!validTileCoordinate(z, x, y) || z < this.minZoom) return false;
    const level = Math.min(z, this.maxZoom);
    const divisor = 2 ** Math.max(0, z - level);
    const tileX = Math.floor(x / divisor);
    const tileY = Math.floor(y / divisor);
    if (!this.bounds) return true;
    const count = 2 ** level;
    const tileWest = (tileX / count) * 360 - 180;
    const tileEast = ((tileX + 1) / count) * 360 - 180;
    const tileNorth =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / count))) * 180) /
      Math.PI;
    const tileSouth =
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + 1)) / count))) * 180) /
      Math.PI;
    const [west, south, east, north] = this.bounds;
    const latitudeOverlaps = tileNorth >= south && tileSouth <= north;
    const longitudeOverlaps =
      west <= east
        ? tileEast >= west && tileWest <= east
        : tileEast >= west || tileWest <= east;
    return longitudeOverlaps && latitudeOverlaps;
  };

  async loadTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<BuildingFootprint>> {
    throwIfAborted(signal);
    if (!validTileCoordinate(z, x, y)) {
      throw new BuildingProviderError(
        "INVALID_TILE",
        `Invalid building tile ${z}/${x}/${y}`,
        false,
        { z, x, y },
      );
    }
    // A lower-zoom request covers many minZoom children, so selecting one child
    // would silently return the wrong geography. Absence is the safe result.
    if (z < this.minZoom) return [];
    const level = Math.min(z, this.maxZoom);
    const divisor = 2 ** Math.max(0, z - level);
    const tileX = Math.floor(x / divisor);
    const tileY = Math.floor(y / divisor);
    if (!this.hasTile(z, x, y)) {
      throw new BuildingProviderError(
        "OUT_OF_BOUNDS",
        `Building tile ${z}/${x}/${y} is outside provider bounds`,
        false,
        { z, x, y },
      );
    }

    const templates =
      this.directUrls.length > 0
        ? this.directUrls.map((url) => url(level, tileX, tileY))
        : (await this.waitForTileJson(signal)).templates.map((template) =>
            fillTemplate(template, level, tileX, tileY),
          );
    throwIfAborted(signal);
    if (!this.hasTile(z, x, y)) {
      throw new BuildingProviderError(
        "OUT_OF_BOUNDS",
        `Building tile ${z}/${x}/${y} is outside provider bounds`,
        false,
        { z, x, y },
      );
    }
    const url =
      templates[stableEndpoint(level, tileX, tileY, templates.length)];
    let response: Response;
    try {
      response = await this.fetcher(url, { mode: "cors", signal });
    } catch (error) {
      if (isAbort(error, signal))
        throw abortedError(level, tileX, tileY, error);
      throw new BuildingProviderError(
        "HTTP",
        `Building tile ${level}/${tileX}/${tileY} request failed`,
        true,
        {
          z: level,
          x: tileX,
          y: tileY,
          cause: error,
        },
      );
    }
    if (!response.ok) {
      throw new BuildingProviderError(
        "HTTP",
        `Building tile ${level}/${tileX}/${tileY} failed (${response.status})`,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        { z: level, x: tileX, y: tileY, status: response.status },
      );
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > this.maxTileBytes) {
      throw new BuildingProviderError(
        "TILE_TOO_LARGE",
        `Building tile exceeds ${this.maxTileBytes} bytes`,
        false,
        {
          z: level,
          x: tileX,
          y: tileY,
        },
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readResponseBytes(
        response,
        this.maxTileBytes,
        signal,
        level,
        tileX,
        tileY,
      );
    } catch (error) {
      if (error instanceof BuildingProviderError) throw error;
      if (isAbort(error, signal))
        throw abortedError(level, tileX, tileY, error);
      throw new BuildingProviderError(
        "HTTP",
        `Building tile ${level}/${tileX}/${tileY} body failed`,
        true,
        {
          z: level,
          x: tileX,
          y: tileY,
          cause: error,
        },
      );
    }
    throwIfAborted(signal, level, tileX, tileY);
    try {
      return decodeMvtBuildingTile(
        bytes,
        level,
        tileX,
        tileY,
        this.sourceLayer,
        this.defaultHeightMeters,
        this.limits,
      );
    } catch (error) {
      if (error instanceof BuildingProviderError) throw error;
      throw new BuildingProviderError(
        "DECODE",
        `Building tile ${level}/${tileX}/${tileY} is corrupt`,
        false,
        {
          z: level,
          x: tileX,
          y: tileY,
          cause: error,
        },
      );
    }
  }

  private resolveTileJson(): Promise<ResolvedTileJson> {
    if (!this.tileJsonPromise) {
      this.tileJsonController = new AbortController();
      this.tileJsonPending = true;
      this.tileJsonPromise = this.fetcher(this.options.tileJsonUrl!, {
        mode: "cors",
        signal: this.tileJsonController.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new BuildingProviderError(
              "HTTP",
              `Building TileJSON failed (${response.status})`,
              response.status === 408 ||
                response.status === 429 ||
                response.status >= 500,
              { status: response.status },
            );
          }
          let tileJson: TileJson;
          try {
            tileJson = (await response.json()) as TileJson;
          } catch (error) {
            throw new BuildingProviderError(
              "DECODE",
              "Building TileJSON is not valid JSON",
              false,
              { cause: error },
            );
          }
          const baseUrl = response.url || this.options.tileJsonUrl!;
          if (tileJson.tiles !== undefined && !Array.isArray(tileJson.tiles)) {
            throw configurationError(
              "Building TileJSON tiles must be an array",
            );
          }
          let templates: string[];
          try {
            templates =
              tileJson.tiles
                ?.filter(
                  (entry): entry is string =>
                    typeof entry === "string" && entry.length > 0,
                )
                .map((entry) => new URL(entry, baseUrl).href) ?? [];
          } catch (error) {
            throw new BuildingProviderError(
              "INVALID_CONFIGURATION",
              "Building TileJSON contains an invalid tile URL",
              false,
              {
                cause: error,
              },
            );
          }
          if (templates.length === 0)
            throw configurationError("Building TileJSON contains no tile URL");
          if (
            tileJson.vector_layers !== undefined &&
            !Array.isArray(tileJson.vector_layers)
          ) {
            throw configurationError(
              "Building TileJSON vector_layers must be an array",
            );
          }
          const layer = tileJson.vector_layers?.find(
            (entry) => entry.id === this.sourceLayer,
          );
          if (this.options.minZoom === undefined)
            this.minZoom = validZoom(
              layer?.minzoom ?? tileJson.minzoom,
              this.minZoom,
            );
          if (this.options.maxZoom === undefined)
            this.maxZoom = validZoom(
              layer?.maxzoom ?? tileJson.maxzoom,
              this.maxZoom,
            );
          if (this.maxZoom < this.minZoom) this.maxZoom = this.minZoom;
          const metadataBounds = tileJson.bounds;
          if (
            metadataBounds !== undefined &&
            (!Array.isArray(metadataBounds) || metadataBounds.length !== 4)
          ) {
            throw configurationError(
              "Building TileJSON bounds must contain four numbers",
            );
          }
          if (!this.bounds && metadataBounds?.length === 4) {
            this.bounds = validateBounds([
              metadataBounds[0],
              metadataBounds[1],
              metadataBounds[2],
              metadataBounds[3],
            ]);
          }
          return { templates, bounds: this.bounds };
        })
        .catch((error) => {
          this.tileJsonPromise = null;
          if (isAbort(error, this.tileJsonController?.signal))
            throw abortedError(undefined, undefined, undefined, error);
          if (error instanceof BuildingProviderError) throw error;
          throw new BuildingProviderError(
            "HTTP",
            "Building TileJSON request failed",
            true,
            { cause: error },
          );
        })
        .finally(() => {
          this.tileJsonPending = false;
          this.tileJsonController = null;
        });
    }
    return this.tileJsonPromise;
  }

  private async waitForTileJson(
    signal?: AbortSignal,
  ): Promise<ResolvedTileJson> {
    this.tileJsonWaiters += 1;
    try {
      return await waitWithSignal(this.resolveTileJson(), signal);
    } finally {
      this.tileJsonWaiters -= 1;
      if (this.tileJsonPending && this.tileJsonWaiters === 0)
        this.tileJsonController?.abort();
    }
  }
}

export const OPENFREEMAP_BUILDINGS = new MvtBuildingProvider({
  id: "openfreemap-buildings",
  tileJsonUrl: "https://tiles.openfreemap.org/planet",
  sourceLayer: "building",
  minZoom: 13,
  maxZoom: 14,
  attribution: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
});

export function decodeMvtBuildingTile(
  bytes: Uint8Array,
  z: number,
  x: number,
  y: number,
  sourceLayer = "building",
  defaultHeightMeters = 9,
  limits: BuildingDecodeLimits = {},
): ReadonlyArray<BuildingFootprint> {
  if (!validTileCoordinate(z, x, y)) {
    throw new BuildingProviderError(
      "INVALID_TILE",
      `Invalid building tile ${z}/${x}/${y}`,
      false,
      { z, x, y },
    );
  }
  const fallbackHeight =
    Number.isFinite(defaultHeightMeters) && defaultHeightMeters > 0
      ? defaultHeightMeters
      : 9;
  const maximumFeatures = positiveInteger(
    limits.maxFeatures,
    DEFAULT_LIMITS.maxFeatures,
    "maxFeatures",
  );
  const maximumFootprints = positiveInteger(
    limits.maxFootprints,
    DEFAULT_LIMITS.maxFootprints,
    "maxFootprints",
  );
  const maximumVertices = positiveInteger(
    limits.maxVertices,
    DEFAULT_LIMITS.maxVertices,
    "maxVertices",
  );
  let layer;
  try {
    layer = new VectorTile(new PbfReader(bytes)).layers[sourceLayer];
  } catch (error) {
    throw new BuildingProviderError("DECODE", "Invalid MVT payload", false, {
      z,
      x,
      y,
      cause: error,
    });
  }
  if (!layer) return [];
  if (layer.length > maximumFeatures)
    throw decodeLimit(
      `Building tile has more than ${maximumFeatures} features`,
      z,
      x,
      y,
    );
  const buildings: BuildingFootprint[] = [];
  let vertices = 0;
  for (let index = 0; index < layer.length; index += 1) {
    let vectorFeature: ReturnType<typeof layer.feature>;
    try {
      vectorFeature = layer.feature(index);
    } catch (error) {
      throw new BuildingProviderError(
        "DECODE",
        "Invalid building feature",
        false,
        { z, x, y, cause: error },
      );
    }
    if (vectorFeature.type !== 3 || isTruthy(vectorFeature.properties.hide_3d))
      continue;
    let feature: Feature<Polygon | MultiPolygon>;
    try {
      feature = vectorFeature.toGeoJSON(x, y, z) as Feature<
        Polygon | MultiPolygon
      >;
    } catch (error) {
      throw new BuildingProviderError(
        "DECODE",
        "Invalid building polygon geometry",
        false,
        { z, x, y, cause: error },
      );
    }
    const polygons =
      feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    const minHeight =
      finiteNumber(
        vectorFeature.properties.render_min_height,
        vectorFeature.properties.min_height,
        levelHeight(vectorFeature.properties["building:min_level"]),
      ) ?? 0;
    const explicitHeight = finiteNumber(
      vectorFeature.properties.render_height,
      vectorFeature.properties.height,
    );
    const levels = finiteNumber(
      vectorFeature.properties.levels,
      vectorFeature.properties["building:levels"],
    );
    const topHeight =
      explicitHeight ?? (levels !== undefined ? levels * 3 : fallbackHeight);
    const safeBase = clamp(minHeight, 0, 800);
    const safeTop = clamp(
      Math.max(topHeight, safeBase + 2.5),
      safeBase + 2.5,
      1_000,
    );
    const color = stringValue(
      vectorFeature.properties.colour,
      vectorFeature.properties.color,
    );
    for (
      let polygonIndex = 0;
      polygonIndex < polygons.length;
      polygonIndex += 1
    ) {
      const rings = polygons[polygonIndex]
        .map((ring) =>
          ring
            .map(
              ([longitude, latitude]) =>
                [longitude, latitude] as BuildingPosition,
            )
            .filter(
              (position) =>
                Number.isFinite(position[0]) &&
                Number.isFinite(position[1]) &&
                position[0] >= -180 &&
                position[0] <= 180 &&
                position[1] >= -90 &&
                position[1] <= 90,
            ),
        )
        .filter((ring) => ring.length >= 4);
      if (rings.length === 0) continue;
      vertices += rings.reduce((sum, ring) => sum + ring.length, 0);
      if (vertices > maximumVertices)
        throw decodeLimit(
          `Building tile has more than ${maximumVertices} vertices`,
          z,
          x,
          y,
        );
      if (buildings.length >= maximumFootprints)
        throw decodeLimit(
          `Building tile has more than ${maximumFootprints} footprints`,
          z,
          x,
          y,
        );
      buildings.push({
        id:
          vectorFeature.id === undefined
            ? `${index}/${polygonIndex}`
            : `${vectorFeature.id}/${polygonIndex}`,
        rings,
        heightMeters: safeTop,
        minHeightMeters: safeBase,
        color,
      });
    }
  }
  return buildings;
}

/** Explicit structured-clone request/response boundary for host Worker adapters. */
export function decodeMvtBuildingRequest(request: {
  readonly bytes: Uint8Array;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly sourceLayer?: string;
  readonly defaultHeightMeters?: number;
  readonly limits?: BuildingDecodeLimits;
}): ReadonlyArray<BuildingFootprint> {
  return decodeMvtBuildingTile(
    request.bytes,
    request.z,
    request.x,
    request.y,
    request.sourceLayer,
    request.defaultHeightMeters,
    request.limits,
  );
}

function fillTemplate(
  template: string,
  z: number,
  x: number,
  y: number,
): string {
  return template
    .replace(/(?:\{|%7B)z(?:\}|%7D)/gi, String(z))
    .replace(/(?:\{|%7B)x(?:\}|%7D)/gi, String(x))
    .replace(/(?:\{|%7B)y(?:\}|%7D)/gi, String(y));
}

function stableEndpoint(
  z: number,
  x: number,
  y: number,
  count: number,
): number {
  if (count <= 1) return 0;
  return Math.abs(((z * 73856093) ^ (x * 19349663) ^ (y * 83492791)) % count);
}

function validTileCoordinate(z: number, x: number, y: number): boolean {
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > 30 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y)
  )
    return false;
  const count = 2 ** z;
  return x >= 0 && x < count && y >= 0 && y < count;
}

function validateBounds(
  bounds: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const [west, south, east, north] = bounds;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    south > north
  ) {
    throw configurationError(
      "Building bounds must be [west, south, east, north] in degrees",
    );
  }
  return [west, south, east, north];
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw configurationError(`${name} must be a positive integer`);
  return resolved;
}

function validZoom(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 0 && value! <= 30
    ? value!
    : fallback;
}

function configurationError(message: string): BuildingProviderError {
  return new BuildingProviderError("INVALID_CONFIGURATION", message, false);
}

function decodeLimit(
  message: string,
  z: number,
  x: number,
  y: number,
): BuildingProviderError {
  return new BuildingProviderError("DECODE_LIMIT", message, false, { z, x, y });
}

function abortedError(
  z?: number,
  x?: number,
  y?: number,
  cause?: unknown,
): BuildingProviderError {
  return new BuildingProviderError(
    "ABORTED",
    "Building request aborted",
    false,
    { z, x, y, cause },
  );
}

function throwIfAborted(
  signal?: AbortSignal,
  z?: number,
  x?: number,
  y?: number,
): void {
  if (signal?.aborted) throw abortedError(z, x, y, signal.reason);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

async function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(abortedError(undefined, undefined, undefined, signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes)
      throw tileTooLarge(maximumBytes, z, x, y);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      throwIfAborted(signal, z, x, y);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        try {
          await reader.cancel("Building tile byte limit exceeded");
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw tileTooLarge(maximumBytes, z, x, y);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tileTooLarge(
  maximumBytes: number,
  z: number,
  x: number,
  y: number,
): BuildingProviderError {
  return new BuildingProviderError(
    "TILE_TOO_LARGE",
    `Building tile exceeds ${maximumBytes} bytes`,
    false,
    { z, x, y },
  );
}

function levelHeight(value: unknown): number | undefined {
  const levels = finiteNumber(value);
  return levels === undefined ? undefined : levels * 3;
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
