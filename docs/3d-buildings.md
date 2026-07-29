# 3D building feasibility and design

## Decision

3D buildings are viable now as curved extrusion of open vector footprints.
This gives desktop and WebXR the same geometry and supports worldwide data,
self-hosting, offline regional packs, attribution, and graceful LOD limits.

The implementation follows the OpenMapTiles building schema: the `building`
layer supplies `render_height`, `render_min_height`, `colour`, and `hide_3d`.
OSM `height` and level-count fields are accepted as fallbacks, with three metres
per level and a conservative nine-metre final default. See the official
[OpenMapTiles schema](https://openmaptiles.org/schema/#building) and
[OSM Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_buildings).

OpenFreeMap is the built-in token-free network adapter. Its TileJSON URL is
resolved at runtime instead of pinning a dated tile path. Applications that
need availability guarantees should provide their own URL or implement
`BuildingTileProvider` over cached/OpenMaps bundle data.

Token-free does not mean attribution-free or private: tile coordinates and
ordinary request metadata reach the provider. Desktop and immersive views must
both visibly credit OpenFreeMap, OpenMapTiles, and OpenStreetMap. Availability,
offline, and redistribution guidance is maintained in
[providers-and-licenses.md](providers-and-licenses.md).

## Why not use only OGC 3D Tiles?

[OGC 3D Tiles](https://www.ogc.org/standards/3DTiles/) is designed for massive
streaming 3D geospatial content and is the right future option for detailed
landmarks, photogrammetry, and city models. Cesium can load self-hosted
tilesets directly with
[`Cesium3DTileset.fromUrl`](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html).
It does not, however, automatically render in OpenEarth's separate Three.js
WebXR compositor. Making it the only initial path would produce different
desktop and headset experiences or require another substantial scene renderer.

Footprint extrusion is therefore the cross-renderer baseline. Optional 3D
Tiles can be added later as a higher-detail desktop/landmark layer while the
portable footprint layer remains available everywhere.

## Runtime budget

- Buildings activate below city altitude only.
- At most a 5×5 tile neighbourhood is retained per active renderer.
- Geometry is batched per tile, not one draw call per building.
- Obsolete requests are aborted; transient failures retry after a delay.
- Moving away removes CPU/GPU tile state, and viewer destruction disposes all
  materials, geometry, textures, and pending overview requests.

## Current limitations

- Flat roofs only; OSM roof shape/direction tags are not yet modelled.
- Heights follow source coverage and use safe fallbacks where absent.
- Terrain-relative foundations await the planned open terrain provider.
- Highly detailed landmark meshes and photogrammetry remain a later 3D Tiles or
  glTF layer.
