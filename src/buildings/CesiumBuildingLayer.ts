import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Math as CesiumMath,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  type Viewer,
} from 'cesium';
import type { BuildingFootprint, BuildingPosition, BuildingTileProvider } from './BuildingProvider';

const MAX_CAMERA_HEIGHT_METERS = 12_000;
const TILE_RADIUS = 2;
const DEFAULT_COLOR = Color.fromCssColorString('#d8c8ad');

type TileRecord = {
  readonly abort: AbortController;
  primitive?: Primitive;
};

/** Streams the same footprint tiles used by XR into Cesium primitives. */
export class CesiumBuildingLayer {
  private readonly tiles = new Map<string, TileRecord>();
  private readonly removeUpdateListener: () => void;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    readonly provider: BuildingTileProvider,
  ) {
    // preRender keeps the tile window aligned during low-altitude motion;
    // Camera.changed's percentage threshold is too coarse at street scale.
    this.removeUpdateListener = viewer.scene.preRender.addEventListener(this.update);
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeUpdateListener();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  private readonly update = (): void => {
    if (this.disposed) return;
    const position = this.viewer.camera.positionCartographic;
    if (!position || position.height > MAX_CAMERA_HEIGHT_METERS || position.height < 0) {
      for (const key of [...this.tiles.keys()]) this.removeTile(key);
      return;
    }
    const level = this.provider.maxZoom;
    const count = 2 ** level;
    const centerX = longitudeToTileX(position.longitude, count);
    const centerY = latitudeToTileY(position.latitude, count);
    const desired = new Set<string>();
    for (let row = -TILE_RADIUS; row <= TILE_RADIUS; row += 1) {
      const y = centerY + row;
      if (y < 0 || y >= count) continue;
      for (let column = -TILE_RADIUS; column <= TILE_RADIUS; column += 1) {
        const x = wrap(centerX + column, count);
        const key = `${level}/${x}/${y}`;
        desired.add(key);
        if (!this.tiles.has(key)) this.loadTile(key, level, x, y);
      }
    }
    for (const key of [...this.tiles.keys()]) if (!desired.has(key)) this.removeTile(key);
  };

  private loadTile(key: string, z: number, x: number, y: number): void {
    const record: TileRecord = { abort: new AbortController() };
    this.tiles.set(key, record);
    void this.provider.loadTile(z, x, y, record.abort.signal)
      .then((buildings) => {
        if (this.disposed || record.abort.signal.aborted || this.tiles.get(key) !== record) return;
        const primitive = createPrimitive(buildings);
        if (!primitive) return;
        record.primitive = this.viewer.scene.primitives.add(primitive);
      })
      .catch(() => {
        if (record.abort.signal.aborted) return;
        if (this.tiles.get(key) === record) this.tiles.delete(key);
        this.scheduleRetry();
      });
  }

  private removeTile(key: string): void {
    const record = this.tiles.get(key);
    if (!record) return;
    record.abort.abort();
    if (record.primitive) this.viewer.scene.primitives.remove(record.primitive);
    this.tiles.delete(key);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.update();
    }, 2_000);
  }
}

function createPrimitive(buildings: ReadonlyArray<BuildingFootprint>): Primitive | null {
  const instances: GeometryInstance[] = [];
  for (const building of buildings) {
    const hierarchy = createHierarchy(building.rings);
    if (!hierarchy) continue;
    const color = building.color
      ? Color.fromCssColorString(normalizeColor(building.color)) ?? DEFAULT_COLOR
      : DEFAULT_COLOR;
    instances.push(new GeometryInstance({
      id: building.id,
      geometry: new PolygonGeometry({
        polygonHierarchy: hierarchy,
        height: building.heightMeters,
        extrudedHeight: building.minHeightMeters,
        closeTop: true,
        closeBottom: true,
        vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(color),
      },
    }));
  }
  if (instances.length === 0) return null;
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
    asynchronous: true,
  });
}

function createHierarchy(rings: ReadonlyArray<ReadonlyArray<BuildingPosition>>): PolygonHierarchy | null {
  const outer = positionsForRing(rings[0]);
  if (outer.length < 3) return null;
  const holes = rings.slice(1)
    .map((ring) => positionsForRing(ring))
    .filter((positions) => positions.length >= 3)
    .map((positions) => new PolygonHierarchy(positions));
  return new PolygonHierarchy(outer, holes);
}

function positionsForRing(ring: ReadonlyArray<BuildingPosition>): Cartesian3[] {
  const end = ring.length > 1 && samePosition(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
  return ring.slice(0, end).map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude));
}

function samePosition(left: BuildingPosition, right: BuildingPosition): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function normalizeColor(value: string): string {
  return /^[0-9a-f]{3,8}$/i.test(value) ? `#${value}` : value;
}

function longitudeToTileX(longitude: number, count: number): number {
  return wrap(Math.floor((longitude + Math.PI) / (2 * Math.PI) * count), count);
}

function latitudeToTileY(latitude: number, count: number): number {
  const clamped = CesiumMath.clamp(latitude, -CesiumMath.toRadians(85.05112878), CesiumMath.toRadians(85.05112878));
  return Math.min(count - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(clamped)) / Math.PI) / 2 * count)));
}

function wrap(value: number, count: number): number {
  return ((value % count) + count) % count;
}
