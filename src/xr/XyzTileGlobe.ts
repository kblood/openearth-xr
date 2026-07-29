import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  Matrix4,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Vector3,
} from "three";
import {
  CompositeXyzTileProvider,
  providerContainsTile,
  validateXyzTileProvider,
  type CompositeXyzTileProviderOptions,
  type XyzTileBounds,
  type XyzTileEvent,
  type XyzTileEventListener,
  type XyzTileLoadedResult,
  type XyzTileMissingResult,
  type XyzTileErrorResult,
  type XyzTileProvider,
  type XyzTileProviderResponse,
  type XyzTileResult,
} from "./XyzTileProvider";
import {
  XyzTileScheduler,
  type XyzScheduledTileResult,
  type XyzTileSchedulerOptions,
} from "./XyzTileScheduler";
import {
  XyzTileCache,
  type XyzTileCacheOptions,
  type XyzTileLease,
} from "./XyzTileCache";

export {
  CompositeXyzTileProvider,
  XyzTileCache,
  XyzTileScheduler,
  providerContainsTile,
  validateXyzTileProvider,
};
export type {
  CompositeXyzTileProviderOptions,
  XyzScheduledTileResult,
  XyzTileBounds,
  XyzTileCacheOptions,
  XyzTileErrorResult,
  XyzTileEvent,
  XyzTileEventListener,
  XyzTileLease,
  XyzTileLoadedResult,
  XyzTileMissingResult,
  XyzTileProvider,
  XyzTileProviderResponse,
  XyzTileResult,
  XyzTileSchedulerOptions,
};

export const CARTO_VOYAGER: XyzTileProvider = {
  id: "carto-voyager",
  url: (z, x, y) =>
    `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  attribution: "© OpenStreetMap contributors © CARTO",
  minZoom: 0,
  maxZoom: 18,
  bounds: [-180, -85.05112878, 180, 85.05112878],
};

const TILE_SIZE = 256;
const BASE_TILE_GRID = 6;
const CAP_SEGMENTS_PER_TILE = 8;
const LOCAL_SURFACE_START = 1.6;
const FOCUS_SURFACE_START = 0.08;
const VIEW_OVERSCAN = 1.45;
const MAX_OVERVIEW_ZOOM = 4;
const DEFAULT_SURFACE_COLOR = "#b7d2e0";
const MAX_MERCATOR_LATITUDE = MathUtils.degToRad(85.05112878);
const EARTH_RADIUS_METERS = 6_378_137;

export type XyzAtlasLayerId = "context" | "base" | "detail" | "focus";

type AtlasLayer = {
  readonly id: XyzAtlasLayerId;
  readonly gridSize: number;
  readonly levelOffset: number;
  readonly surfaceOffset: number;
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly surface: Mesh;
  readonly priority: number;
  requestedKey: string;
  displayedKey: string;
  revision: number;
  abort: AbortController | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

export interface XyzGlobalOverviewOptions {
  readonly zoom?: number;
  readonly signal?: AbortSignal;
  readonly overviewProvider?: XyzTileProvider;
  readonly fallbackColor?: string;
  readonly scheduler?: XyzTileScheduler;
  readonly schedulerOptions?: XyzTileSchedulerOptions;
  readonly onTileEvent?: XyzTileEventListener;
  readonly onFallback?: (reason: string) => void;
}

export interface XyzLocalSurfaceOptions {
  readonly anchorLongitudeDegrees: number;
  readonly anchorLatitudeDegrees: number;
  /** Real-world metres represented by one local coordinate unit. */
  readonly metersPerWorldUnit: number;
  /** Circular tangent-patch radius. Defaults to no additional clipping. */
  readonly maxRadiusMeters?: number;
}

export interface XyzGlobeViewDescriptor {
  readonly cameraInGlobeSpace: Vector3;
  readonly verticalFovDegrees: number;
  readonly aspect: number;
  /** Normalized or non-normalized gaze ray in globe-local coordinates. */
  readonly gazeDirectionInGlobeSpace?: Vector3;
  /** Optional virtual altitude override in globe-local units. */
  readonly altitude?: number;
  /** Set, update, or explicitly clear the tangent detail surface. */
  readonly localSurface?: XyzLocalSurfaceOptions | null;
}

export interface XyzAtlasReadyEvent {
  readonly layer: XyzAtlasLayerId;
  readonly level: number;
  readonly baseX: number;
  readonly baseY: number;
  readonly gridSize: number;
  /** Borrowed until the next update of this layer; copy during the callback. */
  readonly canvas: HTMLCanvasElement;
  readonly loadedTiles: number;
  readonly missingTiles: number;
  readonly failedTiles: number;
  readonly complete: boolean;
  readonly localSurface: boolean;
}

export interface XyzAtlasErrorEvent {
  readonly layer: XyzAtlasLayerId;
  readonly key: string;
  readonly error: unknown;
}

export interface XyzTileGlobeOptions {
  readonly scheduler?: XyzTileScheduler;
  readonly schedulerOptions?: XyzTileSchedulerOptions;
  readonly onTileEvent?: XyzTileEventListener;
  readonly onAtlasReady?: (event: XyzAtlasReadyEvent) => void;
  readonly onAtlasError?: (event: XyzAtlasErrorEvent) => void;
  readonly localSurface?: XyzLocalSurfaceOptions;
}

/**
 * Reprojects a safe, bounded XYZ overview into the sphere's equirectangular UV
 * layout. The positional arguments remain compatible with v0.4. Providers
 * whose minimum zoom is above four must supply an `overviewProvider`; otherwise
 * a small solid fallback texture is returned instead of allocating a huge
 * source canvas.
 */
export function createGlobalOverviewTexture(
  provider?: XyzTileProvider,
  zoom?: number,
  signal?: AbortSignal,
): Promise<CanvasTexture>;
export function createGlobalOverviewTexture(
  provider: XyzTileProvider | undefined,
  options: XyzGlobalOverviewOptions,
): Promise<CanvasTexture>;
export async function createGlobalOverviewTexture(
  provider: XyzTileProvider = CARTO_VOYAGER,
  zoomOrOptions: number | XyzGlobalOverviewOptions = 3,
  legacySignal?: AbortSignal,
): Promise<CanvasTexture> {
  validateXyzTileProvider(provider);
  const options: XyzGlobalOverviewOptions =
    typeof zoomOrOptions === "number"
      ? { zoom: zoomOrOptions, signal: legacySignal }
      : zoomOrOptions;
  const sourceProvider =
    options.overviewProvider ?? provider.overviewProvider ?? provider;
  validateXyzTileProvider(sourceProvider);
  const fallbackColor =
    options.fallbackColor ??
    provider.overviewFallbackColor ??
    sourceProvider.overviewFallbackColor ??
    DEFAULT_SURFACE_COLOR;
  if (sourceProvider.minZoom > MAX_OVERVIEW_ZOOM) {
    try {
      options.onFallback?.(
        `Provider '${sourceProvider.id}' starts at zoom ${sourceProvider.minZoom}; an overview requires zoom <= ${MAX_OVERVIEW_ZOOM}`,
      );
    } catch {
      // A diagnostic callback cannot make the safe fallback unsafe.
    }
    return createFallbackOverviewTexture(fallbackColor);
  }

  const requestedZoom = Number.isFinite(options.zoom)
    ? Math.floor(options.zoom ?? 3)
    : 3;
  const level = MathUtils.clamp(
    requestedZoom,
    sourceProvider.minZoom,
    Math.min(sourceProvider.maxZoom, MAX_OVERVIEW_ZOOM),
  );
  const count = 2 ** level;
  const source = document.createElement("canvas");
  source.width = count * TILE_SIZE;
  source.height = count * TILE_SIZE;
  const sourceContext = source.getContext("2d");
  if (!sourceContext)
    throw new Error("Canvas 2D is required for the global XR map");
  fillCanvas(sourceContext, source.width, source.height, fallbackColor);

  const ownsScheduler = !options.scheduler;
  const scheduler =
    options.scheduler ??
    new XyzTileScheduler({
      ...options.schedulerOptions,
      onTileEvent: options.onTileEvent ?? options.schedulerOptions?.onTileEvent,
    });
  try {
    const cells = Array.from({ length: count * count }, (_, index) => ({
      x: index % count,
      y: Math.floor(index / count),
    })).sort(
      (left, right) =>
        centerDistance(left.x, left.y, count) -
        centerDistance(right.x, right.y, count),
    );
    await Promise.all(
      cells.map(async ({ x, y }, index) => {
        const result = await scheduler.request(sourceProvider, level, x, y, {
          priority: cells.length - index,
          signal: options.signal,
        });
        if (result.status !== "loaded") return;
        try {
          sourceContext.drawImage(
            result.lease.image,
            x * TILE_SIZE,
            y * TILE_SIZE,
            TILE_SIZE,
            TILE_SIZE,
          );
        } finally {
          result.lease.release();
        }
      }),
    );
    if (options.signal?.aborted) throw abortError("Global overview cancelled");
    return reprojectOverview(source, fallbackColor);
  } finally {
    if (ownsScheduler) scheduler.dispose();
  }
}

/** Curved multi-ring raster LOD with an optional camera-relative tangent patch. */
export class XyzTileGlobe {
  readonly group = new Group();
  /**
   * Owns the camera-scale tangent focus patch. It is parented to `group` by
   * default, but immersive hosts may reparent it while the curved rings remain
   * attached to the globe rig.
   */
  readonly localGroup = new Group();
  readonly scheduler: XyzTileScheduler;
  private readonly direction = new Vector3();
  private readonly gazeDirection = new Vector3();
  private readonly gazePoint = new Vector3();
  private readonly localFrame = new Matrix4();
  private readonly contextLayer: AtlasLayer;
  private readonly baseLayer: AtlasLayer;
  private readonly detailLayer: AtlasLayer;
  private readonly focusLayer: AtlasLayer;
  private readonly layers: readonly AtlasLayer[];
  private readonly ownsScheduler: boolean;
  private readonly onAtlasReady?: (event: XyzAtlasReadyEvent) => void;
  private readonly onAtlasError?: (event: XyzAtlasErrorEvent) => void;
  private localSurface: XyzLocalSurfaceOptions | null = null;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly radius: number,
    readonly provider: XyzTileProvider = CARTO_VOYAGER,
    options: XyzTileGlobeOptions = {},
  ) {
    if (!Number.isFinite(radius) || radius <= 0)
      throw new RangeError("XYZ globe radius must be positive");
    validateXyzTileProvider(provider);
    this.ownsScheduler = !options.scheduler;
    this.scheduler =
      options.scheduler ??
      new XyzTileScheduler({
        ...options.schedulerOptions,
        onTileEvent:
          options.onTileEvent ?? options.schedulerOptions?.onTileEvent,
      });
    this.onAtlasReady = options.onAtlasReady;
    this.onAtlasError = options.onAtlasError;
    this.group.add(this.localGroup);
    this.contextLayer = this.createLayer(
      "context",
      BASE_TILE_GRID,
      -2,
      0.00000002,
      -2,
      1,
      100,
    );
    this.baseLayer = this.createLayer(
      "base",
      BASE_TILE_GRID,
      0,
      0.00000004,
      -4,
      2,
      200,
    );
    this.detailLayer = this.createLayer("detail", 4, 1, 0.00000006, -6, 3, 300);
    this.focusLayer = this.createLayer("focus", 2, 2, 0.00000008, -8, 4, 400);
    this.layers = [
      this.contextLayer,
      this.baseLayer,
      this.detailLayer,
      this.focusLayer,
    ];
    if (options.localSurface) this.setLocalMode(options.localSurface);
  }

  update(
    cameraInGlobeSpace: Vector3,
    verticalFovDegrees: number,
    aspect: number,
  ): void;
  update(view: XyzGlobeViewDescriptor): void;
  update(
    cameraOrView: Vector3 | XyzGlobeViewDescriptor,
    legacyVerticalFovDegrees?: number,
    legacyAspect?: number,
  ): void {
    if (this.disposed || this.suspended) return;
    const view: XyzGlobeViewDescriptor =
      cameraOrView instanceof Vector3
        ? {
            cameraInGlobeSpace: cameraOrView,
            verticalFovDegrees: legacyVerticalFovDegrees ?? 65,
            aspect: legacyAspect ?? 1,
          }
        : cameraOrView;
    if (view.localSurface !== undefined) this.setLocalMode(view.localSurface);
    const distance = view.cameraInGlobeSpace.length();
    const altitude = Math.max(0, view.altitude ?? distance - this.radius);
    if (altitude >= LOCAL_SURFACE_START || distance <= 0) {
      for (const layer of this.layers) layer.surface.visible = false;
      return;
    }

    this.direction.copy(view.cameraInGlobeSpace).divideScalar(distance);
    if (
      view.gazeDirectionInGlobeSpace &&
      this.intersectGaze(
        view.cameraInGlobeSpace,
        view.gazeDirectionInGlobeSpace,
        this.gazePoint,
      )
    ) {
      this.direction.copy(this.gazePoint).normalize();
    }
    const longitude = Math.atan2(-this.direction.z, this.direction.x);
    const latitude = Math.asin(MathUtils.clamp(this.direction.y, -1, 1));
    const verticalFovDegrees = MathUtils.clamp(
      finiteOr(view.verticalFovDegrees, 65),
      10,
      170,
    );
    const aspect = MathUtils.clamp(finiteOr(view.aspect, 1), 0.1, 10);
    const fov = MathUtils.degToRad(verticalFovDegrees);
    const halfHeight = altitude * Math.tan(fov / 2) * VIEW_OVERSCAN;
    const halfWidth = halfHeight * Math.max(0.5, aspect);
    const angularHeight = Math.max(
      0.000001,
      2 * Math.atan(halfHeight / this.radius),
    );
    const angularWidth = Math.max(
      0.000001,
      2 * Math.atan(halfWidth / this.radius),
    );
    const mercatorStretch = 1 / Math.max(0.08, Math.cos(latitude));
    const baseTileDemand = Math.max(
      0.000000001,
      Math.max(angularWidth, angularHeight * mercatorStretch) / (2 * Math.PI),
    );
    const desiredZoom = Math.floor(
      Math.log2((BASE_TILE_GRID - 1.5) / baseTileDemand),
    );
    const minimumLocalZoom = Math.max(this.provider.minZoom, 2);
    const requestedLevel = MathUtils.clamp(
      desiredZoom,
      minimumLocalZoom,
      this.provider.maxZoom,
    );
    const level = availableLevelAt(
      this.provider,
      requestedLevel,
      minimumLocalZoom,
      longitude,
      latitude,
    );
    if (level === null) {
      for (const layer of this.layers) layer.surface.visible = false;
      return;
    }
    const requestedContextLevel = Math.max(
      minimumLocalZoom,
      level + this.contextLayer.levelOffset,
    );
    const requestedDetailLevel = Math.min(
      this.provider.maxZoom,
      level + this.detailLayer.levelOffset,
    );
    const requestedFocusLevel = Math.min(
      this.provider.maxZoom,
      level + this.focusLayer.levelOffset,
    );
    const contextLevel = availableLevelAt(
      this.provider,
      requestedContextLevel,
      minimumLocalZoom,
      longitude,
      latitude,
    );
    const detailLevel = availableLevelAt(
      this.provider,
      requestedDetailLevel,
      level,
      longitude,
      latitude,
    );
    const focusLevel = availableLevelAt(
      this.provider,
      requestedFocusLevel,
      level,
      longitude,
      latitude,
    );

    // Enqueue the gaze-centred inner rings first. The global scheduler still
    // enforces priorities across pending work from all layers and viewers.
    const focusAddsCoverage =
      focusLevel !== null &&
      (this.localSurface
        ? focusLevel >= level
        : focusLevel > (detailLevel ?? level));
    if (
      altitude < FOCUS_SURFACE_START &&
      focusAddsCoverage &&
      focusLevel !== null
    ) {
      this.updateLayer(this.focusLayer, focusLevel, longitude, latitude);
    } else {
      this.focusLayer.surface.visible = false;
    }
    if (detailLevel !== null && detailLevel > level)
      this.updateLayer(this.detailLayer, detailLevel, longitude, latitude);
    else this.detailLayer.surface.visible = false;
    this.updateLayer(this.baseLayer, level, longitude, latitude);
    if (contextLevel !== null && contextLevel < level)
      this.updateLayer(this.contextLayer, contextLevel, longitude, latitude);
    else this.contextLayer.surface.visible = false;
  }

  setLocalMode(options: XyzLocalSurfaceOptions | null): void {
    if (this.disposed) return;
    const normalized = options ? validateLocalSurface(options) : null;
    if (sameLocalSurface(this.localSurface, normalized)) return;
    this.localSurface = normalized;
    this.configureLocalGroup(normalized);
    this.invalidateLayer(this.focusLayer, true);
  }

  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    for (const layer of this.layers) {
      layer.revision += 1;
      layer.abort?.abort();
      layer.abort = null;
      if (layer.retryTimer) clearTimeout(layer.retryTimer);
      layer.retryTimer = null;
      layer.requestedKey = "";
    }
    if (this.ownsScheduler) this.scheduler.suspend();
  }

  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    if (this.ownsScheduler) this.scheduler.resume();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const layer of this.layers) {
      layer.revision += 1;
      layer.abort?.abort();
      if (layer.retryTimer) clearTimeout(layer.retryTimer);
      layer.texture.dispose();
      layer.surface.geometry.dispose();
      const material = layer.surface.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
      layer.surface.removeFromParent();
    }
    if (this.ownsScheduler) this.scheduler.dispose();
    this.localGroup.removeFromParent();
    this.group.removeFromParent();
  }

  private createLayer(
    id: XyzAtlasLayerId,
    gridSize: number,
    levelOffset: number,
    surfaceOffset: number,
    polygonOffset: number,
    renderOrder: number,
    priority: number,
  ): AtlasLayer {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_SIZE * gridSize;
    canvas.height = TILE_SIZE * gridSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is required for XR map tiles");
    fillCanvas(context, canvas.width, canvas.height, DEFAULT_SURFACE_COLOR);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const surface = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        map: texture,
        polygonOffset: true,
        polygonOffsetFactor: polygonOffset,
        polygonOffsetUnits: polygonOffset,
      }),
    );
    surface.visible = false;
    surface.renderOrder = renderOrder;
    if (id === "focus") this.localGroup.add(surface);
    else this.group.add(surface);
    return {
      id,
      gridSize,
      levelOffset,
      surfaceOffset,
      canvas,
      texture,
      surface,
      priority,
      requestedKey: "",
      displayedKey: "",
      revision: 0,
      abort: null,
      retryTimer: null,
    };
  }

  private updateLayer(
    layer: AtlasLayer,
    level: number,
    longitude: number,
    latitude: number,
  ): void {
    const count = 2 ** level;
    const centerX = longitudeToTileX(longitude, count);
    const centerY = latitudeToTileY(latitude, count);
    const baseX = Math.floor(centerX) - Math.floor(layer.gridSize / 2);
    const baseY = MathUtils.clamp(
      Math.floor(centerY) - Math.floor(layer.gridSize / 2),
      0,
      Math.max(0, count - layer.gridSize),
    );
    const localKey =
      layer.id === "focus" && this.localSurface
        ? localSurfaceKey(this.localSurface)
        : "globe";
    const key = `${level}/${baseX}/${baseY}/${layer.gridSize}/${localKey}`;
    if (key !== layer.requestedKey) {
      layer.requestedKey = key;
      void this.loadAtlas(layer, level, baseX, baseY, key).catch((error) => {
        if (this.disposed || layer.requestedKey !== key) return;
        layer.abort = null;
        this.scheduleLayerRetry(layer, key, Date.now() + 1_000);
        try {
          this.onAtlasError?.({ layer: layer.id, key, error });
        } catch {
          // Host telemetry must not break the render loop.
        }
      });
    }
    layer.surface.visible = layer.displayedKey.length > 0;
  }

  private async loadAtlas(
    layer: AtlasLayer,
    level: number,
    baseX: number,
    baseY: number,
    key: string,
  ): Promise<void> {
    const revision = ++layer.revision;
    layer.abort?.abort();
    if (layer.retryTimer) clearTimeout(layer.retryTimer);
    layer.retryTimer = null;
    const abort = new AbortController();
    layer.abort = abort;
    const count = 2 ** level;
    const staging = document.createElement("canvas");
    staging.width = layer.canvas.width;
    staging.height = layer.canvas.height;
    const context = staging.getContext("2d");
    if (!context) return;
    fillCanvas(context, staging.width, staging.height, DEFAULT_SURFACE_COLOR);

    const cells = Array.from(
      { length: layer.gridSize * layer.gridSize },
      (_, index) => {
        const column = index % layer.gridSize;
        const row = Math.floor(index / layer.gridSize);
        return {
          column,
          row,
          distance: centerDistance(column, row, layer.gridSize),
        };
      },
    ).sort((left, right) => left.distance - right.distance);
    let loaded = 0;
    let missing = 0;
    let failed = 0;
    let earliestRetry = Number.POSITIVE_INFINITY;
    await Promise.all(
      cells.map(async ({ column, row, distance }) => {
        const unwrappedX = baseX + column;
        const x = wrap(unwrappedX, count);
        const y = baseY + row;
        if (y < 0 || y >= count) {
          missing += 1;
          return;
        }
        try {
          const result = await this.scheduler.request(
            this.provider,
            level,
            x,
            y,
            {
              priority: layer.priority - distance,
              signal: abort.signal,
            },
          );
          if (
            this.disposed ||
            revision !== layer.revision ||
            abort.signal.aborted
          ) {
            if (result.status === "loaded") result.lease.release();
            return;
          }
          if (result.status === "loaded") {
            try {
              context.drawImage(
                result.lease.image,
                column * TILE_SIZE,
                row * TILE_SIZE,
                TILE_SIZE,
                TILE_SIZE,
              );
              loaded += 1;
            } finally {
              result.lease.release();
            }
          } else if (result.status === "missing") {
            missing += 1;
            earliestRetry = Math.min(earliestRetry, result.retryAt);
          } else {
            failed += 1;
            earliestRetry = Math.min(earliestRetry, result.retryAt);
          }
        } catch (error) {
          if (!isAbortError(error)) failed += 1;
        }
      }),
    );

    if (this.disposed || revision !== layer.revision || abort.signal.aborted)
      return;
    layer.abort = null;
    // A transiently incomplete replacement must never blank a previously good
    // atlas. First load may still show the successfully available subset.
    const preservePrevious = failed > 0 && layer.displayedKey.length > 0;
    if (!preservePrevious && loaded > 0) {
      const targetContext = layer.canvas.getContext("2d");
      if (!targetContext) return;
      targetContext.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      targetContext.drawImage(staging, 0, 0);
      layer.texture.needsUpdate = true;
      const previous = layer.surface.geometry;
      layer.surface.geometry = this.createAtlasGeometry(
        layer,
        level,
        baseX,
        baseY,
        layer.gridSize,
        layer.surfaceOffset,
      );
      previous.dispose();
      layer.displayedKey = key;
      layer.surface.visible = true;
      try {
        this.onAtlasReady?.({
          layer: layer.id,
          level,
          baseX,
          baseY,
          gridSize: layer.gridSize,
          canvas: layer.canvas,
          loadedTiles: loaded,
          missingTiles: missing,
          failedTiles: failed,
          complete: missing === 0 && failed === 0,
          localSurface: layer.id === "focus" && this.localSurface !== null,
        });
      } catch {
        // Atlas observers are isolated from streaming and GPU state.
      }
    }
    if (loaded === 0 && layer.displayedKey.length === 0)
      layer.surface.visible = false;
    this.scheduleLayerRetry(layer, key, earliestRetry);
  }

  private scheduleLayerRetry(
    layer: AtlasLayer,
    key: string,
    retryAt: number,
  ): void {
    if (!Number.isFinite(retryAt) || this.disposed || this.suspended) return;
    const delay = MathUtils.clamp(retryAt - Date.now(), 50, 60_000);
    layer.retryTimer = setTimeout(() => {
      layer.retryTimer = null;
      if (!this.disposed && !this.suspended && layer.requestedKey === key)
        layer.requestedKey = "";
    }, delay);
  }

  private createAtlasGeometry(
    layer: AtlasLayer,
    level: number,
    baseX: number,
    baseY: number,
    gridSize: number,
    surfaceOffset: number,
  ): BufferGeometry {
    const local = layer.id === "focus" ? this.localSurface : null;
    return local
      ? this.createLocalAtlasGeometry(
          level,
          baseX,
          baseY,
          gridSize,
          surfaceOffset,
          local,
        )
      : this.createCurvedAtlasGeometry(
          level,
          baseX,
          baseY,
          gridSize,
          surfaceOffset,
        );
  }

  private createCurvedAtlasGeometry(
    level: number,
    baseX: number,
    baseY: number,
    gridSize: number,
    surfaceOffset: number,
  ): BufferGeometry {
    const count = 2 ** level;
    const segments = gridSize * CAP_SEGMENTS_PER_TILE;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const radius = this.radius + surfaceOffset;
    for (let row = 0; row <= segments; row += 1) {
      const v = row / segments;
      const latitude = tileYToLatitude(baseY + v * gridSize, count);
      const cosLatitude = Math.cos(latitude);
      for (let column = 0; column <= segments; column += 1) {
        const u = column / segments;
        const longitude =
          ((baseX + u * gridSize) / count) * 2 * Math.PI - Math.PI;
        positions.push(
          radius * cosLatitude * Math.cos(longitude),
          radius * Math.sin(latitude),
          -radius * cosLatitude * Math.sin(longitude),
        );
        uvs.push(u, 1 - v);
      }
    }
    pushGridIndices(indices, segments);
    return finalizeGeometry(positions, uvs, indices);
  }

  private createLocalAtlasGeometry(
    level: number,
    baseX: number,
    baseY: number,
    gridSize: number,
    _surfaceOffset: number,
    local: XyzLocalSurfaceOptions,
  ): BufferGeometry {
    const count = 2 ** level;
    const segments = gridSize * CAP_SEGMENTS_PER_TILE;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const included: boolean[] = [];
    const anchorLongitude = MathUtils.degToRad(local.anchorLongitudeDegrees);
    const anchorLatitude = MathUtils.degToRad(local.anchorLatitudeDegrees);
    const cosAnchor = Math.cos(anchorLatitude);
    const maximumRadius = local.maxRadiusMeters ?? Number.POSITIVE_INFINITY;
    for (let row = 0; row <= segments; row += 1) {
      const v = row / segments;
      const latitude = tileYToLatitude(baseY + v * gridSize, count);
      for (let column = 0; column <= segments; column += 1) {
        const u = column / segments;
        const longitude =
          ((baseX + u * gridSize) / count) * 2 * Math.PI - Math.PI;
        const eastMeters =
          normalizeLongitude(longitude - anchorLongitude) *
          EARTH_RADIUS_METERS *
          cosAnchor;
        const northMeters = (latitude - anchorLatitude) * EARTH_RADIUS_METERS;
        // Camera-scale ENU coordinates: +X east, +Y up, and -Z north. The
        // localGroup transform anchors this near-origin patch on the globe by
        // default and may be replaced by a host after reparenting.
        positions.push(
          eastMeters / local.metersPerWorldUnit,
          0,
          -northMeters / local.metersPerWorldUnit,
        );
        uvs.push(u, 1 - v);
        included.push(Math.hypot(eastMeters, northMeters) <= maximumRadius);
      }
    }
    pushGridIndices(indices, segments, included);
    return finalizeGeometry(positions, uvs, indices);
  }

  private intersectGaze(
    origin: Vector3,
    gaze: Vector3,
    result: Vector3,
  ): boolean {
    if (gaze.lengthSq() < 0.000000001) return false;
    this.gazeDirection.copy(gaze).normalize();
    const projection = origin.dot(this.gazeDirection);
    const discriminant =
      projection * projection - (origin.lengthSq() - this.radius * this.radius);
    if (discriminant < 0) return false;
    const near = -projection - Math.sqrt(discriminant);
    const far = -projection + Math.sqrt(discriminant);
    const distance = near > 0 ? near : far;
    if (distance <= 0) return false;
    result.copy(origin).addScaledVector(this.gazeDirection, distance);
    return true;
  }

  private invalidateLayer(layer: AtlasLayer, hide: boolean): void {
    layer.revision += 1;
    layer.abort?.abort();
    layer.abort = null;
    if (layer.retryTimer) clearTimeout(layer.retryTimer);
    layer.retryTimer = null;
    layer.requestedKey = "";
    layer.displayedKey = "";
    if (hide) layer.surface.visible = false;
  }

  private configureLocalGroup(options: XyzLocalSurfaceOptions | null): void {
    if (!options) {
      this.localGroup.position.set(0, 0, 0);
      this.localGroup.quaternion.identity();
      this.localGroup.scale.setScalar(1);
      return;
    }
    const longitude = MathUtils.degToRad(options.anchorLongitudeDegrees);
    const latitude = MathUtils.degToRad(options.anchorLatitudeDegrees);
    const cosLatitude = Math.cos(latitude);
    const radial = new Vector3(
      cosLatitude * Math.cos(longitude),
      Math.sin(latitude),
      -cosLatitude * Math.sin(longitude),
    );
    const east = new Vector3(-Math.sin(longitude), 0, -Math.cos(longitude));
    const north = new Vector3(
      -Math.sin(latitude) * Math.cos(longitude),
      Math.cos(latitude),
      Math.sin(latitude) * Math.sin(longitude),
    );
    this.localFrame.makeBasis(east, radial, north.multiplyScalar(-1));
    this.localGroup.position
      .copy(radial)
      .multiplyScalar(this.radius + this.focusLayer.surfaceOffset);
    this.localGroup.quaternion.setFromRotationMatrix(this.localFrame);
    this.localGroup.scale.setScalar(1);
  }
}

function createFallbackOverviewTexture(color: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 8;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is required for the global XR map");
  fillCanvas(context, canvas.width, canvas.height, color);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function reprojectOverview(
  source: HTMLCanvasElement,
  fallbackColor: string,
): CanvasTexture {
  const target = document.createElement("canvas");
  target.width = 2048;
  target.height = 1024;
  const targetContext = target.getContext("2d");
  if (!targetContext)
    throw new Error("Canvas 2D is required for the global XR map");
  fillCanvas(targetContext, target.width, target.height, fallbackColor);
  for (let row = 0; row < target.height; row += 1) {
    const latitude = Math.PI / 2 - ((row + 0.5) / target.height) * Math.PI;
    if (Math.abs(latitude) > MAX_MERCATOR_LATITUDE) continue;
    const sourceY = latitudeToTileY(latitude, 1) * source.height;
    targetContext.drawImage(
      source,
      0,
      sourceY,
      source.width,
      1,
      0,
      row,
      target.width,
      1,
    );
  }
  const texture = new CanvasTexture(target);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function fillCanvas(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string,
): void {
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
}

function pushGridIndices(
  indices: number[],
  segments: number,
  included?: readonly boolean[],
): void {
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * (segments + 1) + column;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      if (
        included &&
        !(included[a] && included[b] && included[c] && included[d])
      )
        continue;
      indices.push(a, c, b, b, c, d);
    }
  }
}

function finalizeGeometry(
  positions: number[],
  uvs: number[],
  indices: number[],
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function validateLocalSurface(
  options: XyzLocalSurfaceOptions,
): XyzLocalSurfaceOptions {
  if (
    !Number.isFinite(options.anchorLongitudeDegrees) ||
    options.anchorLongitudeDegrees < -180 ||
    options.anchorLongitudeDegrees > 180
  ) {
    throw new RangeError(
      "Local surface longitude must be between -180 and 180 degrees",
    );
  }
  if (
    !Number.isFinite(options.anchorLatitudeDegrees) ||
    Math.abs(options.anchorLatitudeDegrees) > 85.05112878
  ) {
    throw new RangeError(
      "Local surface latitude exceeds Web-Mercator coverage",
    );
  }
  if (
    !Number.isFinite(options.metersPerWorldUnit) ||
    options.metersPerWorldUnit <= 0
  ) {
    throw new RangeError("Local surface metersPerWorldUnit must be positive");
  }
  if (
    options.maxRadiusMeters !== undefined &&
    (!Number.isFinite(options.maxRadiusMeters) || options.maxRadiusMeters <= 0)
  ) {
    throw new RangeError("Local surface maxRadiusMeters must be positive");
  }
  return { ...options };
}

function sameLocalSurface(
  left: XyzLocalSurfaceOptions | null,
  right: XyzLocalSurfaceOptions | null,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.anchorLongitudeDegrees === right.anchorLongitudeDegrees &&
      left.anchorLatitudeDegrees === right.anchorLatitudeDegrees &&
      left.metersPerWorldUnit === right.metersPerWorldUnit &&
      left.maxRadiusMeters === right.maxRadiusMeters,
    )
  );
}

function localSurfaceKey(options: XyzLocalSurfaceOptions): string {
  return `local/${options.anchorLongitudeDegrees}/${options.anchorLatitudeDegrees}/${options.metersPerWorldUnit}/${options.maxRadiusMeters ?? "all"}`;
}

function centerDistance(x: number, y: number, size: number): number {
  const center = (size - 1) / 2;
  return (x - center) ** 2 + (y - center) ** 2;
}

function availableLevelAt(
  provider: XyzTileProvider,
  requestedLevel: number,
  minimumLevel: number,
  longitude: number,
  latitude: number,
): number | null {
  for (let level = requestedLevel; level >= minimumLevel; level -= 1) {
    const count = 2 ** level;
    const x = wrap(Math.floor(longitudeToTileX(longitude, count)), count);
    const y = Math.min(
      count - 1,
      Math.max(0, Math.floor(latitudeToTileY(latitude, count))),
    );
    try {
      if (providerContainsTile(provider, level, x, y)) return level;
    } catch {
      // Let the scheduler surface a provider failure at the requested LOD.
      return level;
    }
  }
  return null;
}

function longitudeToTileX(longitude: number, count: number): number {
  return ((longitude + Math.PI) / (2 * Math.PI)) * count;
}

function latitudeToTileY(latitude: number, count: number): number {
  const clamped = MathUtils.clamp(
    latitude,
    -MAX_MERCATOR_LATITUDE,
    MAX_MERCATOR_LATITUDE,
  );
  return ((1 - Math.asinh(Math.tan(clamped)) / Math.PI) / 2) * count;
}

function tileYToLatitude(tileY: number, count: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / count)));
}

function normalizeLongitude(longitude: number): number {
  return (
    ((((longitude + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) -
    Math.PI
  );
}

function wrap(value: number, count: number): number {
  return ((value % count) + count) % count;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
