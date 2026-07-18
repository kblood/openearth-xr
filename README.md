# OpenEarth XR

OpenEarth XR is an open-source, WebXR-first globe explorer: an independent foundation for a Google-Earth-like experience that works on the desktop today and in VR where browsers expose WebXR.

This initial milestone renders an interactive procedural globe, supports mouse/touch rotation and zoom, and can enter an `immersive-vr` session. It intentionally has no map-data dependency yet.

## Run

```bash
npm install
npm run dev
```

Use a recent WebGL 2 browser. For VR, serve over HTTPS (or localhost) in a WebXR-capable browser with an enabled headset.

## Direction

OpenEarth will be its own project. It will define an adapter for portable, offline regional bundles compatible with the OpenMaps bundle philosophy—but will not import or require the OpenMaps repository. See [architecture.md](docs/architecture.md).

## Status

Experimental foundation, not a replacement for Google Earth. The globe texture is procedural placeholder terrain; imagery, terrain, search, and offline bundle loading are planned layers.

## License

MIT. See [LICENSE](LICENSE).
