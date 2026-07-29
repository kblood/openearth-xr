# Changelog

Notable changes to OpenEarth XR are documented here. The project follows
[Semantic Versioning](https://semver.org/) for its public package API.

## Unreleased

## 0.5.0 - 2026-07-29

### Added

- Reproducible app and library cleanup/build steps, package validation, Chromium
  smoke testing, and Node 22/24 CI.
- Immutable deployment staging with checksums, health verification, automatic
  rollback, and retained releases.
- Release tarballs, npm package artifacts, CycloneDX SBOM generation, and
  checksums for tagged GitHub releases.
- Security, privacy, provider/licensing, contribution, release, testing, and
  physical-headset guidance.
- OpenMaps-compatible raster store adapters, a legacy IndexedDB bridge,
  regional-provider composition, and opt-in persistent caching primitives.
- Validated `openearth-region-v1` manifests and a bounds-aware multi-pack
  provider factory with optional per-layer stores and global fallbacks.
- Focused `core`, `raster`, `buildings`, `adapters`, and `xr` package exports
  with matching ESM and declaration entry points.
- Deterministic immersive star field and altitude-faded atmospheric shell.
- Priority-based raster scheduling with request deduplication, leased LRU
  bitmaps, negative/error backoff, provider coverage routing, four map LOD
  rings, and a true near-origin tangent focus surface.
- Search and coordinates, opt-in rate-limited Nominatim, shareable camera URLs,
  bookmarks/import/export, measurement, a Denmark tour, layer/comfort settings,
  keyboard navigation, geolocation, and an installable same-origin PWA shell.
- Typed viewer lifecycle/view/source events, cancellation-aware travel,
  terrain/provider seams, attribution reporting, and synchronized desktop/XR
  state.

### Changed

- Library runtime dependencies are externalized consistently while source files
  are included so declaration and JavaScript source maps remain resolvable.
- Static deployments now include third-party license material and explicit
  cache, content-security, WebXR permission, and transport headers.
- Building streams now use bounded queues and density budgets, cancellation,
  retry backoff, TileJSON validation, local origins, tangent geometry, and
  complete suspend/resume/disposal semantics across both renderers.
- XR input now uses grip poses, hand pinches, haptics, consistent one/two-hand
  drag/twist/zoom, altitude-aware travel, permission-safe session fallback,
  final-pose handoff, adaptive foveation, and compositor depth-range updates.

### Fixed

- Prevented mirrored labels, unrelated or shrinking close-up tiles, blank atlas
  replacement, zoom-through, street-level heading stalls, mismatched snap-turn
  direction, duplicate globe presentation, and cancelled-flight page errors.
- Scoped service-worker cleanup to OpenEarth caches so it cannot delete another
  application’s caches on the shared dionysus.dk origin.

## 0.4.0 - 2026-07-29

### Added

- Curved 3D building extrusion in Cesium desktop and Three.js/WebXR views.
- Renderer-independent `BuildingTileProvider` and MVT adapter APIs.
- OpenFreeMap/OpenMapTiles building support with height, minimum height, colour,
  courtyard, and multipolygon handling.
- Lazy WebXR initialization and complete renderer cleanup.
- Automated MVT decoding and curved building geometry tests.

## 0.2.0 - 2026-07-18

### Added

- WebXR compositor rendering and controller-driven globe navigation.
- Curved, geographically aligned multi-LOD raster tile atlases.
