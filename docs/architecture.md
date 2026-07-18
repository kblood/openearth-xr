# OpenEarth XR architecture

## Principles

- **WebXR first, not VR only.** One renderer supports desktop, touch, and immersive sessions.
- **Offline by design.** A viewer remains useful with previously downloaded areas.
- **Open data and replaceable providers.** No proprietary imagery or platform lock-in is assumed.
- **Independent repository.** Compatibility is via documented bundle contracts, never a source-code dependency on OpenMaps.

## Initial layers

```
UI / navigation
        │
XR session + input ── Globe renderer (WebGL/WebGPU evolution)
        │
Scene model: camera, planet, terrain, vector overlays
        │
Bundle adapter ── cache/storage ── optional network providers
```

The first renderer is CesiumJS: it supplies the WGS84 globe, quadtree imagery,
and camera precision required to move continuously from space to city scale.
OpenStreetMap is the default public imagery source; terrain is deliberately a
provider seam so a future build can use open DEM data or verified offline
bundles without an account/token requirement.

## Offline regional bundle contract (planned)

OpenEarth will consume a versioned manifest rather than a repository package. A future `openearth-region-v1` manifest will identify:

- geographic bounds and level-of-detail coverage;
- raster/vector terrain and map assets with checksums;
- optional search/routing data declared as independent capabilities;
- attribution and licence metadata.

An adapter can then translate OpenMaps-compatible regional exports into this contract, while each project stays independently buildable and releasable.

## Roadmap

CesiumJS supplies the precision desktop globe but does not drive a WebXR
compositor loop. The immersive path therefore uses one dedicated Three.js
WebXR renderer and pauses the Cesium canvas while a session is active. This is
intentional: it gives the runtime control of both eye cameras and avoids a
second desktop globe appearing in the headset. Controller input is attached
through WebXR `connected` input sources; both standard Touch (axes 2/3) and
trackpad (axes 0/1) layouts rotate/change globe distance. Trigger flight uses
the WebXR target ray's local `-Z` direction. Single-controller grip applies controller translation and
rotation to the globe; dual grip applies a midpoint-preserving transform where
hand separation changes camera-to-globe distance (never field of view or world
scale) and the hand-to-hand vector rotates it. Flight and stick zoom use that
same distance, with speed proportional to altitude and clamped near the
surface.
The map surface is a two-stage renderer. An orbital parent globe receives a
Web-Mercator XYZ overview reprojected to equirectangular UVs; this avoids
incorrectly stretching a single Mercator tile across a sphere. Near the
surface, an atomic 6×6 atlas is loaded at a zoom chosen from physical altitude,
camera FOV, aspect ratio, and Mercator latitude stretch. Every atlas vertex is
converted from its exact XYZ coordinate to longitude/latitude and placed on the
same sphere. Both renderers use SphereGeometry's convention that eastward
longitude points toward local `-Z`, and the curved atlas renders front faces
only. Obsolete atlas fetches are aborted while the last complete atlas stays
visible. This avoids blank zoom frames, gaps, flat-map transitions, mirrored
labels, and unrelated-tile jumps, while a minimum radial distance prevents the
viewer entering the globe.

1. Controller ray targeting, teleport-to-place, and landmark selection.
2. Tile cache abstraction and open terrain provider.
3. OpenStreetMap vector overlay plus terrain/imagery provider adapters.
4. Offline bundle manifest and OpenMaps-compatible export adapter.
