# Third-party notices

OpenEarth XR source code is MIT licensed. Its standalone build and npm package
use the following projects and data services. Full software licence texts for
bundled runtime components are copied under `third-party/` in the standalone
distribution; npm-installed dependencies also carry their own licence files.

## Runtime software

| Component                 | Licence      | Purpose                                                 |
| ------------------------- | ------------ | ------------------------------------------------------- |
| CesiumJS                  | Apache-2.0   | Desktop globe, camera, imagery, and building primitives |
| Three.js                  | MIT          | WebXR compositor and immersive globe rendering          |
| `@mapbox/vector-tile`     | BSD-3-Clause | MVT building decoding                                   |
| `@mapbox/point-geometry`  | ISC          | Vector-tile geometry dependency                         |
| `pbf`                     | BSD-3-Clause | Protocol Buffer decoding                                |
| `resolve-protobuf-schema` | MIT          | Protocol Buffer dependency                              |
| `protocol-buffers-schema` | MIT          | Protocol Buffer dependency                              |

Cesium's distribution includes additional third-party works. Its complete
`LICENSE.md`, `ThirdParty.json`, and `ThirdParty.extra.json` are redistributed
with the site and are authoritative for those components.

## Map data

- OpenStreetMap data is © OpenStreetMap contributors and available under the
  Open Data Commons Open Database License (ODbL).
- OpenMapTiles schema/cartography requires visible OpenMapTiles attribution; its
  implementation code and design have separate licences described by the
  project.
- OpenFreeMap hosting/software is MIT licensed; its hosted map data retains the
  underlying OpenMapTiles and OpenStreetMap requirements.
- CARTO Voyager tiles require attribution to CARTO and applicable data providers.

Provider availability does not grant offline, bulk-download, or redistribution
rights. See [providers and licences](docs/providers-and-licenses.md) for the
visible credit text, links, and operational restrictions used by OpenEarth.
