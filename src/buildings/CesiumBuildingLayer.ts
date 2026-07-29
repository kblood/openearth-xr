import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  type Viewer,
} from "cesium";
import {
  BuildingProviderError,
  type BuildingFootprint,
  type BuildingPosition,
  type BuildingTileProvider,
} from "./BuildingProvider";
import {
  budgetBuildingFootprints,
  BuildingTaskQueue,
  buildingRetryDelay,
  selectBuildingTiles,
  type BuildingTileSelection,
  type SelectedBuildingTile,
} from "./BuildingStreaming";

const MAX_CAMERA_HEIGHT_METERS = 12_000;
const DEFAULT_COLOR = Color.fromCssColorString("#d8c8ad");

export interface CesiumBuildingLayerOptions {
  readonly maxTiles?: number;
  readonly concurrency?: number;
  readonly maxFootprintsPerTile?: number;
  readonly maxVerticesPerTile?: number;
  readonly maxTrianglesPerTile?: number;
  readonly minAreaSquareMeters?: number;
}

type TileRecord = {
  readonly tile: SelectedBuildingTile;
  controller: AbortController | null;
  state: "queued" | "loading" | "ready" | "failed";
  failures: number;
  retryAt: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  primitive?: Primitive;
};

/** Streams view-budgeted footprint tiles into Cesium primitives. */
export class CesiumBuildingLayer {
  private readonly tiles = new Map<string, TileRecord>();
  private readonly removeUpdateListener: () => void;
  private readonly queue: BuildingTaskQueue;
  private readonly density;
  private readonly maxTiles: number;
  private selection: BuildingTileSelection | null = null;
  private active = false;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    readonly provider: BuildingTileProvider,
    options: CesiumBuildingLayerOptions = {},
  ) {
    this.maxTiles = Math.max(1, Math.floor(options.maxTiles ?? 25));
    this.queue = new BuildingTaskQueue(options.concurrency ?? 4);
    this.density = {
      maxFootprints: options.maxFootprintsPerTile ?? 5_000,
      maxVertices: options.maxVerticesPerTile ?? 250_000,
      maxTriangles: options.maxTrianglesPerTile ?? 140_000,
      minAreaSquareMeters: options.minAreaSquareMeters ?? 4,
    };
    this.removeUpdateListener = viewer.scene.preRender.addEventListener(
      this.update,
    );
    this.update();
  }

  suspend(): void {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    this.active = false;
    this.selection = null;
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    this.viewer.scene.requestRender();
  }

  resume(): void {
    if (!this.suspended || this.disposed) return;
    this.suspended = false;
    this.update();
    this.viewer.scene.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeUpdateListener();
    this.queue.dispose();
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  private readonly update = (): void => {
    if (this.disposed || this.suspended) return;
    const position = this.viewer.camera.positionCartographic;
    const height = position?.height ?? Number.POSITIVE_INFINITY;
    const wasActive = this.active;
    const enterHeight = MAX_CAMERA_HEIGHT_METERS * 0.9;
    const leaveHeight = MAX_CAMERA_HEIGHT_METERS * 1.1;
    const shouldBeActive =
      position &&
      height >= 0 &&
      (this.active ? height <= leaveHeight : height <= enterHeight);
    if (!shouldBeActive) {
      if (this.active || this.tiles.size > 0) {
        this.active = false;
        this.selection = null;
        for (const key of [...this.tiles.keys()]) this.removeTile(key);
      }
      return;
    }
    this.active = true;
    const frustum = this.viewer.camera.frustum as unknown as {
      fovy?: number;
      aspectRatio?: number;
    };
    const selection = selectBuildingTiles(this.provider, {
      longitudeRadians: position.longitude,
      latitudeRadians: position.latitude,
      altitudeMeters: Math.max(1, height),
      verticalFovRadians: frustum.fovy ?? Math.PI / 3,
      aspect: frustum.aspectRatio ?? 1,
      minZoom: this.provider.minZoom,
      maxZoom: this.provider.maxZoom,
      maxTiles: this.maxTiles,
      previousZoom: this.selection?.level,
    });
    if (
      selection.coveredSpanMeters <
      selection.viewSpanMeters * (wasActive ? 0.75 : 0.9)
    ) {
      this.active = false;
      this.selection = null;
      for (const key of [...this.tiles.keys()]) this.removeTile(key);
      return;
    }
    if (selection.signature === this.selection?.signature) {
      this.retryFailedTiles(performance.now());
      return;
    }
    this.selection = selection;
    const desired = new Set(selection.tiles.map((tile) => tile.key));
    for (const key of [...this.tiles.keys()])
      if (!desired.has(key)) this.removeTile(key);
    for (const tile of selection.tiles) {
      if (this.tiles.has(tile.key)) continue;
      const record: TileRecord = {
        tile,
        controller: null,
        state: "queued",
        failures: 0,
        retryAt: 0,
      };
      this.tiles.set(tile.key, record);
      this.requestTile(record);
    }
    this.retryFailedTiles(performance.now());
  };

  private requestTile(record: TileRecord): void {
    if (
      this.disposed ||
      this.suspended ||
      this.tiles.get(record.tile.key) !== record
    )
      return;
    const controller = new AbortController();
    if (record.retryTimer) {
      clearTimeout(record.retryTimer);
      record.retryTimer = undefined;
    }
    record.controller = controller;
    record.state = "queued";
    void this.queue
      .schedule(record.tile.priority, controller, async (signal) => {
        record.state = "loading";
        return this.provider.loadTile(
          record.tile.z,
          record.tile.x,
          record.tile.y,
          signal,
        );
      })
      .then((buildings) => {
        if (
          this.disposed ||
          this.suspended ||
          controller.signal.aborted ||
          this.tiles.get(record.tile.key) !== record
        )
          return;
        const primitive = createPrimitive(buildings, this.density);
        if (primitive)
          record.primitive = this.viewer.scene.primitives.add(primitive);
        record.controller = null;
        record.state = "ready";
        record.failures = 0;
        record.retryAt = 0;
        this.viewer.scene.requestRender();
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          this.tiles.get(record.tile.key) !== record
        )
          return;
        record.controller = null;
        record.state = "failed";
        record.failures += 1;
        if (isRetryable(error)) {
          const delay = buildingRetryDelay(record.failures);
          record.retryAt = performance.now() + delay;
          record.retryTimer = setTimeout(() => {
            record.retryTimer = undefined;
            if (
              !this.disposed &&
              !this.suspended &&
              this.tiles.get(record.tile.key) === record
            ) {
              record.retryAt = 0;
              this.viewer.scene.requestRender();
            }
          }, delay);
        } else {
          record.retryAt = Number.POSITIVE_INFINITY;
        }
        this.viewer.scene.requestRender();
      });
  }

  private retryFailedTiles(now: number): void {
    for (const record of this.tiles.values()) {
      if (record.state === "failed" && now >= record.retryAt)
        this.requestTile(record);
    }
  }

  private removeTile(key: string): void {
    const record = this.tiles.get(key);
    if (!record) return;
    record.controller?.abort();
    if (record.retryTimer) clearTimeout(record.retryTimer);
    if (record.primitive) this.viewer.scene.primitives.remove(record.primitive);
    this.tiles.delete(key);
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender();
  }
}

function createPrimitive(
  buildings: ReadonlyArray<BuildingFootprint>,
  density: Parameters<typeof budgetBuildingFootprints>[1],
): Primitive | null {
  const instances: GeometryInstance[] = [];
  for (const { footprint: building } of budgetBuildingFootprints(
    buildings,
    density,
  )) {
    const hierarchy = createHierarchy(building.rings);
    if (!hierarchy) continue;
    const color = building.color
      ? (Color.fromCssColorString(normalizeColor(building.color)) ??
        DEFAULT_COLOR)
      : DEFAULT_COLOR;
    instances.push(
      new GeometryInstance({
        id: building.id,
        geometry: new PolygonGeometry({
          polygonHierarchy: hierarchy,
          height: building.heightMeters,
          extrudedHeight: building.minHeightMeters,
          closeTop: true,
          closeBottom: true,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
      }),
    );
  }
  if (instances.length === 0) return null;
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({
      closed: true,
      translucent: false,
    }),
    asynchronous: true,
  });
}

function createHierarchy(
  rings: ReadonlyArray<ReadonlyArray<BuildingPosition>>,
): PolygonHierarchy | null {
  const outer = positionsForRing(rings[0]);
  if (outer.length < 3) return null;
  const holes = rings
    .slice(1)
    .map(positionsForRing)
    .filter((positions) => positions.length >= 3)
    .map((positions) => new PolygonHierarchy(positions));
  return new PolygonHierarchy(outer, holes);
}

function positionsForRing(ring: ReadonlyArray<BuildingPosition>): Cartesian3[] {
  const end =
    ring.length > 1 && samePosition(ring[0], ring[ring.length - 1])
      ? ring.length - 1
      : ring.length;
  return ring
    .slice(0, end)
    .map(([longitude, latitude]) =>
      Cartesian3.fromDegrees(longitude, latitude),
    );
}

function samePosition(
  left: BuildingPosition,
  right: BuildingPosition,
): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function normalizeColor(value: string): string {
  return /^[0-9a-f]{3,8}$/i.test(value) ? `#${value}` : value;
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof BuildingProviderError) || error.retryable;
}
