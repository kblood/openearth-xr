import {
  createOpenEarthRegionProvider,
  type OpenEarthRegionManifestV1,
  type OpenMapsRasterTileStore,
} from "openearth-xr/adapters";
import {
  MvtBuildingProvider,
  type BuildingTileProvider,
} from "openearth-xr/buildings";
import { greatCircleDistanceMeters, normalizeView } from "openearth-xr/core";
import {
  CompositeXyzTileProvider,
  type XyzTileProvider,
} from "openearth-xr/raster";
import {
  createXrStarField,
  type XrGlobeRendererOptions,
} from "openearth-xr/xr";

const store: OpenMapsRasterTileStore = {
  async getRasterTile() {
    return null;
  },
};

const manifest: OpenEarthRegionManifestV1 = {
  schema: "openearth-region-v1",
  id: "consumer-region",
  attribution: "Consumer fixture",
  minZoom: 0,
  maxZoom: 18,
  bounds: [-180, -85, 180, 85],
  raster: [{ id: "map", layerIds: ["map"] }],
};
const region = createOpenEarthRegionProvider(manifest, store);

const raster: XyzTileProvider = new CompositeXyzTileProvider({
  id: "consumer-composite",
  providers: [region],
});
const buildings: BuildingTileProvider = new MvtBuildingProvider({
  id: "consumer-buildings",
  attribution: "Consumer fixture",
  minZoom: 13,
  maxZoom: 14,
  url: (z, x, y) => `/buildings/${z}/${x}/${y}.pbf`,
});
const xrOptions = {
  minimumHeightMeters: 2,
  maximumHeightMeters: 100_000_000,
} satisfies XrGlobeRendererOptions;

void normalizeView({ longitude: 12.5683, latitude: 55.6761, height: 5_000 });
void greatCircleDistanceMeters(
  { longitude: 12.5683, latitude: 55.6761 },
  { longitude: 10.2039, latitude: 56.1629 },
);
void raster;
void buildings;
void xrOptions;
void createXrStarField;
