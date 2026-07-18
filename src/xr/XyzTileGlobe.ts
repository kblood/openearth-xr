import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RepeatWrapping,
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

/**
 * XYZ maps use Web Mercator while a Three sphere expects equirectangular UVs.
 * A z=0 XYZ tile therefore cannot be placed directly on a sphere: it is both
 * low resolution and geographically wrong away from the equator. Build a
 * small Mercator overview first, then reproject it for the globe shell.
 */
export async function createGlobalOverviewTexture(
  provider: XyzTileProvider = CARTO_VOYAGER,
  zoom = 2,
): Promise<CanvasTexture> {
  const count = 2 ** MathUtils.clamp(zoom, provider.minZoom, Math.min(provider.maxZoom, 4));
  const source = document.createElement('canvas');
  source.width = count * TILE_SIZE;
  source.height = count * TILE_SIZE;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('Canvas 2D is required for the global XR map');
  sourceContext.fillStyle = '#d6e7ef';
  sourceContext.fillRect(0, 0, source.width, source.height);

  await Promise.all(Array.from({ length: count * count }, async (_, index) => {
    const x = index % count;
    const y = Math.floor(index / count);
    try {
      const response = await fetch(provider.url(zoom, x, y));
      if (!response.ok) return;
      const image = await createImageBitmap(await response.blob());
      sourceContext.drawImage(image, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      image.close();
    } catch { /* The neutral ocean remains where a tile is unavailable. */ }
  }));

  const target = document.createElement('canvas');
  target.width = 1024;
  target.height = 512;
  const targetContext = target.getContext('2d');
  if (!targetContext) throw new Error('Canvas 2D is required for the global XR map');
  targetContext.fillStyle = '#d6e7ef';
  targetContext.fillRect(0, 0, target.width, target.height);
  const maximumMercatorLatitude = MathUtils.degToRad(85.05112878);
  for (let row = 0; row < target.height; row += 1) {
    const latitude = Math.PI / 2 - ((row + 0.5) / target.height) * Math.PI;
    if (Math.abs(latitude) > maximumMercatorLatitude) continue;
    const mercatorY = (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2;
    targetContext.drawImage(source, 0, mercatorY * source.height, source.width, 1, 0, row, target.width, 1);
  }
  const texture = new CanvasTexture(target);
  texture.colorSpace = SRGBColorSpace;
  // SphereGeometry's U axis runs west as U increases. XYZ's X axis runs east,
  // so mirror only the overview texture to use the same longitude convention
  // as the curved close-range cap.
  texture.wrapS = RepeatWrapping;
  texture.repeat.x = -1;
  texture.offset.x = 1;
  texture.needsUpdate = true;
  return texture;
}

const TILE_SIZE = 256;
const TILE_GRID = 5;
const OVERSCAN = 1.35;
const LOCAL_SURFACE_START = 0.72;
const SURFACE_OFFSET = 0.0001;

/**
 * A local, curved map surface for close globe exploration. Rendering every
 * high-zoom XYZ tile as an independent spherical mesh leaves gaps and cannot
 * fill a near-surface view. This class assembles the visible tile grid into
 * one texture and drapes it over a spherical cap in the globe coordinate
 * system. The cap is deliberately not a flat map floating in front of Earth.
 */
export class XyzTileGlobe {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly surface: Mesh;
  private readonly normal = new Vector3();
  private readonly east = new Vector3();
  private readonly north = new Vector3();
  private readonly orientation = new Matrix4();
  private readonly rotation = new Quaternion();
  private level = -1;
  private tileX = -1;
  private tileY = -1;
  private revision = 0;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(private readonly radius: number, readonly provider: XyzTileProvider = CARTO_VOYAGER) {
    this.canvas.width = TILE_SIZE * TILE_GRID;
    this.canvas.height = TILE_SIZE * TILE_GRID;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for XR map tiles');
    this.context = context;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.surface = new Mesh(
      this.createSurfaceGeometry(0.01, 0.01),
      new MeshBasicMaterial({ map: this.texture, side: DoubleSide }),
    );
    this.surface.visible = false;
    this.group.add(this.surface);
  }

  update(cameraInGlobeSpace: Vector3, verticalFovDegrees: number, aspect: number): void {
    const distance = cameraInGlobeSpace.length();
    const altitude = distance - this.radius;
    if (altitude >= LOCAL_SURFACE_START) { this.surface.visible = false; return; }

    this.normal.copy(cameraInGlobeSpace).normalize();
    const fov = MathUtils.degToRad(verticalFovDegrees);
    const height = Math.max(0.0015, 2 * altitude * Math.tan(fov / 2) * OVERSCAN);
    const width = height * Math.max(0.5, aspect);
    this.surface.visible = true;
    // Give every cap a stable compass frame: +X is east and +Y is north.
    // setFromUnitVectors alone leaves its roll unspecified, which can mirror
    // labels or rotate the local map after a globe grab.
    this.east.set(-this.normal.z, 0, this.normal.x).normalize();
    this.north.crossVectors(this.east, this.normal).normalize();
    this.orientation.makeBasis(this.east, this.north, this.normal);
    this.rotation.setFromRotationMatrix(this.orientation);
    this.surface.quaternion.copy(this.rotation);
    const geometryChanged = Math.abs(width - this.lastWidth) / Math.max(width, this.lastWidth, 0.001) > 0.04
      || Math.abs(height - this.lastHeight) / Math.max(height, this.lastHeight, 0.001) > 0.04;
    if (geometryChanged) {
      this.surface.geometry.dispose();
      this.surface.geometry = this.createSurfaceGeometry(width, height);
      this.lastHeight = height;
    }

    // Choose the highest tile zoom that still lets a 5x5 mosaic cover the
    // panel. This makes the detailed texture continuous at every altitude.
    const angularWidth = Math.max(0.0001, width / this.radius);
    const desired = Math.floor(Math.log2((TILE_GRID * 2 * Math.PI) / angularWidth));
    const level = MathUtils.clamp(desired, this.provider.minZoom, this.provider.maxZoom);
    const { x, y } = this.directionToTile(this.normal, level);
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    if (level !== this.level || tileX !== this.tileX || tileY !== this.tileY || geometryChanged) {
      this.level = level;
      this.tileX = tileX;
      this.tileY = tileY;
      this.lastWidth = width;
      this.loadMosaic(level, x, y);
    }
  }

  private createSurfaceGeometry(width: number, height: number): BufferGeometry {
    const segments = 32;
    const radius = this.radius + SURFACE_OFFSET;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row <= segments; row += 1) {
      const v = row / segments;
      const y = (0.5 - v) * height;
      for (let column = 0; column <= segments; column += 1) {
        const u = column / segments;
        const x = (u - 0.5) * width;
        // The cap has its local north pole on +Z. Its rotation below then
        // places that pole at the camera's geographic direction.
        const z = Math.sqrt(Math.max(0.000001, radius * radius - x * x - y * y));
        positions.push(x, y, z);
        // CanvasTexture carries the canvas' vertical upload flip. Keeping the
        // geometric V direction here makes north remain up in the headset.
        uvs.push(u, v);
      }
    }
    for (let row = 0; row < segments; row += 1) for (let column = 0; column < segments; column += 1) {
      const a = row * (segments + 1) + column;
      const b = a + 1;
      const c = a + segments + 1;
      indices.push(a, c, b, b, c, c + 1);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private loadMosaic(z: number, centerX: number, centerY: number): void {
    const revision = ++this.revision;
    const count = 2 ** z;
    this.context.fillStyle = '#d6e7ef';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    const half = Math.floor(TILE_GRID / 2);
    const baseX = Math.floor(centerX) - half;
    const baseY = Math.floor(centerY) - half;
    const fractionalX = centerX - Math.floor(centerX);
    const fractionalY = centerY - Math.floor(centerY);
    // Draw with a fractional shift so the chosen geographic direction is at
    // the centre of the cap, not merely somewhere inside its centre tile.
    // One extra row/column covers the exposed edge after that shift.
    for (let row = 0; row <= TILE_GRID; row += 1) for (let column = 0; column <= TILE_GRID; column += 1) {
      const x = (baseX + column + count) % count;
      const y = baseY + row;
      if (y < 0 || y >= count) continue;
      // Fetch + ImageBitmap avoids the inconsistent Image.onload behaviour
      // seen with very high zoom tiles in headset/Chromium canvases.
      fetch(this.provider.url(z, x, y))
        .then((response) => response.ok ? response.blob() : Promise.reject(new Error(`tile ${response.status}`)))
        .then((blob) => createImageBitmap(blob))
        .then((image) => {
          if (revision === this.revision) {
            this.context.drawImage(
              image,
              (column - half - fractionalX) * TILE_SIZE + this.canvas.width / 2,
              (row - half - fractionalY) * TILE_SIZE + this.canvas.height / 2,
              TILE_SIZE,
              TILE_SIZE,
            );
            this.texture.needsUpdate = true;
          }
          image.close();
        })
        .catch(() => undefined);
    }
  }

  private directionToTile(direction: Vector3, z: number): { x: number; y: number } {
    const longitude = Math.atan2(direction.z, direction.x);
    const latitude = Math.asin(MathUtils.clamp(direction.y, -1, 1));
    const count = 2 ** z;
    return {
      x: MathUtils.clamp((longitude + Math.PI) / (2 * Math.PI) * count, 0, count - 0.000001),
      y: MathUtils.clamp((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * count, 0, count - 0.000001),
    };
  }
}
