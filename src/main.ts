import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import {
  Cartesian2,
  Credit,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
} from 'cesium';
import {
  OpenEarthViewer,
  OPENEARTH_VIEWS,
  type OpenEarthView,
  type OpenEarthViewChangeDetail,
  type OpenEarthXrChangeDetail,
} from './index';
import { BookmarkStore } from './features/Bookmarks';
import { MeasurementController, formatDistance } from './features/Measurement';
import {
  CompositeSearchProvider,
  NominatimSearchProvider,
  StaticSearchProvider,
  type SearchResult,
} from './features/Search';
import { DENMARK_TOUR, GuidedTour, type TourChangeDetail } from './features/Tour';

const container = required<HTMLElement>('#globe');
const xrCanvas = required<HTMLCanvasElement>('#xr-globe');
const vrButton = required<HTMLButtonElement>('#enter-vr');
const exitVrButton = required<HTMLButtonElement>('#exit-vr');
const resetButton = required<HTMLButtonElement>('#reset-view');
const status = required<HTMLElement>('#status');
const hud = required<HTMLElement>('.hud');
const showUiButton = required<HTMLButtonElement>('#show-ui');
const searchForm = required<HTMLFormElement>('#search-form');
const searchInput = required<HTMLInputElement>('#search-input');
const searchResults = required<HTMLOListElement>('#search-results');
const panel = required<HTMLElement>('#tool-panel');
const panelTitle = required<HTMLElement>('#tool-panel-title');
const panelContent = required<HTMLElement>('#panel-content');
const sourceAttribution = required<HTMLElement>('#source-attribution');

const params = new URLSearchParams(window.location.search);
const initialView = viewFromUrl(params) ?? OPENEARTH_VIEWS.earth;
const savedTurnMode = preference('turnMode') === 'smooth' ? 'smooth' : 'snap';
const qualityPreference = preference('quality');
const savedQuality = qualityPreference === 'quality' || qualityPreference === 'performance' ? qualityPreference : 'balanced';
const preferredMapStyle = preference('mapStyle');
const earth = new OpenEarthViewer({
  container,
  xrCanvas,
  cesiumBaseUrl: './cesium/',
  initialView,
  xrComfort: {
    turnMode: savedTurnMode,
    foveation: qualityFoveation(savedQuality),
    handTracking: true,
  },
});

const bookmarks = new BookmarkStore();
const measurement = new MeasurementController(earth.viewer);
const tour = new GuidedTour(earth, DENMARK_TOUR);
const localSearch = new StaticSearchProvider();
const onlineSearch = new NominatimSearchProvider();
let searchAbort: AbortController | null = null;
let deferredInstall: BeforeInstallPromptEvent | null = null;
let currentMapStyle = preferredMapStyle === 'voyager' || preferredMapStyle === 'dark' ? preferredMapStyle : 'osm';
let buildingsEnabled = preference('buildings') !== 'false';
let lightingEnabled = preference('lighting') !== 'false';
let panelReturnFocus: HTMLElement | null = null;

const text = {
  en: {
    desktop: 'Drag to orbit · right drag to tilt · wheel flies · double-click travels',
    xr: 'VR: grip and drag terrain · two grips twist/pinch · triggers fly · sticks pan, turn, and zoom.',
    ready: 'Earth ready.',
    offline: 'Offline: showing data already available on this device.',
  },
  da: {
    desktop: 'Træk for at rotere · højreklik og træk for at vippe · scroll for at flyve',
    xr: 'VR: grib og træk terrænet · to greb drejer/zoomer · aftrækkere flyver.',
    ready: 'Jorden er klar.',
    offline: 'Offline: viser data som allerede findes på enheden.',
  },
} as const;
let language: keyof typeof text = preference('language') === 'da' ? 'da' : 'en';
applyLanguage(language);
earth.setBuildingsEnabled(buildingsEnabled);
earth.setLightingEnabled(lightingEnabled);
if (currentMapStyle !== 'osm') setMapStyle(currentMapStyle);

function setXrUi(active: boolean): void {
  document.body.classList.toggle('xr-active', active);
  vrButton.disabled = false;
  vrButton.textContent = active ? 'Exit VR' : 'Enter VR';
  exitVrButton.hidden = !active;
  status.textContent = active ? text[language].xr : onlineStatus();
  if (!active) vrButton.focus({ preventScroll: true });
}

earth.addEventListener('xrchange', (event) => {
  setXrUi((event as CustomEvent<OpenEarthXrChangeDetail>).detail.active);
});
earth.addEventListener('viewchange', (event) => {
  const view = (event as CustomEvent<OpenEarthViewChangeDetail>).detail.view;
  document.title = `OpenEarth · ${view.latitude.toFixed(2)}, ${view.longitude.toFixed(2)}`;
});
earth.addEventListener('sourceerror', (event) => {
  const error = (event as CustomEvent<{ error: Error }>).detail.error;
  status.textContent = `Map source problem: ${error.message}`;
});

resetButton.addEventListener('click', () => runTravel(earth.reset(reducedMotionDuration(1.6))));
vrButton.addEventListener('click', changeXr);
exitVrButton.addEventListener('click', changeXr);
required<HTMLButtonElement>('#share-view').addEventListener('click', shareCurrentView);
required<HTMLButtonElement>('#locate-me').addEventListener('click', locateUser);

document.querySelectorAll<HTMLButtonElement>('[data-place]').forEach((button) => {
  button.addEventListener('click', () => {
    const id = button.dataset.place;
    if (id && Object.hasOwn(OPENEARTH_VIEWS, id)) {
      runTravel(earth.flyTo(OPENEARTH_VIEWS[id as keyof typeof OPENEARTH_VIEWS], reducedMotionDuration(1.6)));
    }
  });
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runSearch(searchInput.value);
});
searchInput.addEventListener('input', () => {
  if (!searchInput.value.trim()) setSearchResultsVisible(false);
});

required<HTMLButtonElement>('#measure').addEventListener('click', (event) => {
  const active = measurement.toggle();
  (event.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(active));
  status.textContent = active ? 'Select two points on Earth.' : onlineStatus();
});
measurement.addEventListener('change', (event) => {
  const detail = (event as CustomEvent<{ distanceMeters: number; points: number }>).detail;
  if (detail.distanceMeters > 0) status.textContent = `Measured ${formatDistance(detail.distanceMeters)}.`;
});

required<HTMLButtonElement>('#bookmark').addEventListener('click', () => {
  const name = window.prompt('Name this view');
  if (!name) return;
  try {
    bookmarks.add(name, earth.getView());
    status.textContent = `Saved “${name.trim()}”.`;
  } catch (error) {
    status.textContent = `Could not save bookmark: ${error instanceof Error ? error.message : 'storage unavailable'}`;
  }
});
required<HTMLButtonElement>('#bookmarks').addEventListener('click', showBookmarks);
required<HTMLButtonElement>('#layers').addEventListener('click', showLayers);
required<HTMLButtonElement>('#data-info').addEventListener('click', showDataInfo);
required<HTMLButtonElement>('#tour').addEventListener('click', (event) => {
  if (tour.running) tour.stop();
  else runTravel(tour.start());
  (event.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(tour.running));
});
required<HTMLButtonElement>('#stop-tour').addEventListener('click', () => tour.stop());
tour.addEventListener('change', (event) => updateTourUi((event as CustomEvent<TourChangeDetail>).detail));

required<HTMLButtonElement>('#close-panel').addEventListener('click', closePanel);
required<HTMLButtonElement>('#toggle-ui').addEventListener('click', () => {
  hud.hidden = true;
  showUiButton.hidden = false;
  showUiButton.focus();
});
showUiButton.addEventListener('click', () => {
  hud.hidden = false;
  showUiButton.hidden = true;
  searchInput.focus();
});

earth.viewer.screenSpaceEventHandler.setInputAction((movement: { position: Cartesian2 }) => {
  if (measurement.enabled) return;
  const picked = earth.viewer.scene.pick(movement.position);
  if (!picked || picked.id === undefined) return;
  status.textContent = `Selected building ${String(picked.id)}.`;
}, ScreenSpaceEventType.LEFT_CLICK);

container.addEventListener('keydown', (event) => {
  const view = earth.getView();
  const step = Math.max(0.001, view.height / 2_000_000);
  let next: OpenEarthView | null = null;
  if (event.key === 'ArrowLeft') next = { ...view, longitude: view.longitude - step };
  if (event.key === 'ArrowRight') next = { ...view, longitude: view.longitude + step };
  if (event.key === 'ArrowUp') next = { ...view, latitude: view.latitude + step };
  if (event.key === 'ArrowDown') next = { ...view, latitude: view.latitude - step };
  if (event.key === '+' || event.key === '=') next = { ...view, height: Math.max(2, view.height / 1.8) };
  if (event.key === '-' || event.key === '_') next = { ...view, height: Math.min(100_000_000, view.height * 1.8) };
  if (!next) return;
  event.preventDefault();
  runTravel(earth.flyTo(next, reducedMotionDuration(0.35)));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setSearchResultsVisible(false);
    closePanel();
  }
});

window.addEventListener('online', () => { status.textContent = onlineStatus(); });
window.addEventListener('offline', () => { status.textContent = onlineStatus(); });
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as BeforeInstallPromptEvent;
  required<HTMLButtonElement>('#install-app').hidden = false;
});
required<HTMLButtonElement>('#install-app').addEventListener('click', async () => {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  deferredInstall = null;
  required<HTMLButtonElement>('#install-app').hidden = true;
});

const xrPreview = finiteNumber(params.get('xrPreview'));
if (xrPreview !== null && xrPreview > 0) {
  document.body.classList.add('xr-active');
  earth.startPreview({
    distance: xrPreview,
    longitude: boundedNumber(params.get('lon'), -180, 180) ?? 10.2,
    latitude: boundedNumber(params.get('lat'), -90, 90) ?? 56.1,
    scale: boundedNumber(params.get('xrScale'), 1, 1_000_000) ?? 1,
  });
} else {
  void earth.isXrSupported().then((supported) => {
    if (!supported) {
      vrButton.disabled = true;
      vrButton.textContent = 'WebXR unavailable';
    }
    status.textContent = onlineStatus();
  });
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined);
  }, { once: true });
}

window.addEventListener('beforeunload', () => {
  measurement.destroy();
  tour.stop();
  void earth.destroy();
}, { once: true });

async function changeXr(): Promise<void> {
  try {
    vrButton.disabled = true;
    if (earth.xrActive) await earth.exitXr();
    else await earth.enterXr();
  } catch (error) {
    status.textContent = `Could not change VR: ${error instanceof Error ? error.message : 'unknown error'}`;
  } finally {
    vrButton.disabled = false;
  }
}

async function runSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    setSearchResultsVisible(false);
    return;
  }
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  status.textContent = 'Searching…';
  const useOnline = preference('onlineSearch') === 'true' && navigator.onLine;
  const provider = useOnline
    ? new CompositeSearchProvider([localSearch, onlineSearch])
    : localSearch;
  try {
    const results = await provider.search(trimmed, controller.signal);
    if (controller.signal.aborted || searchAbort !== controller) return;
    renderSearchResults(results);
    status.textContent = results.length ? `${results.length} places found.` : 'No place found. Try coordinates such as 55.67, 12.56.';
  } catch (error) {
    if (!controller.signal.aborted && searchAbort === controller) status.textContent = `Search failed: ${error instanceof Error ? error.message : 'unknown error'}`;
  } finally {
    if (searchAbort === controller) searchAbort = null;
  }
}

function renderSearchResults(results: readonly SearchResult[]): void {
  searchResults.replaceChildren();
  for (const result of results.slice(0, 10)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.append(document.createTextNode(result.label));
    if (result.description) button.append(el('span', result.description, 'result-detail'));
    button.addEventListener('click', () => {
      searchInput.value = result.label;
      setSearchResultsVisible(false);
      runTravel(earth.flyTo(result.view, reducedMotionDuration(1.5)));
    });
    const item = document.createElement('li');
    item.append(button);
    searchResults.append(item);
  }
  setSearchResultsVisible(results.length > 0);
}

async function shareCurrentView(): Promise<void> {
  const view = earth.getView();
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('lon', view.longitude.toFixed(6));
  url.searchParams.set('lat', view.latitude.toFixed(6));
  url.searchParams.set('height', Math.round(view.height).toString());
  url.searchParams.set('heading', (view.heading ?? 0).toFixed(5));
  url.searchParams.set('pitch', (view.pitch ?? -Math.PI / 2).toFixed(5));
  try {
    if (navigator.share) await navigator.share({ title: 'OpenEarth view', url: url.href });
    else await navigator.clipboard.writeText(url.href);
    status.textContent = 'Share link ready.';
  } catch (error) {
    if ((error as DOMException).name !== 'AbortError') status.textContent = 'Could not copy the share link.';
  }
}

function locateUser(): void {
  if (!navigator.geolocation) {
    status.textContent = 'Location is unavailable in this browser.';
    return;
  }
  status.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      runTravel(earth.flyTo({
        longitude: position.coords.longitude,
        latitude: position.coords.latitude,
        height: Math.max(2_500, position.coords.accuracy * 8),
        pitch: -Math.PI / 2,
      }, reducedMotionDuration(1.4)));
    },
    (error) => { status.textContent = `Location unavailable: ${error.message}`; },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
  );
}

function showBookmarks(): void {
  openPanel('Saved views');
  const list = document.createElement('ul');
  list.className = 'panel-list';
  const saved = bookmarks.list();
  if (saved.length === 0) panelContent.append(el('p', 'No saved views yet. Use Bookmark to keep the current camera.'));
  for (const bookmark of saved) {
    const open = button(bookmark.name, () => { runTravel(earth.flyTo(bookmark.view, reducedMotionDuration(1.4))); closePanel(); });
    open.className = 'secondary';
    const remove = button('Delete', () => { bookmarks.remove(bookmark.id); showBookmarks(); });
    remove.className = 'secondary';
    const item = document.createElement('li');
    open.append(el('span', `${bookmark.view.latitude.toFixed(3)}, ${bookmark.view.longitude.toFixed(3)}`, 'result-detail'));
    item.append(open, remove);
    list.append(item);
  }
  panelContent.append(list);
  const actions = el('div', '', 'panel-actions');
  actions.append(
    button('Export', () => downloadText('openearth-bookmarks.json', bookmarks.export(), 'application/json')),
    button('Import', importBookmarks),
  );
  panelContent.append(actions);
}

function showLayers(): void {
  openPanel('Layers and comfort');
  const style = selectField('Desktop map style', [
    ['osm', 'OpenStreetMap · local labels'],
    ['voyager', 'Voyager · English-forward'],
    ['dark', 'Dark Matter'],
  ], currentMapStyle, (value) => setMapStyle(value));
  const buildings = checkbox('3D buildings', buildingsEnabled, (enabled) => {
    buildingsEnabled = enabled;
    setPreference('buildings', String(enabled));
    earth.setBuildingsEnabled(enabled);
  });
  const lighting = checkbox('Sun lighting and atmosphere', lightingEnabled, (enabled) => {
    lightingEnabled = enabled;
    setPreference('lighting', String(enabled));
    earth.setLightingEnabled(enabled);
  });
  const online = checkbox('Online place search (Nominatim)', preference('onlineSearch') === 'true', (enabled) => setPreference('onlineSearch', String(enabled)));
  const labels = selectField('Interface language', [['en', 'English'], ['da', 'Dansk']], language, (value) => applyLanguage(value === 'da' ? 'da' : 'en'));
  const turning = selectField('VR turning', [['snap', '30° snap turn'], ['smooth', 'Smooth turn']], preference('turnMode') === 'smooth' ? 'smooth' : 'snap', (value) => {
    const turnMode = value === 'smooth' ? 'smooth' : 'snap';
    setPreference('turnMode', turnMode);
    earth.xr.setComfortOptions({ turnMode });
  });
  const currentQuality = preference('quality');
  const quality = selectField('VR quality', [['quality', 'Quality'], ['balanced', 'Balanced'], ['performance', 'Performance']], currentQuality === 'quality' || currentQuality === 'performance' ? currentQuality : 'balanced', (value) => {
    setPreference('quality', value);
    earth.xr.setComfortOptions({ foveation: qualityFoveation(value) });
  });
  panelContent.append(style, buildings, lighting, labels, turning, quality, online);
}

function showDataInfo(): void {
  openPanel('Data, privacy, and offline use');
  panelContent.append(
    el('p', navigator.onLine ? 'Network status: online.' : 'Network status: offline.'),
    el('p', 'OpenEarth has no analytics. By default, map requests go to OpenStreetMap, CARTO, and OpenFreeMap. Viewed tile coordinates can reveal the approximate area you explore.'),
    el('p', 'The installed app shell works offline. Map data is cached only through an explicit OpenMaps pack/provider; the public OpenStreetMap tile service is never bulk-downloaded.'),
  );
  const links = document.createElement('ul');
  for (const [label, href] of [
    ['OpenStreetMap copyright', 'https://www.openstreetmap.org/copyright'],
    ['OpenStreetMap tile policy', 'https://operations.osmfoundation.org/policies/tiles/'],
    ['OpenFreeMap', 'https://openfreemap.org/'],
    ['CARTO attribution', 'https://carto.com/attributions/'],
    ['Nominatim usage policy', 'https://operations.osmfoundation.org/policies/nominatim/'],
    ['OpenEarth source code', 'https://github.com/kblood/openearth-xr'],
  ]) {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = label;
    const item = document.createElement('li');
    item.append(anchor);
    links.append(item);
  }
  panelContent.append(links);
}

function setMapStyle(style: string): void {
  if (style !== 'osm' && style !== 'voyager' && style !== 'dark') return;
  currentMapStyle = style;
  setPreference('mapStyle', style);
  const osmCredit = new Credit('<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>', true);
  const cartoCredit = new Credit('<a href="https://carto.com/attributions" target="_blank">© CARTO</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>', true);
  if (style === 'voyager' || style === 'dark') {
    const name = style === 'voyager' ? 'voyager' : 'dark_all';
    earth.setImageryProvider(new UrlTemplateImageryProvider({
      url: `https://{s}.basemaps.cartocdn.com/rastertiles/${name}/{z}/{x}/{y}.png`,
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: 20,
      credit: cartoCredit,
    }));
    sourceAttribution.textContent = 'Raster © CARTO · Buildings © OpenFreeMap · OpenMapTiles';
  } else {
    earth.setImageryProvider(new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', credit: osmCredit }));
    sourceAttribution.textContent = 'Buildings © OpenFreeMap · OpenMapTiles';
  }
}

function updateTourUi(detail: TourChangeDetail): void {
  const card = required<HTMLElement>('#tour-card');
  const tourButton = required<HTMLButtonElement>('#tour');
  card.hidden = !detail.running;
  tourButton.setAttribute('aria-pressed', String(detail.running));
  tourButton.textContent = detail.running ? 'Stop tour' : 'Denmark tour';
  if (detail.stop) {
    required<HTMLElement>('#tour-title').textContent = detail.stop.title;
    required<HTMLElement>('#tour-description').textContent = detail.stop.description;
  }
}

function openPanel(title: string): void {
  if (panel.hidden && document.activeElement instanceof HTMLElement) panelReturnFocus = document.activeElement;
  panelTitle.textContent = title;
  panelContent.replaceChildren();
  panel.hidden = false;
  required<HTMLButtonElement>('#close-panel').focus({ preventScroll: true });
}

function closePanel(): void {
  if (panel.hidden) return;
  panel.hidden = true;
  if (panelReturnFocus?.isConnected) panelReturnFocus.focus({ preventScroll: true });
  panelReturnFocus = null;
}

function applyLanguage(value: keyof typeof text): void {
  language = value;
  setPreference('language', value);
  document.documentElement.lang = value;
  searchInput.placeholder = value === 'da' ? 'Søg steder eller 55.67, 12.56' : 'Search places or 55.67, 12.56';
  required<HTMLElement>('#controls-help').textContent = text[value].desktop;
  status.textContent = onlineStatus();
}

function onlineStatus(): string { return navigator.onLine ? text[language].ready : text[language].offline; }

function setSearchResultsVisible(visible: boolean): void {
  searchResults.hidden = !visible;
  searchInput.setAttribute('aria-expanded', String(visible));
}

function runTravel(travel: Promise<void>): void {
  void travel.catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    status.textContent = `Travel failed: ${error instanceof Error ? error.message : 'unknown error'}`;
  });
}

function viewFromUrl(values: URLSearchParams): OpenEarthView | null {
  const named = values.get('view');
  if (named && Object.hasOwn(OPENEARTH_VIEWS, named)) return OPENEARTH_VIEWS[named as keyof typeof OPENEARTH_VIEWS];
  const longitude = boundedNumber(values.get('lon'), -180, 180);
  const latitude = boundedNumber(values.get('lat'), -90, 90);
  const height = boundedNumber(values.get('height'), 0, 100_000_000);
  if (longitude === null || latitude === null || height === null) return null;
  return {
    longitude,
    latitude,
    height,
    heading: finiteNumber(values.get('heading')) ?? 0,
    pitch: finiteNumber(values.get('pitch')) ?? -Math.PI / 2,
  };
}

function selectField(label: string, options: readonly (readonly [string, string])[], selected: string, onChange: (value: string) => void): HTMLElement {
  const wrapper = el('label', '', 'field');
  wrapper.append(document.createTextNode(label));
  const select = document.createElement('select');
  for (const [value, textValue] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = textValue;
    option.selected = value === selected;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  wrapper.append(select);
  return wrapper;
}

function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const wrapper = el('label', '', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrapper.append(input, document.createTextNode(label));
  return wrapper;
}

function importBookmarks(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const count = bookmarks.import(await file.text());
      status.textContent = `Imported ${count} saved views.`;
      showBookmarks();
    } catch (error) {
      status.textContent = `Could not import: ${error instanceof Error ? error.message : 'invalid file'}`;
    }
  });
  input.click();
}

function downloadText(name: string, value: string, type: string): void {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`OpenEarth UI is missing ${selector}`);
  return element;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, content = '', className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

function finiteNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedNumber(value: string | null, minimum: number, maximum: number): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= minimum && number <= maximum ? number : null;
}

function reducedMotionDuration(duration: number): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
}

function preference(key: string): string | null {
  try { return localStorage.getItem(`openearth.${key}`); } catch { return null; }
}

function setPreference(key: string, value: string): void {
  try { localStorage.setItem(`openearth.${key}`, value); } catch { /* Storage is optional. */ }
}

function qualityFoveation(value: string): number {
  if (value === 'quality') return 0.35;
  if (value === 'performance') return 0.8;
  return 0.6;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
