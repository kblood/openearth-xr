# Integrating OpenEarth XR

OpenEarth exposes an embeddable `OpenEarthViewer` in addition to the standalone
website. The host application owns its controls and layout; the viewer owns the
Cesium desktop globe, WebXR renderer, navigation, and cleanup.

## Build and consume the library

Until an npm registry release is configured, consume the repository as a
workspace or local file dependency:

```bash
cd ../openearth
npm install
npm run build:lib

cd ../your-app
npm install ../openearth
```

Git and local installs run the package's `prepare` hook, which creates the
library output after dependencies are installed.

The library build emits:

- `dist-lib/openearth.js` — ESM entrypoint;
- `dist-lib/types/` — TypeScript declarations and declaration maps.

Cesium and Three.js remain external dependencies in the library build so a host
does not load duplicate render engines or conflicting WebXR singletons.

## Vanilla TypeScript

```ts
import "cesium/Build/Cesium/Widgets/widgets.css";
import {
  OpenEarthViewer,
  OPENEARTH_VIEWS,
  type OpenEarthXrChangeDetail,
} from "openearth-xr";

const container = document.querySelector<HTMLElement>("#earth");
if (!container) throw new Error("Missing #earth");

const earth = new OpenEarthViewer({
  container,
  // Copy Cesium's runtime folders here as part of the host build.
  cesiumBaseUrl: "/vendor/cesium/",
  initialView: OPENEARTH_VIEWS.denmark,
});

earth.addEventListener("xrchange", (event) => {
  const { active } = (event as CustomEvent<OpenEarthXrChangeDetail>).detail;
  document.body.classList.toggle("in-xr", active);
});

document.querySelector("#aarhus")?.addEventListener("click", () => {
  earth.flyTo({ longitude: 10.2039, latitude: 56.1629, height: 8_000 });
});
document.querySelector("#vr")?.addEventListener("click", async () => {
  if (earth.xrActive) await earth.exitXr();
  else await earth.enterXr();
});

// When the host removes the view:
await earth.destroy();
```

Give the container an explicit size:

```css
#earth {
  width: 100%;
  min-height: 32rem;
}
```

If `xrCanvas` is omitted, OpenEarth creates and owns an overlay canvas inside
the container. A host may pass its own canvas when it needs complete layout
control.

## Focused package entry points

Use the root package for the complete public API or a focused subpath when a
library, worker, or adapter needs only one architectural layer:

| Import path              | Contents                                      |
| ------------------------ | --------------------------------------------- |
| `openearth-xr/core`      | Coordinates, scale, and distance helpers      |
| `openearth-xr/raster`    | XYZ contracts, routing, cache, scheduler, LOD |
| `openearth-xr/buildings` | Building providers, streaming, render layers  |
| `openearth-xr/adapters`  | OpenMaps and persistent-store adapters        |
| `openearth-xr/xr`        | Low-level immersive renderer                  |

Each subpath has its own ESM entry and declaration entry. Cesium, Three.js, and
the MVT decoder remain external where that layer uses them.

## Configuration seams

- `imageryProvider` accepts a host-created Cesium imagery provider.
- `imageryUrl` changes the default desktop OpenStreetMap XYZ endpoint.
- `xrTileProvider` changes the immersive raster XYZ provider and its LODs.
- `buildingProvider` supplies renderer-independent 3D footprints to both
  Cesium and WebXR. Omit it for the token-free OpenFreeMap default or pass
  `null` to disable buildings.
- `cesiumBaseUrl` points to the host's copied Cesium runtime assets.
- `minimumZoomDistance` and `maximumZoomDistance` tune desktop camera limits.
- `initialView` controls the reset destination.

The exported `XrGlobeRenderer`, `XyzTileGlobe`, and `XyzTileProvider` are lower
level extension points for applications that want to build their own scene.

### OpenMaps and stored raster tiles

`OpenMapsRasterProvider` adapts an `OpenMapsRasterTileStore` to the immersive XYZ
pipeline. The included read-only legacy bridge opens the existing
`openmaps_global/tiles` IndexedDB store without upgrading or taking ownership of
it:

```ts
import { OpenEarthViewer } from "openearth-xr";
import {
  createOpenEarthRegionProvider,
  LegacyOpenMapsIndexedDbStore,
  type OpenEarthRegionManifestV1,
} from "openearth-xr/adapters";

const openMapsStore = new LegacyOpenMapsIndexedDbStore();
const denmarkManifest: OpenEarthRegionManifestV1 = {
  schema: "openearth-region-v1",
  id: "denmark",
  attribution: "© OpenStreetMap contributors",
  minZoom: 0,
  maxZoom: 18,
  bounds: [7.5, 54.4, 15.3, 57.9],
  raster: [{ id: "streets", layerIds: ["openstreetmap"] }],
};
const denmarkPack = createOpenEarthRegionProvider(
  denmarkManifest,
  openMapsStore,
  { overviewFallbackColor: "#b7d2e0" },
);

const earth = new OpenEarthViewer({ container, xrTileProvider: denmarkPack });

// When the host application is finished:
await earth.destroy();
openMapsStore.close();
```

For OPFS, a native bridge, or a new OpenMaps schema, implement
`OpenMapsRasterTileStore.getRasterTile`. Return encoded `Blob` data; the adapter
creates a fresh `ImageBitmap` and transfers it to OpenEarth. Pass multiple
manifests to `createOpenEarthRegionProvider` to stitch packs. Manifest order and
then raster-layer order determine priority, while geographic bounds and zoom
ranges prevent unrelated stores from being queried. A store-resolver callback
can map each manifest/layer to a different backing store; `fallbackProviders`
can add a global network source after every pack.

`validateOpenEarthRegionManifest` is available when loading untyped JSON.
`PersistentTileCache` and `CachedNetworkXyzProvider` are available only for
sources whose terms explicitly permit offline storage.

The v1 manifest deliberately covers stored raster routing, not a self-contained
archive. This adapter supplies the Three.js/WebXR raster path. A host that needs
the same stored tiles on the Cesium desktop path must also provide a
corresponding Cesium `imageryProvider`; terrain, buildings, search, routing,
checksums, and archive transport remain future manifest/tooling extensions.

### Custom immersive raster providers

An XR provider can expose ordinary tile URLs or load decoded images directly
from application storage:

```ts
const xrTileProvider = {
  id: "host-cache",
  minZoom: 0,
  maxZoom: 18,
  attribution: "Host map data",
  async loadTile(z: number, x: number, y: number) {
    const bytes = await hostTileCache.getRasterTile(z, x, y);
    if (!bytes) return { status: "missing" };
    return {
      status: "loaded",
      image: await createImageBitmap(new Blob([bytes])),
      ownership: "transfer",
    };
  },
};

const earth = new OpenEarthViewer({ container, xrTileProvider });
```

No loopback web server or object-URL bookkeeping is required.

### 3D building providers

Use the built-in global source explicitly, or create an adapter for self-hosted
OpenMapTiles/OpenMaps-compatible MVT:

```ts
import {
  MvtBuildingProvider,
  OPENFREEMAP_BUILDINGS,
  OpenEarthViewer,
} from "openearth-xr";

const selfHostedBuildings = new MvtBuildingProvider({
  id: "my-region-buildings",
  attribution: "© OpenStreetMap contributors",
  minZoom: 13,
  maxZoom: 14,
  sourceLayer: "building",
  url: (z, x, y) => `/regions/denmark/${z}/${x}/${y}.pbf`,
});

const earth = new OpenEarthViewer({
  container,
  buildingProvider: navigator.onLine
    ? OPENFREEMAP_BUILDINGS
    : selfHostedBuildings,
});
```

For OPFS, IndexedDB, or a native bridge, implement `BuildingTileProvider`
directly and return normalized `BuildingFootprint[]`. This deliberately avoids
requiring an HTTP endpoint and is the intended OpenMaps bundle integration
seam. Heights are metres above the ellipsoid; each polygon's first ring is its
exterior and later rings are holes.

`XyzTileProvider.loadTile` transfers ownership of each returned `ImageBitmap`
to OpenEarth, which closes it after drawing. Cached providers should store bytes
or blobs and create a fresh bitmap for every successful call.

The package declares Cesium and Three.js as peer dependencies. Install one
compatible copy of each in the host and copy Cesium's runtime assets as shown
above; the OpenEarth ESM bundle will reuse those engine instances.

OpenEarth currently supports Three.js 0.181.x. Install matching
`@types/three` when the host typechecks Three APIs directly; OpenEarth itself
ships the matching types needed by its declarations.

## Framework lifecycle

Create one viewer after the container mounts and call `destroy()` before it is
removed. In React, Vue, or Svelte, keep the instance in a ref rather than in
reactive state. `viewer.on(type, listener)` provides typed event details and
returns an unsubscribe function, which fits framework effect cleanup without a
manual listener cast. WebXR entry must be initiated by a user gesture; call
`isXrSupported()` to decide whether to show the button.

```ts
const unsubscribe = earth.on("viewchange", ({ detail }) => {
  updateHostCameraState(detail.view);
});

// Framework cleanup:
unsubscribe();
await earth.destroy();
```

WebXR also requires a secure HTTPS context. Cross-origin iframe hosts must add
`allow="xr-spatial-tracking"` to the iframe and permit that origin through their
`Permissions-Policy`; a DOM permission alone cannot override a restrictive
server policy. Render the viewer client-side in SSR frameworks because Cesium,
Three.js, DOM, canvas, and `navigator.xr` are browser APIs.

## Network and privacy behavior

The three provider defaults are independent. A custom `imageryProvider` does
not replace `xrTileProvider`, and omitting `buildingProvider` opts into the
OpenFreeMap network default. Pass `buildingProvider: null` and supply both map
providers for a controlled/no-third-party deployment. Review [PRIVACY.md](../PRIVACY.md)
and [provider/licence guidance](providers-and-licenses.md), including the public
OSM raster service's prohibition on offline bulk download.

One Cesium base URL is global to a page. Multiple `OpenEarthViewer` instances
should use the same runtime asset location and compatible Cesium/Three versions.
