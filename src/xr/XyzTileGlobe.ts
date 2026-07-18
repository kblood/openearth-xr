import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';

export interface XyzTileProvider {
  readonly id: string;
  readonly url: (z: number, x: number, y: number) => string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
}

export const CARTO_VOYAGER: XyzTileProvider = {
  id: 'carto-voyager',
  url: (z, x, y) => `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  attribution: '© OpenStreetMap contributors © CARTO',
  minZoom: 0,
  maxZoom: 18,
};

const TILE_SIZE = 256;
const TILE_GRID = 6;
const CAP_SEGMENTS_PER_TILE = 8;
const LOCAL_SURFACE_START = 1.6;
const VIEW_OVERSCAN = 1.45;
const SURFACE_OFFSET = 0.0008;
const MAX_MERCATOR_LATITUDE = MathUtils.degToRad(85.05112878);

/**
 * Reproject a modest XYZ overview into the equirectangular UV layout used by
 * SphereGeometry. No texture repeat or negative scale is used: those mirror
 * the glyphs along with the geography.
 */
export async function createGlobalOverviewTexture(
  provider: XyzTileProvider = CARTO_VOYAGER,
  zoom = 3,
): Promise<CanvasTexture> {
  const level = MathUtils.clamp(zoom, provider.minZoom, Math.min(provider.maxZoom, 4));
  const count = 2 ** level;
  const source = document.createElement('canvas');
  source.width = count * TILE_SIZE;
  source.height = count * TILE_SIZE;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('Canvas 2D is required for the global XR map');
  sourceContext.fillStyle = '#b7d2e0';
  sourceContext.fillRect(0, 0, source.width, source.height);

  const tiles = await Promise.all(Array.from({ length: count * count }, async (_, index) => {
    const x = index % count;
    const y = Math.floor(index / count);
    const image = await fetchTile(provider.url(level, x, y));
    return { x, y, image };
  }));
  for (const { x, y, image } of tiles) {
    if (!image) continue;
    sourceContext.drawImage(image, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    image.close();
  }

  const target = document.createElement('canvas');
  target.width = 2048;
  target.height = 1024;
  const targetContext = target.getContext('2d');
  if (!targetContext) throw new Error('Canvas 2D is required for the global XR map');
  targetContext.fillStyle = '#b7d2e0';
  targetContext.fillRect(0, 0, target.width, target.height);
  for (let row = 0; row < target.height; row += 1) {
    const latitude = Math.PI / 2 - ((row + 0.5) / target.height) * Math.PI;
    if (Math.abs(latitude) > MAX_MERCATOR_LATITUDE) continue;
    const sourceY = latitudeToTileY(latitude, 1) * source.height;
    targetContext.drawImage(source, 0, sourceY, source.width, 1, 0, row, target.width, 1);
  }

  const texture = new CanvasTexture(target);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Loads an atomic XYZ atlas and maps every atlas grid vertex back to its exact
 * longitude/latitude on the globe. Geometry, UVs, tile selection and LOD thus
 * share one coordinate model. The previous tangent-panel implementation used
 * four independently approximated transforms, which caused mirrored labels,
 * unrelated locations and a visually frozen zoom transition.
 */
export class XyzTileGlobe {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly surface: Mesh;
  private readonly direction = new Vector3();
  private requestedKey = '';
  private displayedKey = '';
  private revision = 0;
  private atlasAbort: AbortController | null = null;

  constructor(private readonly radius: number, readonly provider: XyzTileProvider = CARTO_VOYAGER) {
    this.canvas.width = TILE_SIZE * TILE_GRID;
    this.canvas.height = TILE_SIZE * TILE_GRID;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for XR map tiles');
    context.fillStyle = '#b7d2e0';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.surface = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        map: this.texture,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    this.surface.visible = false;
    this.group.add(this.surface);
  }

  update(cameraInGlobeSpace: Vector3, verticalFovDegrees: number, aspect: number): void {
    const distance = cameraInGlobeSpace.length();
    const altitude = Math.max(0, distance - this.radius);
    if (altitude >= LOCAL_SURFACE_START || distance <= 0) {
      this.surface.visible = false;
      return;
    }

    this.direction.copy(cameraInGlobeSpace).divideScalar(distance);
    // SphereGeometry maps eastward longitude toward -Z.
    const longitude = Math.atan2(-this.direction.z, this.direction.x);
    const latitude = Math.asin(MathUtils.clamp(this.direction.y, -1, 1));
    const fov = MathUtils.degToRad(verticalFovDegrees);
    const halfHeight = altitude * Math.tan(fov / 2) * VIEW_OVERSCAN;
    const halfWidth = halfHeight * Math.max(0.5, aspect);
    const angularHeight = Math.max(0.000001, 2 * Math.atan(halfHeight / this.radius));
    const angularWidth = Math.max(0.000001, 2 * Math.atan(halfWidth / this.radius));
    const mercatorStretch = 1 / Math.max(0.08, Math.cos(latitude));
    const baseTileDemand = Math.max(angularWidth, angularHeight * mercatorStretch) / (2 * Math.PI);
    const usableTiles = TILE_GRID - 1.5;
    const desiredZoom = Math.floor(Math.log2(usableTiles / baseTileDemand));
    const minimumLocalZoom = Math.max(this.provider.minZoom, 2);
    const level = MathUtils.clamp(desiredZoom, minimumLocalZoom, this.provider.maxZoom);
    const count = 2 ** level;
    const centerX = longitudeToTileX(longitude, count);
    const centerY = latitudeToTileY(latitude, count);
    const baseX = Math.floor(centerX) - Math.floor(TILE_GRID / 2);
    const baseY = MathUtils.clamp(
      Math.floor(centerY) - Math.floor(TILE_GRID / 2),
      0,
      Math.max(0, count - TILE_GRID),
    );
    const key = `${level}/${baseX}/${baseY}`;
    if (key !== this.requestedKey) {
      this.requestedKey = key;
      void this.loadAtlas(level, baseX, baseY, key);
    }
    this.surface.visible = this.displayedKey.length > 0;
  }

  private async loadAtlas(level: number, baseX: number, baseY: number, key: string): Promise<void> {
    const revision = ++this.revision;
    this.atlasAbort?.abort();
    const abort = new AbortController();
    this.atlasAbort = abort;
    const count = 2 ** level;
    const staging = document.createElement('canvas');
    staging.width = this.canvas.width;
    staging.height = this.canvas.height;
    const context = staging.getContext('2d');
    if (!context) return;
    context.fillStyle = '#b7d2e0';
    context.fillRect(0, 0, staging.width, staging.height);

    const tiles = await Promise.all(Array.from({ length: TILE_GRID * TILE_GRID }, async (_, index) => {
      const column = index % TILE_GRID;
      const row = Math.floor(index / TILE_GRID);
      const unwrappedX = baseX + column;
      const x = ((unwrappedX % count) + count) % count;
      const y = baseY + row;
      const image = y >= 0 && y < count
        ? await fetchTile(this.provider.url(level, x, y), abort.signal)
        : null;
      return { column, row, image };
    }));

    if (revision !== this.revision) {
      for (const tile of tiles) tile.image?.close();
      return;
    }
    let loaded = 0;
    for (const { column, row, image } of tiles) {
      if (!image) continue;
      context.drawImage(image, column * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      image.close();
      loaded += 1;
    }
    if (loaded === 0) {
      this.requestedKey = '';
      return;
    }

    const targetContext = this.canvas.getContext('2d');
    if (!targetContext) return;
    targetContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
    targetContext.drawImage(staging, 0, 0);
    this.texture.needsUpdate = true;
    const previous = this.surface.geometry;
    this.surface.geometry = this.createAtlasGeometry(level, baseX, baseY);
    previous.dispose();
    this.displayedKey = key;
    this.surface.visible = true;
  }

  private createAtlasGeometry(level: number, baseX: number, baseY: number): BufferGeometry {
    const count = 2 ** level;
    const segments = TILE_GRID * CAP_SEGMENTS_PER_TILE;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const radius = this.radius + SURFACE_OFFSET;
    for (let row = 0; row <= segments; row += 1) {
      const v = row / segments;
      const tileY = baseY + v * TILE_GRID;
      const latitude = tileYToLatitude(tileY, count);
      const cosLatitude = Math.cos(latitude);
      for (let column = 0; column <= segments; column += 1) {
        const u = column / segments;
        const tileX = baseX + u * TILE_GRID;
        const longitude = tileX / count * 2 * Math.PI - Math.PI;
        positions.push(
          radius * cosLatitude * Math.cos(longitude),
          radius * Math.sin(latitude),
          -radius * cosLatitude * Math.sin(longitude),
        );
        // Sphere-style UVs use V=1 at the north edge. CanvasTexture performs
        // the corresponding upload flip, while positive U remains east.
        uvs.push(u, 1 - v);
      }
    }
    for (let row = 0; row < segments; row += 1) {
      for (let column = 0; column < segments; column += 1) {
        const a = row * (segments + 1) + column;
        const b = a + 1;
        const c = a + segments + 1;
        // With east toward -Z, north→south crossed with west→east points out
        // of the globe. Front-face rendering then guarantees readable labels.
        indices.push(a, c, b, b, c, c + 1);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

async function fetchTile(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(url, { mode: 'cors', signal });
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

function longitudeToTileX(longitude: number, count: number): number {
  return (longitude + Math.PI) / (2 * Math.PI) * count;
}

function latitudeToTileY(latitude: number, count: number): number {
  const clamped = MathUtils.clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  return (1 - Math.asinh(Math.tan(clamped)) / Math.PI) / 2 * count;
}

function tileYToLatitude(tileY: number, count: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / count)));
}
