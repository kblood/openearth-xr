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

`GlobeRenderer` is deliberately small: it owns the WebGL context, normal desktop animation loop, and an `XRWebGLLayer` loop. It is the seam where stereo camera projection, terrain tiles, and XR controllers will be added.

## Offline regional bundle contract (planned)

OpenEarth will consume a versioned manifest rather than a repository package. A future `openearth-region-v1` manifest will identify:

- geographic bounds and level-of-detail coverage;
- raster/vector terrain and map assets with checksums;
- optional search/routing data declared as independent capabilities;
- attribution and licence metadata.

An adapter can then translate OpenMaps-compatible regional exports into this contract, while each project stays independently buildable and releasable.

## Roadmap

1. Add real camera matrices and stereoscopic XR projection.
2. Tile pyramid and local cache abstraction.
3. OpenStreetMap vector overlay plus terrain/imagery provider adapters.
4. Offline bundle manifest and OpenMaps-compatible export adapter.
5. VR interaction: ray selection, teleport/fly controls, scale modes, and landmarks.
