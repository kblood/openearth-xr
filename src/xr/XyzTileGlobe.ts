import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector3,
} from 'three';

export interface XyzTileProvider {
  readonly id: string;
  readonly url: (z: number, x: number, y: number) => string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
}

export const OPEN_STREET_MAP: XyzTileProvider = {
  id: 'openstreetmap-standard',
  url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  attribution: '© OpenStreetMap contributors',
  minZoom: 0,
  maxZoom: 19,
};

// A readable Latin-script road-map style for the shipped viewer. Unlike the
// OSM Standard raster, it does not intentionally favour each feature's local
// name. Providers remain an explicit seam for a future Danish-only style.
export const CARTO_VOYAGER: XyzTileProvider = {
  id: 'carto-voyager',
  url: (z, x, y) => `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  attribution: '© OpenStreetMap contributors © CARTO',
  minZoom: 0,
  maxZoom: 18,
};

const SEGMENTS = 8;
const MAX_RESIDENT_TILES = 96;
const MAX_VISIBLE_TILES = 48;

type TileRecord = { mesh: Mesh; texture: Texture; lastUsed: number };

/**
 * Visible-only Web-Mercator map tiles on small curved patches. The permanent
 * low-resolution sphere remains below as a parent fallback, so requests never
 * leave holes in the planet. The cache intentionally stays modest: this is an
 * interactive viewer, not a bulk tile downloader.
 */
export class XyzTileGlobe {
  readonly group = new Group();
  private readonly cache = new Map<string, TileRecord>();
  private readonly visible = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly queued = new Map<string, { z: number; x: number; y: number }>();
  private readonly loader = new TextureLoader();
  private readonly focus = new Vector3();
  private lastLevel = -1;
  private lastX = -1;
  private lastY = -1;
  private tick = 0;

  constructor(
    private readonly radius: number,
    readonly provider: XyzTileProvider = OPEN_STREET_MAP,
  ) {}

  /** Updates only when the user has moved to a new tile/zoom tier. */
  update(cameraInGlobeSpace: Vector3): void {
    const distance = cameraInGlobeSpace.length();
    const altitude = Math.max(0.035, distance - this.radius);
    const level = Math.max(this.provider.minZoom, Math.min(this.provider.maxZoom, Math.round(4 + Math.log2(1.8 / altitude) * 2.05)));
    this.focus.copy(cameraInGlobeSpace).normalize();
    const { x, y } = this.directionToTile(this.focus, level);
    if (level === this.lastLevel && x === this.lastX && y === this.lastY) return;
    this.lastLevel = level;
    this.lastX = x;
    this.lastY = y;
    this.showCoverage(level, x, y);
  }

  private showCoverage(level: number, centerX: number, centerY: number): void {
    const nextVisible = new Set<string>();
    // Preserve context: a wide coarse ring stays present beneath the regional
    // and street-detail patches. Replacing all parents with only the new leaf
    // was what made the previous build look like a shrinking single tile.
    this.addNeighbourhood(nextVisible, Math.min(3, level), this.directionToTile(this.focus, Math.min(3, level)), 2);
    if (level > 5) this.addNeighbourhood(nextVisible, Math.min(8, level), this.directionToTile(this.focus, Math.min(8, level)), 1);
    if (level > 8) this.addNeighbourhood(nextVisible, level, { x: centerX, y: centerY }, 1);
    if (level <= 5) this.addNeighbourhood(nextVisible, level, { x: centerX, y: centerY }, 2);
    this.applyVisible(nextVisible);
  }

  private addNeighbourhood(nextVisible: Set<string>, z: number, center: { x: number; y: number }, radius: number): void {
    const count = 2 ** z;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const y = center.y + dy;
      if (y < 0 || y >= count) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = (center.x + dx + count) % count;
        const key = `${this.provider.id}/${z}/${x}/${y}`;
        if (nextVisible.size >= MAX_VISIBLE_TILES) break;
        nextVisible.add(key);
      }
    }
  }

  private applyVisible(nextVisible: Set<string>): void {
    for (const key of nextVisible) {
      const [, z, x, y] = key.split('/');
      this.ensureTile(Number(z), Number(x), Number(y), key);
    }
    for (const key of this.visible) {
      if (!nextVisible.has(key)) {
        const record = this.cache.get(key);
        if (record) record.mesh.visible = false;
      }
    }
    this.visible.clear();
    for (const key of nextVisible) {
      this.visible.add(key);
      const record = this.cache.get(key);
      if (record) { record.mesh.visible = true; record.lastUsed = ++this.tick; }
    }
    this.prune();
  }

  private ensureTile(z: number, x: number, y: number, key: string): void {
    const existing = this.cache.get(key);
    if (existing) { existing.mesh.visible = true; existing.lastUsed = ++this.tick; return; }
    if (this.pending.has(key)) return;
    if (this.pending.size >= 6) { this.queued.set(key, { z, x, y }); return; }
    this.startLoad(z, x, y, key);
  }

  private startLoad(z: number, x: number, y: number, key: string): void {
    this.pending.add(key);
    this.loader.load(
      this.provider.url(z, x, y),
      (texture) => {
        this.pending.delete(key);
        texture.colorSpace = SRGBColorSpace;
        const mesh = new Mesh(this.createTileGeometry(z, x, y), new MeshBasicMaterial({ map: texture }));
        const record = { mesh, texture, lastUsed: ++this.tick };
        this.cache.set(key, record);
        mesh.visible = this.visible.has(key);
        this.group.add(mesh);
        this.prune();
        this.drainQueue();
      },
      undefined,
      () => { this.pending.delete(key); this.drainQueue(); },
    );
  }

  private drainQueue(): void {
    while (this.pending.size < 6 && this.queued.size > 0) {
      const next = this.queued.entries().next().value as [string, { z: number; x: number; y: number }] | undefined;
      if (!next) return;
      const [key, tile] = next;
      this.queued.delete(key);
      if (this.visible.has(key)) this.startLoad(tile.z, tile.x, tile.y, key);
    }
  }

  private prune(): void {
    while (this.cache.size > MAX_RESIDENT_TILES) {
      let candidate: [string, TileRecord] | undefined;
      for (const entry of this.cache) {
        if (this.visible.has(entry[0])) continue;
        if (!candidate || entry[1].lastUsed < candidate[1].lastUsed) candidate = entry;
      }
      if (!candidate) return;
      const [key, record] = candidate;
      this.group.remove(record.mesh);
      record.mesh.geometry.dispose();
      (record.mesh.material as MeshBasicMaterial).dispose();
      record.texture.dispose();
      this.cache.delete(key);
    }
  }

  private directionToTile(direction: Vector3, z: number): { x: number; y: number } {
    const longitude = Math.atan2(direction.z, direction.x);
    const latitude = Math.asin(Math.max(-1, Math.min(1, direction.y)));
    const count = 2 ** z;
    return {
      x: Math.min(count - 1, Math.max(0, Math.floor((longitude + Math.PI) / (2 * Math.PI) * count))),
      y: Math.min(count - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * count))),
    };
  }

  private createTileGeometry(z: number, x: number, y: number): BufferGeometry {
    const vertices = (SEGMENTS + 1) ** 2;
    const positions = new Float32Array(vertices * 3);
    const uvs = new Float32Array(vertices * 2);
    const indices = new Uint16Array(SEGMENTS * SEGMENTS * 6);
    const count = 2 ** z;
    let vertex = 0;
    for (let iy = 0; iy <= SEGMENTS; iy += 1) {
      for (let ix = 0; ix <= SEGMENTS; ix += 1) {
        const fx = (x + ix / SEGMENTS) / count;
        const fy = (y + iy / SEGMENTS) / count;
        const longitude = fx * 2 * Math.PI - Math.PI;
        const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * fy)));
        const cosLat = Math.cos(latitude);
        const radius = this.radius + 0.003;
        positions[vertex * 3] = radius * cosLat * Math.cos(longitude);
        positions[vertex * 3 + 1] = radius * Math.sin(latitude);
        positions[vertex * 3 + 2] = radius * cosLat * Math.sin(longitude);
        // The outward-facing globe coordinate system looks along +Z, while
        // XYZ rasters increase x toward the east. Reverse U at the sampler so
        // roads and labels read normally instead of appearing in a mirror.
        uvs[vertex * 2] = 1 - ix / SEGMENTS;
        uvs[vertex * 2 + 1] = 1 - iy / SEGMENTS;
        vertex += 1;
      }
    }
    let offset = 0;
    for (let iy = 0; iy < SEGMENTS; iy += 1) for (let ix = 0; ix < SEGMENTS; ix += 1) {
      const a = iy * (SEGMENTS + 1) + ix;
      const b = a + 1;
      const c = a + SEGMENTS + 1;
      indices[offset++] = a; indices[offset++] = b; indices[offset++] = c;
      indices[offset++] = b; indices[offset++] = c + 1; indices[offset++] = c;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setIndex(new BufferAttribute(indices, 1));
    return geometry;
  }
}
