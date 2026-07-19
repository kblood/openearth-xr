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
the WebXR target ray's local `-Z` direction. Single-controller grip anchors the
current terrain under the hand. Tangential translation rotates Earth by exactly
the corresponding physical surface distance, while radial translation changes
the shared virtual altitude. Controller orientation is deliberately ignored for
one-hand drag, so a wrist turn does not make the user feel as if they are holding
a miniature globe. Dual grip applies a midpoint-preserving transform where hand
separation changes virtual altitude and the hand-to-hand vector rotates Earth.
Flight, pinch, and stick zoom all use this altitude; field of view never changes.

Navigation has two continuous regimes. Above a globe-local altitude of `0.32`,
Earth remains at scale 1 and travel changes physical camera-to-centre distance.
Below that threshold, Earth scales smoothly up to 4000× while its surface stays
at a constant comfortable physical clearance through the final available LOD.
Globe-local altitude still decreases, so
the tile selector advances from aircraft to city, street, and building LOD.
Collision uses scaled radius plus physical clearance, rather than an unscaled
fixed radius. Grab translation is converted through the current physical Earth
radius, keeping the terrain-to-hand gain constant after the scale transition.

Thumbstick axes are remapped quadratically outside the dead zone. Angular turn
gain is divided by the effective Earth scale, which bounds near-surface ground
speed, while zoom rate interpolates logarithmically from orbital to minimum
altitude. Two-hand pinch uses the same proximity value to reduce its exponent
near the surface.

The map surface is a multi-LOD renderer. An orbital parent globe receives a
Web-Mercator XYZ overview reprojected to equirectangular UVs; this avoids
incorrectly stretching a single Mercator tile across a sphere. Near the
surface, three independently atomic atlases are loaded around the viewer's
nadir: a broad 6×6 context layer at `base - 2`, a 6×6 base layer chosen from
globe-local virtual altitude, camera FOV, aspect ratio, and Mercator latitude
stretch, and a central 4×4 detail layer at `base + 1`. The context layer keeps
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

1. Controller ray targeting, teleport-to-place, and landmark selection.
2. Tile cache abstraction and open terrain provider.
3. OpenStreetMap vector overlay plus terrain/imagery provider adapters.
4. Offline bundle manifest and OpenMaps-compatible export adapter.
