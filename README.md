# OpenEarth XR

[![CI](https://github.com/kblood/openearth-xr/actions/workflows/ci.yml/badge.svg)](https://github.com/kblood/openearth-xr/actions/workflows/ci.yml)

OpenEarth XR is an open-source, WebXR-first globe explorer: an independent foundation for a Google-Earth-like experience that works on the desktop today and in VR where browsers expose WebXR.

The current viewer uses a real ellipsoidal Earth with OpenStreetMap imagery and
continuous camera travel from orbital scale to city scale. Desktop controls
follow the familiar Earth-viewer model: left-drag orbits, right-drag tilts,
the wheel flies, and double-click travels to a point. Built-in place controls
provide Earth, Denmark, and Copenhagen viewpoints.

At city and street altitude, OpenEarth streams open OSM building footprints
and extrudes them on the curved Earth in both Cesium and WebXR. Real
`render_height`, `render_min_height`, colour, multipolygon, and courtyard data
are used when available. The built-in OpenFreeMap adapter works without an API
token; hosts can replace it with self-hosted MVT, cached tiles, or an OpenMaps
bundle adapter through the public `BuildingTileProvider` interface.

## Run

Use Node.js 22.13 or newer:

```bash
npm ci
npm run dev
```

Run the complete deterministic quality gate with `npm run check`. A real
Chromium smoke test is available after `npx playwright install chromium` with
`npm run smoke:browser`; physical WebXR releases also follow the
[headset checklist](docs/headset-release-checklist.md).

Use a recent WebGL 2 browser. On a WebXR headset/browser, **Enter VR** starts
a dedicated immersive compositor session; the desktop Cesium canvas is paused,
so the headset receives one globe only. Look naturally around it. Grip either
controller to anchor the terrain, then drag sideways to pull yourself across
the surface. Pulling the controller toward you descends; pushing it away climbs.
The response is measured in physical hand movement, so it remains controlled at
street scale instead of turning back into a small globe held in one hand. Grip
both controllers to move it with both hands, twist it, or pinch/stretch the
distance between your hands to descend or climb (the headset field of view never changes). At orbital
altitude this changes camera-to-globe distance. As the viewer approaches the
surface, Earth grows smoothly; below aircraft altitude a camera-relative local
tangent surface takes over while the global globe remains behind it. This keeps
the ground at a comfortable physical distance and preserves metre-scale
precision through city, street, and building scale without letting the viewer
pass through the planet.
The right trigger flies toward the pointed location and
the left trigger provides a slow precision flight. **Exit VR** ends the
session and restores the desktop viewer.

Stick input has a precision curve around its dead zone. Pan speed follows real
altitude—from aircraft travel to walking pace—while heading remains usable at
street scale. Zoom speed falls continuously from orbital to ground altitude;
full deflection remains available for deliberate fast travel.

The headset uses a multi-LOD map surface: a global Web-Mercator overview is
reprojected onto the globe, then four atomic XYZ atlases are mapped to exact
longitude/latitude vertices on the same sphere as the viewer approaches the
surface. A broad context atlas stays two zoom levels behind, a 6×6 base atlas
covers the current field of view, a central 4×4 detail atlas stays one level
ahead, and a 2×2 focus atlas supplies the final local-tangent detail. Looking
away from the centre therefore reveals
lower-resolution map coverage instead of an empty overview texture. All layers
use Three.js' equirectangular longitude convention, so
country, city, and street maps remain readable and centred on the location
being viewed rather than mirroring or jumping to an unrelated tile. Each atlas
is replaced atomically and obsolete downloads are cancelled, so the last
complete coverage remains visible while detail updates during fast flight. A hard minimum clearance
from the surface prevents navigation from entering the globe. The
default is CARTO Voyager, a readable Latin-script road style derived from OSM;
the tile provider is isolated behind a configuration seam for a future
Danish-only style or self-hosted service.

The building layer activates only near the surface and keeps a bounded 5×5
tile window. Tile requests are cancelled as the viewer moves, failed requests
retry without blanking existing content, and all geometry, materials, textures,
and requests are released by `destroy()`.
The Three.js renderer and its global XR overview are initialized lazily on the
first XR/preview use, so a desktop-only embed does not allocate a second WebGL
context or download the immersive overview.

The feasibility choices, open-data fields, 3D Tiles tradeoff, and current
limits are documented in [3d-buildings.md](docs/3d-buildings.md).

## Embed in another application

The package exports `OpenEarthViewer`, a UI-independent controller for the
desktop globe and immersive renderer. Hosts can provide their own container,
XR canvas, Cesium imagery provider, immersive XYZ tile provider, initial view,
and camera limits; navigation and XR state are available through methods and an
`xrchange` event. Cesium and Three.js are peer dependencies and stay external
in the ESM library build, so an integrating app owns exactly one copy of each
engine.

OpenMaps integration is available through `OpenMapsRasterProvider`, the
read-only `LegacyOpenMapsIndexedDbStore`, and the generic
`OpenMapsRasterTileStore` contract for OPFS, native, or bundle-backed stores.
Regional sources can be stitched with `CompositeXyzTileProvider`; explicit
persistent network caching is available only where provider terms allow it.
Focused `openearth-xr/core`, `/raster`, `/buildings`, `/adapters`, and `/xr`
exports let host packages depend on one layer without resolving the full barrel.

Run `npm run build:lib` to create the ESM bundle and TypeScript declarations.
See [integration.md](docs/integration.md) for a complete vanilla example,
framework lifecycle guidance, asset setup, and all configuration seams.

## Release

Release verification, artifacts, GitHub tags, and production deployment are
separate auditable steps. Before tagging or deploying, follow the
[release runbook](docs/releasing.md).

```powershell
$env:OPENEARTH_DEPLOY_TARGET = 'deploy@example.org'
$env:OPENEARTH_SSH_KEY = 'C:\secure\deploy-key' # optional with ssh-agent
npm run release
```

The script runs all checks, uploads a checksummed immutable release, atomically
switches the live symlink, verifies `release.json` over HTTPS, rolls back on a
failed health check, and retains prior releases. Tagged GitHub releases are
packaged with a site archive, npm tarball, CycloneDX SBOM, and SHA-256 sums.

## Data, licences, and privacy

The default standalone viewer contacts OpenStreetMap for desktop imagery, CARTO
for immersive imagery, and OpenFreeMap for building vectors. Optional online
place search contacts Nominatim only after the user enables it and submits a
query. Network searches are limited to one per second per browser instance and
the most recent 100 normalized results are cached in memory. **Locate me**
requests browser geolocation only after a click.
Provider requests can reveal the area being viewed or searched. See [PRIVACY.md](PRIVACY.md)
and [provider/licence guidance](docs/providers-and-licenses.md) before embedding,
self-hosting, caching, or building offline regions. Software redistribution
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Direction

OpenEarth remains its own project and does not import or require the OpenMaps
repository. It now exposes store/provider adapters for OpenMaps-compatible
raster data plus a validated `openearth-region-v1` manifest and cross-pack
provider factory. Portable archive/export tooling and non-raster manifest
capabilities remain planned. See [architecture.md](docs/architecture.md).

## Status

Early Google-Earth-like viewer. Map imagery and orbital-to-ground camera travel
are implemented on desktop. The headset view now uses Three.js's WebXR
compositor integration (rather than manual per-eye rendering), geographically
aligned globe-to-surface tiles, and controller grab/orbit/distance/flight input.
The immersive navigation model now continues from orbit through building-level
map detail without placing a small globe around the viewer. Curved 3D buildings
are implemented in both render paths, along with built-in coordinate/place
search and opt-in Nominatim search. Open terrain, richer roof models, and offline
archive/export tooling remain planned layers.

## License

MIT. See [LICENSE](LICENSE).

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md). Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md), and see
[CHANGELOG.md](CHANGELOG.md) for release history.
