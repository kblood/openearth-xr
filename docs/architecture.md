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

The immersive renderer owns a dedicated XR-compatible WebGL context because
CesiumJS does not yet drive a WebXR compositor loop. It renders the globe to
the headset and maps controller thumbsticks/trackpads to rotate and fly/scale,
with the trigger resetting orbital scale. The desktop and XR camera models are
kept intentionally equivalent.

1. Controller ray targeting, teleport-to-place, and landmark selection.
2. Tile cache abstraction and open terrain provider.
3. OpenStreetMap vector overlay plus terrain/imagery provider adapters.
4. Offline bundle manifest and OpenMaps-compatible export adapter.
