# OpenEarth XR

OpenEarth XR is an open-source, WebXR-first globe explorer: an independent foundation for a Google-Earth-like experience that works on the desktop today and in VR where browsers expose WebXR.

The current viewer uses a real ellipsoidal Earth with OpenStreetMap imagery and
continuous camera travel from orbital scale to city scale. Desktop controls
follow the familiar Earth-viewer model: left-drag orbits, right-drag tilts,
the wheel flies, and double-click travels to a point. Built-in place controls
provide Earth, Denmark, and Copenhagen viewpoints.

## Run

```bash
npm install
npm run dev
```

Use a recent WebGL 2 browser. On a WebXR headset/browser, **Enter VR** starts
a dedicated immersive compositor session; the desktop Cesium canvas is paused,
so the headset receives one globe only. Look naturally around it. Grip either
controller to anchor the terrain, then drag sideways to pull yourself across
the surface. Pulling the controller toward you descends; pushing it away climbs.
The response is measured in physical hand movement, so it remains controlled at
street scale instead of turning back into a small globe held in one hand. Grip
both controllers to move it with both hands, twist it, or pinch/stretch the
distance between your hands to descend or climb (the headset field of view never changes). At orbital
altitude this changes camera-to-globe distance. Below the flight threshold,
Earth scales dynamically up to 4000× while the surface stays comfortably in front of the viewer,
allowing continuous travel through aircraft, city, street, and building scale.
The right trigger flies toward the pointed location and
the left trigger provides a slow precision flight. **Exit VR** ends the
session and restores the desktop viewer.

Stick input has a precision curve around its dead zone. Turn/pan speed is
reduced as Earth scales up, and zoom speed falls continuously from orbital to
street altitude; full deflection remains available for deliberate fast travel.

The headset uses a multi-LOD map surface: a global Web-Mercator overview is
reprojected onto the globe, then three atomic XYZ atlases are mapped to exact
longitude/latitude vertices on the same sphere as the viewer approaches the
surface. A broad context atlas stays two zoom levels behind, a 6×6 base atlas
covers the current field of view, and a central 4×4 atlas stays one level ahead
to bring street names in sooner. Looking away from the centre therefore reveals
lower-resolution map coverage instead of an empty overview texture. All layers
use Three.js' equirectangular longitude convention, so
country, city, and street maps remain readable and centred on the location
being viewed rather than mirroring or jumping to an unrelated tile. Each atlas
is replaced atomically and obsolete downloads are cancelled, so the last
complete coverage remains visible while detail updates during fast flight. A hard minimum clearance
from the scaled surface prevents navigation from entering the globe. The
default is CARTO Voyager, a readable Latin-script road style derived from OSM;
the tile provider is isolated behind a configuration seam for a future
Danish-only style or self-hosted service.

## Release

```powershell
npm run release
```

This atomically deploys the built site to `https://dionysus.dk/openearth/`.

## Direction

OpenEarth will be its own project. It will define an adapter for portable, offline regional bundles compatible with the OpenMaps bundle philosophy—but will not import or require the OpenMaps repository. See [architecture.md](docs/architecture.md).

## Status

Early Google-Earth-like viewer. Map imagery and orbital-to-ground camera travel
are implemented on desktop. The headset view now uses Three.js's WebXR
compositor integration (rather than manual per-eye rendering), geographically
aligned globe-to-surface tiles, and controller grab/orbit/distance/flight input.
The immersive navigation model now continues from orbit through building-level
map detail without placing a small globe around the viewer.
Open terrain, search, and offline bundles are planned layers.

## License

MIT. See [LICENSE](LICENSE).
