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
so the headset receives one globe only. Look naturally around it. Either
controller thumbstick/trackpad rotates the Earth sideways and changes its
distance vertically; the trigger resets a comfortable orbital view. **Exit
VR** ends the session and restores the desktop viewer.

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
compositor integration (rather than manual per-eye rendering) with controller
orbit/distance/reset input. Open terrain, search, high-detail XR tiles, and
offline bundles are planned layers.

## License

MIT. See [LICENSE](LICENSE).
