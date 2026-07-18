import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  Cartesian3,
  Cartesian2,
  Cartographic,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium';
import './style.css';
import { XrGlobeRenderer } from './xr/XrGlobeRenderer';

// Cesium resolves workers, imagery helpers, and widgets relative to this URL.
// The Vite build copies the complete, version-matched runtime to dist/cesium.
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = './cesium/';

const container = document.querySelector<HTMLElement>('#globe');
const xrCanvas = document.querySelector<HTMLCanvasElement>('#xr-globe');
const vrButton = document.querySelector<HTMLButtonElement>('#enter-vr');
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view');
const status = document.querySelector<HTMLElement>('#status');
if (!container || !xrCanvas || !vrButton || !resetButton || !status) throw new Error('OpenEarth UI failed to initialise.');

const viewer = new Viewer(container, {
  baseLayer: new ImageryLayer(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })),
  terrainProvider: new EllipsoidTerrainProvider(),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: true,
});

viewer.scene.globe.enableLighting = true;
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 15;
viewer.scene.screenSpaceCameraController.maximumZoomDistance = 60_000_000;
viewer.scene.camera.frustum.near = 1;

type Place = { lon: number; lat: number; height: number; pitch?: number };
const places: Record<string, Place> = {
  earth: { lon: 10, lat: 34, height: 5_000_000, pitch: -CesiumMath.PI_OVER_TWO },
  denmark: { lon: 10.2, lat: 56.1, height: 1_000_000, pitch: -CesiumMath.PI_OVER_TWO },
  copenhagen: { lon: 12.5683, lat: 55.6761, height: 6_000, pitch: -CesiumMath.toRadians(52) },
};

function flyTo(place: Place): void {
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(place.lon, place.lat, place.height),
    orientation: { heading: 0, pitch: place.pitch ?? -CesiumMath.PI_OVER_TWO, roll: 0 },
    duration: 1.6,
  });
}

flyTo(places.earth);
resetButton.addEventListener('click', () => flyTo(places.earth));
document.querySelectorAll<HTMLButtonElement>('[data-place]').forEach((button) => {
  button.addEventListener('click', () => flyTo(places[button.dataset.place ?? 'earth'] ?? places.earth));
});

// Google Earth-style double-click travel: target the actual ellipsoid point,
// then preserve a comfortable altitude rather than jumping through the globe.
viewer.screenSpaceEventHandler.setInputAction((movement: { position: { x: number; y: number } }) => {
  const position = viewer.camera.pickEllipsoid(new Cartesian2(movement.position.x, movement.position.y), viewer.scene.globe.ellipsoid);
  if (!position) return;
  const target = Cartographic.fromCartesian(position);
  viewer.camera.flyTo({
    destination: Cartesian3.fromRadians(target.longitude, target.latitude, 10_000),
    orientation: { heading: viewer.camera.heading, pitch: -CesiumMath.toRadians(55), roll: 0 },
    duration: 1.2,
  });
}, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

const xrGlobe = new XrGlobeRenderer(xrCanvas);
const desktopStatus = 'Left drag orbits · right drag tilts · wheel flies · double-click travels';
const previewParams = new URLSearchParams(window.location.search);
const xrPreview = Number(previewParams.get('xrPreview'));

function leaveXrUi(): void {
  document.body.classList.remove('xr-active');
  viewer.useDefaultRenderLoop = true;
  vrButton!.disabled = false;
  vrButton!.textContent = 'Enter VR';
  status!.textContent = desktopStatus;
}

function enterXrUi(): void {
  // The headset must receive one compositor-owned canvas. Pausing and hiding
  // Cesium also prevents its desktop canvas from appearing in the mirror.
  viewer.useDefaultRenderLoop = false;
  document.body.classList.add('xr-active');
  vrButton!.disabled = false;
  vrButton!.textContent = 'Exit VR';
  status!.textContent = 'VR: right grip grabs the globe · right trigger flies toward its ray · left trigger flies slowly · left stick pans · right stick turns/zooms.';
}

if (Number.isFinite(xrPreview) && xrPreview > 0) {
  viewer.useDefaultRenderLoop = false;
  document.body.classList.add('xr-active');
  xrGlobe.startPreview(xrPreview, Number(previewParams.get('lon') ?? 10.2), Number(previewParams.get('lat') ?? 56.1));
} else if (!navigator.xr) {
  vrButton.disabled = true;
  vrButton.textContent = 'WebXR unavailable';
  status.textContent = 'Earth imagery ready. Use a WebXR-capable browser for headset view.';
} else {
  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (!supported) { vrButton.disabled = true; vrButton.textContent = 'VR unsupported'; }
  }).catch(() => { vrButton.disabled = true; vrButton.textContent = 'VR unavailable'; });
  vrButton.addEventListener('click', async () => {
    try {
      if (xrGlobe.active) {
        vrButton.disabled = true;
        await xrGlobe.exit();
        return;
      }
      vrButton.disabled = true;
      await xrGlobe.enter(leaveXrUi, enterXrUi);
    } catch (error) {
      vrButton.disabled = false;
      status.textContent = `Could not enter immersive VR: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  });
}
