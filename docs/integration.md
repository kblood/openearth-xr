# Integrating OpenEarth XR

OpenEarth exposes an embeddable `OpenEarthViewer` in addition to the standalone
website. The host application owns its controls and layout; the viewer owns the
Cesium desktop globe, WebXR renderer, navigation, and cleanup.

## Build and consume the library

Until an npm registry release is configured, consume the repository as a
workspace or local file dependency:

```bash
cd ../openearth
npm install
npm run build:lib

cd ../your-app
npm install ../openearth
```

Git and local installs run the package's `prepare` hook, which creates the
library output after dependencies are installed.

The library build emits:

- `dist-lib/openearth.js` — ESM entrypoint;
- `dist-lib/types/` — TypeScript declarations and declaration maps.

Cesium and Three.js remain external dependencies in the library build so a host
does not load duplicate render engines or conflicting WebXR singletons.

## Vanilla TypeScript

```ts
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  OpenEarthViewer,
  OPENEARTH_VIEWS,
  type OpenEarthXrChangeDetail,
} from 'openearth-xr';

const container = document.querySelector<HTMLElement>('#earth');
if (!container) throw new Error('Missing #earth');

const earth = new OpenEarthViewer({
  container,
  // Copy Cesium's runtime folders here as part of the host build.
  cesiumBaseUrl: '/vendor/cesium/',
  initialView: OPENEARTH_VIEWS.denmark,
});

earth.addEventListener('xrchange', (event) => {
  const { active } = (event as CustomEvent<OpenEarthXrChangeDetail>).detail;
  document.body.classList.toggle('in-xr', active);
});

document.querySelector('#aarhus')?.addEventListener('click', () => {
  earth.flyTo({ longitude: 10.2039, latitude: 56.1629, height: 8_000 });
});
document.querySelector('#vr')?.addEventListener('click', async () => {
  if (earth.xrActive) await earth.exitXr();
  else await earth.enterXr();
});

// When the host removes the view:
await earth.destroy();
```

Give the container an explicit size:

```css
#earth {
  width: 100%;
  min-height: 32rem;
}
```

If `xrCanvas` is omitted, OpenEarth creates and owns an overlay canvas inside
the container. A host may pass its own canvas when it needs complete layout
control.

## Configuration seams

- `imageryProvider` accepts a host-created Cesium imagery provider.
- `imageryUrl` changes the default desktop OpenStreetMap XYZ endpoint.
- `xrTileProvider` changes the immersive raster XYZ provider and its LODs.
- `cesiumBaseUrl` points to the host's copied Cesium runtime assets.
- `minimumZoomDistance` and `maximumZoomDistance` tune desktop camera limits.
- `initialView` controls the reset destination.

The exported `XrGlobeRenderer`, `XyzTileGlobe`, and `XyzTileProvider` are lower
level extension points for applications that want to build their own scene or
connect OpenEarth to an OpenMaps-compatible raster tile adapter.

An XR provider can expose ordinary tile URLs or load decoded images directly
from application storage:

```ts
const xrTileProvider = {
  id: 'host-cache',
  minZoom: 0,
  maxZoom: 18,
  attribution: 'Host map data',
  async loadTile(z: number, x: number, y: number) {
    const bytes = await hostTileCache.getRasterTile(z, x, y);
    if (!bytes) return null;
    return createImageBitmap(new Blob([bytes]));
  },
};

const earth = new OpenEarthViewer({ container, xrTileProvider });
```

This is the seam for cached/OPFS tiles and for a future OpenMaps raster adapter;
no loopback web server or object-URL bookkeeping is required.

## Framework lifecycle

Create one viewer after the container mounts and call `destroy()` before it is
removed. In React, Vue, or Svelte, keep the instance in a ref rather than in
reactive state. WebXR entry must be initiated by a user gesture; call
`isXrSupported()` to decide whether to show the button.
