import {
  CanvasTexture,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
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
const TILE_GRID = 5;
const OVERSCAN = 1.35;
const LOCAL_SURFACE_START = 0.72;
const SURFACE_OFFSET = 0.0001;
const Z_AXIS = new Vector3(0, 0, 1);

/**
 * A local tangent map surface for close globe exploration. Rendering every
 * high-zoom XYZ tile as an independent spherical mesh leaves gaps and cannot
 * fill a near-surface view. This class assembles just the visible tile grid
 * into one texture and maps it onto a tangent panel above the globe.
 */
export class XyzTileGlobe {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly surface: Mesh;
  private readonly normal = new Vector3();
  private readonly rotation = new Quaternion();
  private level = -1;
  private tileX = -1;
  private tileY = -1;
  private revision = 0;
  private lastWidth = 0;

  constructor(private readonly radius: number, readonly provider: XyzTileProvider = CARTO_VOYAGER) {
    this.canvas.width = TILE_SIZE * TILE_GRID;
    this.canvas.height = TILE_SIZE * TILE_GRID;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for XR map tiles');
    this.context = context;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.surface = new Mesh(
      new PlaneGeometry(1, 1, 1, 1),
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
    this.surface.position.copy(this.normal).multiplyScalar(this.radius + SURFACE_OFFSET);
    this.rotation.setFromUnitVectors(Z_AXIS, this.normal);
    this.surface.quaternion.copy(this.rotation);
    this.surface.scale.set(width, height, 1);

    // Choose the highest tile zoom that still lets a 5x5 mosaic cover the
    // panel. This makes the detailed texture continuous at every altitude.
    const angularWidth = Math.max(0.0001, width / this.radius);
    const desired = Math.floor(Math.log2((TILE_GRID * 2 * Math.PI) / angularWidth));
    const level = MathUtils.clamp(desired, this.provider.minZoom, this.provider.maxZoom);
    const { x, y } = this.directionToTile(this.normal, level);
    const widthChanged = Math.abs(width - this.lastWidth) / Math.max(width, this.lastWidth, 0.001) > 0.1;
    if (level !== this.level || x !== this.tileX || y !== this.tileY || widthChanged) {
      this.level = level;
      this.tileX = x;
      this.tileY = y;
      this.lastWidth = width;
      this.loadMosaic(level, x, y);
    }
  }

  private loadMosaic(z: number, centerX: number, centerY: number): void {
    const revision = ++this.revision;
    const count = 2 ** z;
    this.context.fillStyle = '#d6e7ef';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
    const half = Math.floor(TILE_GRID / 2);
    for (let row = 0; row < TILE_GRID; row += 1) for (let column = 0; column < TILE_GRID; column += 1) {
      const x = (centerX + column - half + count) % count;
      const y = centerY + row - half;
      if (y < 0 || y >= count) continue;
      // Fetch + ImageBitmap avoids the inconsistent Image.onload behaviour
      // seen with very high zoom tiles in headset/Chromium canvases.
      fetch(this.provider.url(z, x, y))
        .then((response) => response.ok ? response.blob() : Promise.reject(new Error(`tile ${response.status}`)))
        .then((blob) => createImageBitmap(blob))
        .then((image) => {
          if (revision === this.revision) {
            this.context.drawImage(image, column * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);
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
      x: MathUtils.clamp(Math.floor((longitude + Math.PI) / (2 * Math.PI) * count), 0, count - 1),
      y: MathUtils.clamp(Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * count), 0, count - 1),
    };
  }
}
