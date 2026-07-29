import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShapeUtils,
  Vector2,
  Vector3,
} from 'three';
import type { BuildingFootprint, BuildingPosition, BuildingTileProvider } from './BuildingProvider';

const EARTH_RADIUS_METERS = 6_378_137;
const MAX_BUILDING_ALTITUDE = 0.004;
const TILE_RADIUS = 2;
const SURFACE_OFFSET = 0.00000008;
const DEFAULT_COLOR = new Color('#d8c8ad');

type TileRecord = {
  readonly abort: AbortController;
  mesh?: Mesh;
  retry?: ReturnType<typeof setTimeout>;
};

/** Curved, globe-native building extrusion for the Three.js/WebXR path. */
export class XrBuildingLayer {
  readonly group = new Group();
  private readonly tiles = new Map<string, TileRecord>();
  private readonly direction = new Vector3();
  private disposed = false;

  constructor(
    private readonly radius: number,
    readonly provider: BuildingTileProvider,
  ) {
    this.group.renderOrder = 10;
  }

  update(cameraInGlobeSpace: Vector3): void {
    if (this.disposed) return;
    const distance = cameraInGlobeSpace.length();
    const altitude = distance - this.radius;
    if (distance <= 0 || altitude < 0 || altitude > MAX_BUILDING_ALTITUDE) {
      this.group.visible = false;
      for (const key of [...this.tiles.keys()]) this.removeTile(key);
      return;
    }
    this.group.visible = true;
    this.direction.copy(cameraInGlobeSpace).divideScalar(distance);
    const longitude = Math.atan2(-this.direction.z, this.direction.x);
    const latitude = Math.asin(Math.min(1, Math.max(-1, this.direction.y)));
    const level = this.provider.maxZoom;
    const count = 2 ** level;
    const centerX = longitudeToTileX(longitude, count);
    const centerY = latitudeToTileY(latitude, count);
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    this.group.removeFromParent();
  }

  private loadTile(key: string, z: number, x: number, y: number): void {
    const record: TileRecord = { abort: new AbortController() };
    this.tiles.set(key, record);
    void this.provider.loadTile(z, x, y, record.abort.signal)
      .then((buildings) => {
        if (this.disposed || record.abort.signal.aborted || this.tiles.get(key) !== record) return;
        const geometry = createBuildingGeometry(buildings, this.radius);
        if (!geometry) return;
        const mesh = new Mesh(geometry, new MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.82,
          metalness: 0,
          side: DoubleSide,
        }));
        mesh.renderOrder = 10;
        record.mesh = mesh;
        this.group.add(mesh);
      })
      .catch(() => {
        if (record.abort.signal.aborted) return;
        if (this.tiles.get(key) !== record) return;
        record.retry = setTimeout(() => {
          if (this.tiles.get(key) === record) this.tiles.delete(key);
        }, 2_000);
      });
  }

  private removeTile(key: string): void {
    const record = this.tiles.get(key);
    if (!record) return;
    record.abort.abort();
    if (record.retry) clearTimeout(record.retry);
    if (record.mesh) {
      record.mesh.removeFromParent();
      record.mesh.geometry.dispose();
      const material = record.mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
    this.tiles.delete(key);
  }

}

export function createBuildingGeometry(
  buildings: ReadonlyArray<BuildingFootprint>,
  radius: number,
): BufferGeometry | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const metersToWorld = radius / EARTH_RADIUS_METERS;
  for (const building of buildings) {
    const rings = building.rings.map(openRing).filter((ring) => ring.length >= 3);
    if (rings.length === 0) continue;
    const color = parseColor(building.color);
    const baseRadius = radius + SURFACE_OFFSET + building.minHeightMeters * metersToWorld;
    const topRadius = radius + SURFACE_OFFSET + building.heightMeters * metersToWorld;
    const flatRings = rings.map((ring) => ring.map(([longitude, latitude]) => new Vector2(longitude, latitude)));
    const roofStart = positions.length / 3;
    for (const ring of rings) {
      for (const position of ring) pushGlobeVertex(positions, colors, position, topRadius, color);
    }
    for (const face of ShapeUtils.triangulateShape(flatRings[0], flatRings.slice(1))) {
      indices.push(roofStart + face[0], roofStart + face[1], roofStart + face[2]);
    }
    for (const ring of rings) {
      for (let index = 0; index < ring.length; index += 1) {
        const next = (index + 1) % ring.length;
        const sideStart = positions.length / 3;
        pushGlobeVertex(positions, colors, ring[index], baseRadius, color);
        pushGlobeVertex(positions, colors, ring[next], baseRadius, color);
        pushGlobeVertex(positions, colors, ring[index], topRadius, color);
        pushGlobeVertex(positions, colors, ring[next], topRadius, color);
        indices.push(sideStart, sideStart + 1, sideStart + 2, sideStart + 2, sideStart + 1, sideStart + 3);
      }
    }
  }
  if (indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function openRing(ring: ReadonlyArray<BuildingPosition>): ReadonlyArray<BuildingPosition> {
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
    return ring.slice(0, -1);
  }
  return ring;
}

function pushGlobeVertex(
  positions: number[],
  colors: number[],
  [longitudeDegrees, latitudeDegrees]: BuildingPosition,
  radius: number,
  color: Color,
): void {
  const longitude = longitudeDegrees * Math.PI / 180;
  const latitude = latitudeDegrees * Math.PI / 180;
  const cosLatitude = Math.cos(latitude);
  positions.push(
    radius * cosLatitude * Math.cos(longitude),
    radius * Math.sin(latitude),
    -radius * cosLatitude * Math.sin(longitude),
  );
  colors.push(color.r, color.g, color.b);
}

function parseColor(value: string | undefined): Color {
  if (!value) return DEFAULT_COLOR;
  try {
    return new Color(/^[0-9a-f]{3,8}$/i.test(value) ? `#${value}` : value);
  } catch {
    return DEFAULT_COLOR;
  }
}

function longitudeToTileX(longitude: number, count: number): number {
  return wrap(Math.floor((longitude + Math.PI) / (2 * Math.PI) * count), count);
}

function latitudeToTileY(latitude: number, count: number): number {
  const limit = 85.05112878 * Math.PI / 180;
  const clamped = Math.min(limit, Math.max(-limit, latitude));
  return Math.min(count - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(clamped)) / Math.PI) / 2 * count)));
}

function wrap(value: number, count: number): number {
  return ((value % count) + count) % count;
}
