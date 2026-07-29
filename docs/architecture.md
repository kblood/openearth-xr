# OpenEarth XR architecture

## Principles

- **WebXR first, not VR only.** One public controller coordinates a precision
  Cesium desktop renderer and a dedicated Three.js immersive compositor.
- **Offline-capable contracts.** Provider APIs accept previously downloaded
  areas; persistent raster caching and the versioned `openearth-region-v1`
  routing manifest are implemented.
- **Open data and replaceable providers.** No proprietary imagery or platform lock-in is assumed.
- **Independent repository.** Compatibility is via documented bundle contracts, never a source-code dependency on OpenMaps.

## Initial layers

```
UI / navigation
        │
XR session + input ── Globe renderer (WebGL/WebGPU evolution)
        │
Scene model: camera, planet, terrain, vector overlays + 3D buildings
        │
Bundle adapter ── cache/storage ── optional network providers
```

The first renderer is CesiumJS: it supplies the WGS84 globe, quadtree imagery,
and camera precision required to move continuously from space to city scale.
OpenStreetMap is the default public imagery source; terrain is deliberately a
provider seam so a future build can use open DEM data or verified offline
bundles without an account/token requirement.

## 3D buildings

Buildings use a renderer-neutral `BuildingTileProvider`. The built-in MVT
adapter decodes OpenMapTiles/OSM polygons into longitude/latitude rings plus
height, minimum height, and colour. Cesium turns each tile into batched
`PolygonGeometry` instances; the XR renderer triangulates roofs and walls onto
the same curved Three.js globe as the raster surface. This shared decoded model
keeps desktop, headset, network, and future offline rendering geographically
identical without coupling OpenEarth to a particular tile host.

Both implementations select a bounded 5×5 window at the provider's highest
building LOD, abort obsolete work, retain only nearby GPU objects, and delay
retries after provider failures. The layer is dormant above city altitude.
`OpenEarthViewer` uses OpenFreeMap by default and accepts `null` to disable the
layer or any `BuildingTileProvider` to replace it.

Network defaults are a convenience preset, not an offline guarantee. Desktop,
XR, and building providers are independent: replacing one does not stop the
others from contacting their defaults. Privacy-sensitive and offline hosts must
configure each provider explicitly. See [providers and licences](providers-and-licenses.md).

The standalone service worker caches only same-origin application and Cesium
runtime assets. It does not intercept third-party raster, vector-building, or
search requests, so an installable shell must not be mistaken for a downloaded
map region. Bookmarks and interface preferences are local browser data; optional
Nominatim search and browser geolocation are user-initiated capabilities.

OGC 3D Tiles remains a complementary future path for photogrammetry and authored
landmarks. It is excellent for massive scene streaming in Cesium, but a generic
3D Tiles source would require a second compatible renderer in WebXR. Footprint
extrusion was therefore the practical first cross-renderer implementation.

## Offline regional raster contract

The library exposes `OpenMapsRasterProvider`, a read-only bridge for OpenMaps'
legacy IndexedDB tile store, and a generic `OpenMapsRasterTileStore` contract for
OPFS/native/bundle readers. The validated `openearth-region-v1` manifest records
an id, geographic bounds, level-of-detail range, attribution, and one or more
ordered raster-layer/store ids. `createOpenEarthRegionProvider` turns one or
more manifests plus a store resolver into a bounds-aware composite provider;
manifest and layer order define cross-pack priority, with optional global
fallback providers.

These contracts feed the immersive XYZ renderer without a source dependency on
OpenMaps, so each project stays independently buildable and releasable. The v1
manifest is routing metadata rather than a portable archive: it does not yet
standardize checksums, file transport, terrain, buildings, search/routing data,
or a matching Cesium imagery provider. Those can evolve as additive or later
versioned capabilities without weakening v1 validation.

## Roadmap

CesiumJS supplies the precision desktop globe but does not drive a WebXR
compositor loop. The immersive path therefore uses one dedicated Three.js
WebXR renderer and pauses the Cesium canvas while a session is active. This is
intentional: it gives the runtime control of both eye cameras and avoids a
second desktop globe appearing in the headset. Controller input is attached
through WebXR `connected` input sources; both standard Touch (axes 2/3) and
trackpad (axes 0/1) layouts rotate/change globe distance. Trigger flight uses
the WebXR target ray's local `-Z` direction. Single-controller grip anchors the
current terrain under the hand. Tangential translation rotates Earth by exactly
the corresponding physical surface distance, while radial translation changes
the shared virtual altitude. Controller orientation is deliberately ignored for
one-hand drag, so a wrist turn does not make the user feel as if they are holding
a miniature globe. Dual grip applies a midpoint-preserving transform where hand
separation changes virtual altitude and the hand-to-hand vector rotates Earth.
Flight, pinch, and stick zoom all use this altitude; field of view never changes.

Navigation has continuous orbital and local-surface regimes. At orbital scale,
travel changes physical camera-to-centre distance; approaching Earth then grows
the globe while maintaining comfortable clearance. Below roughly six kilometres,
a camera-relative east/up/south tangent root carries the focus map and buildings
near the numeric origin while the global globe remains behind it. Its scale
changes continuously with virtual altitude, so the ground stays about room-scale
without rebuilding local geometry every frame. Hysteresis, banded patch sizes,
and periodic geographic re-anchoring avoid transition flicker and Float32 jitter.
The same virtual altitude drives collision, tile LOD, buildings, sticks, grips,
pinch, and trigger flight, so no control changes field of view or passes through
the planet.

Thumbstick axes are remapped quadratically outside the dead zone. Outside local
mode, angular gain bounds surface speed as Earth grows. In local mode, pan is
expressed in real metres per second and falls continuously from aircraft speed
to walking pace, while heading remains a comfortable viewer turn. Zoom rate
interpolates logarithmically from orbital to minimum altitude, and two-hand
pinch uses the same proximity value to reduce its exponent near the surface.

The map surface is a multi-LOD renderer. An orbital parent globe receives a
Web-Mercator XYZ overview reprojected to equirectangular UVs; this avoids
incorrectly stretching a single Mercator tile across a sphere. Near the
surface, four independently atomic atlases are loaded around the viewer's
nadir: a broad 6×6 context layer at `base - 2`, a 6×6 base layer chosen from
globe-local virtual altitude, camera FOV, aspect ratio, and Mercator latitude
stretch, a central 4×4 detail layer at `base + 1`, and a 2×2 focus layer at
`base + 2` (bounded by provider coverage). The focus layer becomes a near-origin
tangent mesh in local mode. The context layer keeps
surrounding terrain available when the user looks away from the centre, while
the detail layer preserves street-label continuity across base LOD changes.
Every atlas vertex is
converted from its exact XYZ coordinate to longitude/latitude and placed on the
same sphere. Both renderers use SphereGeometry's convention that eastward
longitude points toward local `-Z`, and the curved atlas renders front faces
only. Fetches are cancelled per layer while each last complete atlas stays
visible. This avoids blank zoom frames, gaps, flat-map transitions, mirrored
labels, and unrelated-tile jumps, while a minimum radial distance prevents the
viewer entering the globe.

1. Controller ray targeting, teleport-to-place, and building/landmark selection.
2. Open terrain/elevation provider shared by desktop, XR, and regional manifests.
3. Roof shapes, landmark models, and optional OGC 3D Tiles on desktop.
4. Portable archive/export tooling and manifest capabilities for terrain,
   buildings, search, routing, and checksums.

## Quality and release boundaries

The npm library build externalizes Cesium, Three.js, the MVT decoder, and PBF so
host applications own one engine/runtime copy and ordinary dependency resolution
remains transparent. Clean builds remove previous outputs before generating the
ESM bundle, declarations, declaration maps, and JavaScript source map. Source is
included in the package so those maps resolve.

CI verifies two Node LTS lines, unit tests, type safety, formatting, browser and
package contents, production size, and a real Chromium startup. WebXR behavior
still requires the [physical-headset checklist](headset-release-checklist.md).
Static deployments are immutable release directories selected by a symlink and
verified through checksums plus a live release manifest.
