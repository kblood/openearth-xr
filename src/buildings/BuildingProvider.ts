import { VectorTile } from '@mapbox/vector-tile';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { PbfReader } from 'pbf';

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
  loadTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<BuildingFootprint>>;
}

export interface MvtBuildingProviderOptions {
  readonly id: string;
  readonly attribution: string;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Direct vector-tile URL. Use this for OpenMaps/offline bundle adapters. */
  readonly url?: (z: number, x: number, y: number) => string;
  /** TileJSON document used to resolve a versioned URL template at runtime. */
  readonly tileJsonUrl?: string;
  readonly sourceLayer?: string;
  readonly defaultHeightMeters?: number;
  readonly fetch?: typeof globalThis.fetch;
}

type TileJson = {
  readonly tiles?: readonly string[];
  readonly minzoom?: number;
  readonly maxzoom?: number;
};

/**
 * Decodes standard MVT building polygons into a small, renderer-neutral form.
 * OpenMapTiles height fields are preferred; height/levels fallbacks also make
 * this compatible with simpler host-generated and OpenMaps vector tiles.
 */
export class MvtBuildingProvider implements BuildingTileProvider {
  readonly id: string;
  readonly attribution: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  private readonly sourceLayer: string;
  private readonly defaultHeightMeters: number;
  private readonly fetcher: typeof globalThis.fetch;
  private templatePromise: Promise<string> | null = null;

  constructor(private readonly options: MvtBuildingProviderOptions) {
    if (!options.url && !options.tileJsonUrl) {
      throw new Error('MVT building provider requires url or tileJsonUrl');
    }
    this.id = options.id;
    this.attribution = options.attribution;
    this.minZoom = options.minZoom ?? 13;
    this.maxZoom = options.maxZoom ?? 14;
    this.sourceLayer = options.sourceLayer ?? 'building';
    this.defaultHeightMeters = options.defaultHeightMeters ?? 9;
    this.fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async loadTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ReadonlyArray<BuildingFootprint>> {
    const level = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    const shift = Math.max(0, z - level);
    const tileX = x >> shift;
    const tileY = y >> shift;
    const url = this.options.url
      ? this.options.url(level, tileX, tileY)
      : fillTemplate(await this.resolveTemplate(), level, tileX, tileY);
    const response = await this.fetcher(url, { mode: 'cors', signal });
    if (!response.ok) throw new Error(`Building tile ${level}/${tileX}/${tileY} failed (${response.status})`);
    return decodeMvtBuildingTile(
      new Uint8Array(await response.arrayBuffer()),
      level,
      tileX,
      tileY,
      this.sourceLayer,
      this.defaultHeightMeters,
    );
  }

  private resolveTemplate(): Promise<string> {
    if (!this.templatePromise) {
      this.templatePromise = this.fetcher(this.options.tileJsonUrl!, { mode: 'cors' })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Building TileJSON failed (${response.status})`);
          const tileJson = await response.json() as TileJson;
          const template = tileJson.tiles?.[0];
          if (!template) throw new Error('Building TileJSON contains no tile URL');
          return template;
        })
        .catch((error) => {
          this.templatePromise = null;
          throw error;
        });
    }
    return this.templatePromise;
  }
}

export const OPENFREEMAP_BUILDINGS = new MvtBuildingProvider({
  id: 'openfreemap-buildings',
  tileJsonUrl: 'https://tiles.openfreemap.org/planet',
  sourceLayer: 'building',
  minZoom: 13,
  maxZoom: 14,
  attribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors',
});

export function decodeMvtBuildingTile(
  bytes: Uint8Array,
  z: number,
  x: number,
  y: number,
  sourceLayer = 'building',
  defaultHeightMeters = 9,
): ReadonlyArray<BuildingFootprint> {
  const layer = new VectorTile(new PbfReader(bytes)).layers[sourceLayer];
  if (!layer) return [];
  const buildings: BuildingFootprint[] = [];
  for (let index = 0; index < layer.length; index += 1) {
    const vectorFeature = layer.feature(index);
    if (vectorFeature.type !== 3 || isTruthy(vectorFeature.properties.hide_3d)) continue;
    const feature = vectorFeature.toGeoJSON(x, y, z) as Feature<Polygon | MultiPolygon>;
    const polygons = feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    const minHeight = finiteNumber(
      vectorFeature.properties.render_min_height,
      vectorFeature.properties.min_height,
    ) ?? 0;
    const explicitHeight = finiteNumber(
      vectorFeature.properties.render_height,
      vectorFeature.properties.height,
    );
    const levels = finiteNumber(vectorFeature.properties.levels, vectorFeature.properties['building:levels']);
    const topHeight = explicitHeight ?? (levels !== undefined ? levels * 3 : defaultHeightMeters);
    const safeBase = clamp(minHeight, 0, 800);
    const safeTop = clamp(Math.max(topHeight, safeBase + 2.5), safeBase + 2.5, 1_000);
    const color = stringValue(vectorFeature.properties.colour, vectorFeature.properties.color);
    for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
      const rings = polygons[polygonIndex]
        .map((ring) => ring
          .map(([longitude, latitude]) => [longitude, latitude] as BuildingPosition)
          .filter((position) => Number.isFinite(position[0]) && Number.isFinite(position[1])))
        .filter((ring) => ring.length >= 4);
      if (rings.length === 0) continue;
      buildings.push({
        id: vectorFeature.id === undefined ? `${index}/${polygonIndex}` : `${vectorFeature.id}/${polygonIndex}`,
        rings,
        heightMeters: safeTop,
        minHeightMeters: safeBase,
        color,
      });
    }
  }
  return buildings;
}

function fillTemplate(template: string, z: number, x: number, y: number): string {
  return template
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y));
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
