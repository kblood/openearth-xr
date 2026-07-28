import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import {
  OpenEarthViewer,
  OPENEARTH_VIEWS,
  type OpenEarthXrChangeDetail,
} from './index';

const container = document.querySelector<HTMLElement>('#globe');
const xrCanvas = document.querySelector<HTMLCanvasElement>('#xr-globe');
const vrButton = document.querySelector<HTMLButtonElement>('#enter-vr');
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view');
const status = document.querySelector<HTMLElement>('#status');
if (!container || !xrCanvas || !vrButton || !resetButton || !status) {
  throw new Error('OpenEarth UI failed to initialise.');
}

const earth = new OpenEarthViewer({ container, xrCanvas, cesiumBaseUrl: './cesium/' });
const desktopStatus = 'Left drag orbits · right drag tilts · wheel flies · double-click travels';
const previewParams = new URLSearchParams(window.location.search);
const xrPreview = Number(previewParams.get('xrPreview'));

function setXrUi(active: boolean): void {
  document.body.classList.toggle('xr-active', active);
  vrButton!.disabled = false;
  vrButton!.textContent = active ? 'Exit VR' : 'Enter VR';
  status!.textContent = active
    ? 'VR: grip drags terrain · two grips twist/pinch · triggers fly · sticks pan, turn, and zoom.'
    : desktopStatus;
}

earth.addEventListener('xrchange', (event) => {
  setXrUi((event as CustomEvent<OpenEarthXrChangeDetail>).detail.active);
});

resetButton.addEventListener('click', () => earth.reset());
document.querySelectorAll<HTMLButtonElement>('[data-place]').forEach((button) => {
  button.addEventListener('click', () => {
    const id = button.dataset.place as keyof typeof OPENEARTH_VIEWS | undefined;
    earth.flyTo(id ? OPENEARTH_VIEWS[id] : OPENEARTH_VIEWS.earth);
  });
});

if (Number.isFinite(xrPreview) && xrPreview > 0) {
  document.body.classList.add('xr-active');
  earth.startPreview({
    distance: xrPreview,
    longitude: Number(previewParams.get('lon') ?? 10.2),
    latitude: Number(previewParams.get('lat') ?? 56.1),
    scale: Number(previewParams.get('xrScale') ?? 1),
  });
} else {
  void earth.isXrSupported().then((supported) => {
    if (!supported) {
      vrButton.disabled = true;
      vrButton.textContent = 'WebXR unavailable';
      status.textContent = 'Earth imagery ready. Use a WebXR-capable browser for headset view.';
    }
  });
  vrButton.addEventListener('click', async () => {
    try {
      vrButton.disabled = true;
      if (earth.xrActive) await earth.exitXr();
      else await earth.enterXr();
    } catch (error) {
      vrButton.disabled = false;
      status.textContent = `Could not change immersive VR: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  });
}
