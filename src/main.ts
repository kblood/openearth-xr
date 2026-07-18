import './style.css';
import { GlobeRenderer } from './rendering/GlobeRenderer';

const canvas = document.querySelector<HTMLCanvasElement>('#globe');
const vrButton = document.querySelector<HTMLButtonElement>('#enter-vr');
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view');
const status = document.querySelector<HTMLElement>('#status');

if (!canvas || !vrButton || !resetButton || !status) throw new Error('OpenEarth UI failed to initialise.');

const globe = new GlobeRenderer(canvas);
globe.start();

resetButton.addEventListener('click', () => globe.resetView());

const xr = navigator.xr;
if (!xr) {
  vrButton.disabled = true;
  vrButton.textContent = 'WebXR unavailable';
  status.textContent = 'Desktop globe ready. Use a WebXR-capable browser for VR.';
} else {
  xr.isSessionSupported('immersive-vr').then((supported) => {
    if (!supported) {
      vrButton.disabled = true;
      vrButton.textContent = 'VR not supported';
    }
  }).catch(() => {
    vrButton.disabled = true;
    vrButton.textContent = 'VR unavailable';
  });

  vrButton.addEventListener('click', async () => {
    try {
      if (globe.xrSession) {
        await globe.xrSession.end();
        return;
      }
      const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
      await globe.enterXR(session);
      vrButton.textContent = 'Exit VR';
      status.textContent = 'VR active. Look around and use your headset controls.';
      session.addEventListener('end', () => {
        vrButton.textContent = 'Enter VR';
        status.textContent = 'Desktop globe ready. Drag to rotate · scroll to zoom';
      }, { once: true });
    } catch (error) {
      status.textContent = `Could not enter VR: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  });
}
