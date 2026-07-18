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
trackpad (axes 0/1) layouts rotate/change globe distance, while trigger resets
the orbital view. Single-controller grip applies controller translation and
rotation to the globe; dual grip applies a midpoint-preserving transform where
hand separation changes globe scale and the hand-to-hand vector rotates it.
The map surface is a visible-only Web-Mercator XYZ tile layer over a
low-resolution parent globe: coarse regional, city, and street tiles remain
nested around the current viewer-facing location, loaded with a bounded
concurrency/cache, and evicted with their GPU resources. This enables detailed
mapping without bulk-prefetching a world tile pyramid.

1. Controller ray targeting, teleport-to-place, and landmark selection.
2. Tile cache abstraction and open terrain provider.
3. OpenStreetMap vector overlay plus terrain/imagery provider adapters.
4. Offline bundle manifest and OpenMaps-compatible export adapter.
