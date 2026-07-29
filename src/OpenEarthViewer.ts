import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Credit,
  buildModuleUrl,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventType,
  Viewer,
  type ImageryProvider,
  type TerrainProvider,
} from 'cesium';
import { XrGlobeRenderer, type XrComfortOptions } from './xr/XrGlobeRenderer';
import type { XyzTileProvider } from './xr/XyzTileGlobe';
import { CesiumBuildingLayer } from './buildings/CesiumBuildingLayer';
import {
  OPENFREEMAP_BUILDINGS,
  type BuildingTileProvider,
} from './buildings/BuildingProvider';
import { normalizeView, type GeodeticView } from './core/Geo';

export type OpenEarthView = GeodeticView;

export interface OpenEarthAttribution {
  readonly text: string;
  readonly href?: string;
}

export type OpenEarthLifecycleState = 'ready' | 'entering-xr' | 'xr' | 'exiting-xr' | 'destroying' | 'destroyed';

export interface OpenEarthViewerOptions {
  readonly container: HTMLElement;
  /** Optional host-owned canvas. If omitted, the viewer creates one. */
  readonly xrCanvas?: HTMLCanvasElement;
  /** URL used by Cesium for Workers, Assets, Widgets, and ThirdParty files. */
  readonly cesiumBaseUrl?: string;
  readonly imageryProvider?: ImageryProvider;
  readonly imageryUrl?: string;
  readonly terrainProvider?: TerrainProvider;
  /** Raster XYZ provider used by the immersive globe and its local LODs. */
  readonly xrTileProvider?: XyzTileProvider;
  /** Vector footprints extruded in desktop and XR. Pass null to disable. */
  readonly buildingProvider?: BuildingTileProvider | null;
  readonly initialView?: OpenEarthView;
  readonly minimumZoomDistance?: number;
  readonly maximumZoomDistance?: number;
  readonly requestRenderMode?: boolean;
  readonly xrComfort?: XrComfortOptions;
  readonly attributions?: readonly OpenEarthAttribution[];
}

export interface OpenEarthXrChangeDetail {
  readonly active: boolean;
}

export interface OpenEarthStateChangeDetail { readonly state: OpenEarthLifecycleState; }
export interface OpenEarthViewChangeDetail { readonly view: OpenEarthView; readonly source: 'desktop' | 'xr' | 'api'; }
export interface OpenEarthSourceErrorDetail { readonly source: string; readonly error: Error; }

export interface OpenEarthPreviewOptions {
  readonly distance: number;
  readonly longitude?: number;
  readonly latitude?: number;
  readonly scale?: number;
}

export const OPENEARTH_VIEWS = {
  earth: { longitude: 10, latitude: 34, height: 5_000_000, pitch: -CesiumMath.PI_OVER_TWO },
  denmark: { longitude: 10.2, latitude: 56.1, height: 1_000_000, pitch: -CesiumMath.PI_OVER_TWO },
  copenhagen: { longitude: 12.5683, latitude: 55.6761, height: 1_200, pitch: -CesiumMath.toRadians(50) },
} as const satisfies Record<string, OpenEarthView>;

let configuredCesiumBaseUrl: string | null = null;

/** Configure Cesium's process-wide runtime URL before creating viewers. */
export function configureOpenEarthCesium(baseUrl: string): void {
  const normalized = new URL(baseUrl, document.baseURI).href;
  if (configuredCesiumBaseUrl && configuredCesiumBaseUrl !== normalized) {
    throw new Error(`Cesium is already configured for ${configuredCesiumBaseUrl}; multiple runtime roots are unsupported`);
  }
  if (!configuredCesiumBaseUrl) {
    (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl(value: string): void }).setBaseUrl(normalized);
    configuredCesiumBaseUrl = normalized;
  }
}

/**
 * Embeddable desktop + WebXR globe controller.
 *
 * The host owns its UI. OpenEarthViewer owns Cesium, the XR renderer, camera
 * navigation, and lifecycle, and reports XR changes through `xrchange` events.
 */
export class OpenEarthViewer extends EventTarget {
  readonly viewer: Viewer;
  readonly buildings: CesiumBuildingLayer | null;
  readonly xrCanvas: HTMLCanvasElement;
  private readonly ownsXrCanvas: boolean;
  private readonly initialView: OpenEarthView;
  private readonly originalContainerPosition: string;
  private readonly buildingProvider: BuildingTileProvider | null;
  private readonly removeCameraMoveListener: () => void;
  private xrRenderer: XrGlobeRenderer | null = null;
  private lifecycle: OpenEarthLifecycleState = 'ready';
  private buildingsEnabled = true;
  private lightingEnabled = true;
  private transitionPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;

  constructor(readonly options: OpenEarthViewerOptions) {
    super();
    const { container } = options;
    configureOpenEarthCesium(options.cesiumBaseUrl ?? './cesium/');

    this.ownsXrCanvas = !options.xrCanvas;
    this.originalContainerPosition = container.style.position;
    const imageryProvider = options.imageryProvider ?? new OpenStreetMapImageryProvider({
      url: options.imageryUrl ?? 'https://tile.openstreetmap.org/',
      credit: new Credit('<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>', true),
    });
    this.viewer = new Viewer(container, {
      baseLayer: new ImageryLayer(imageryProvider),
      terrainProvider: options.terrainProvider ?? new EllipsoidTerrainProvider(),
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
      shouldAnimate: false,
      requestRenderMode: options.requestRenderMode ?? true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    });
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.globe.showGroundAtmosphere = true;
    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = true;
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = options.minimumZoomDistance ?? 15;
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = options.maximumZoomDistance ?? 60_000_000;
    this.viewer.scene.camera.frustum.near = 1;

    this.buildingProvider = options.buildingProvider === undefined
      ? OPENFREEMAP_BUILDINGS
      : options.buildingProvider;
    this.buildings = this.buildingProvider ? new CesiumBuildingLayer(this.viewer, this.buildingProvider) : null;
    if (this.buildingProvider) this.viewer.creditDisplay.addStaticCredit(new Credit(this.buildingProvider.attribution));
    this.xrCanvas = options.xrCanvas ?? this.createXrCanvas(container);
    this.initialView = options.initialView ?? OPENEARTH_VIEWS.earth;
    this.installDoubleClickTravel();
    this.removeCameraMoveListener = this.viewer.camera.moveEnd.addEventListener(() => this.dispatchViewChange('desktop'));
    void this.flyTo(this.initialView, 0).catch(() => undefined);
  }

  /** Lazily creates the immersive renderer when a host needs its low-level API. */
  get xr(): XrGlobeRenderer { return this.getOrCreateXr(); }

  get xrActive(): boolean { return this.xrRenderer?.active ?? false; }
  get state(): OpenEarthLifecycleState { return this.lifecycle; }

  /** Typed event subscription with an explicit cleanup function for framework lifecycles. */
  on<K extends keyof OpenEarthEventMap>(type: K, listener: (event: OpenEarthEventMap[K]) => void): () => void {
    const callback = listener as EventListener;
    this.addEventListener(type, callback);
    return () => this.removeEventListener(type, callback);
  }

  flyTo(view: OpenEarthView, duration = 1.6, signal?: AbortSignal): Promise<void> {
    this.assertAvailable();
    const normalized = normalizeView(view);
    if (this.xrActive) {
      this.xrRenderer?.setView(normalized);
      this.dispatchViewChange('api');
      return Promise.resolve();
    }
    if (signal?.aborted) return Promise.reject(new DOMException('Travel cancelled', 'AbortError'));
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        this.viewer.camera.cancelFlight();
        reject(new DOMException('Travel cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      const finish = (callback: () => void): void => {
        signal?.removeEventListener('abort', abort);
        callback();
      };
      const options = {
        destination: Cartesian3.fromDegrees(normalized.longitude, normalized.latitude, normalized.height),
        orientation: {
          heading: normalized.heading ?? 0,
          pitch: normalized.pitch ?? -CesiumMath.PI_OVER_TWO,
          roll: normalized.roll ?? 0,
        },
      };
      if (duration <= 0) {
        this.viewer.camera.setView(options);
        this.viewer.scene.requestRender();
        finish(resolve);
        this.dispatchViewChange('api');
        return;
      }
      this.viewer.camera.flyTo({
        ...options,
        duration,
        complete: () => finish(resolve),
        cancel: () => finish(() => reject(new DOMException('Travel cancelled', 'AbortError'))),
      });
    });
  }

  reset(duration = 1.6, signal?: AbortSignal): Promise<void> { return this.flyTo(this.initialView, duration, signal); }

  getView(): OpenEarthView {
    this.assertAvailable();
    if (this.xrActive) return this.xrRenderer!.getView();
    return this.getDesktopView();
  }

  setBuildingsEnabled(enabled: boolean): void {
    this.assertAvailable();
    this.buildingsEnabled = enabled;
    if (enabled) this.buildings?.resume();
    else this.buildings?.suspend();
    this.xrRenderer?.setBuildingsEnabled(enabled);
    this.viewer.scene.requestRender();
  }

  setLightingEnabled(enabled: boolean): void {
    this.assertAvailable();
    this.lightingEnabled = enabled;
    this.viewer.scene.globe.enableLighting = enabled;
    this.viewer.scene.globe.showGroundAtmosphere = enabled;
    if (this.viewer.scene.skyAtmosphere) this.viewer.scene.skyAtmosphere.show = enabled;
    this.xrRenderer?.setLightingEnabled(enabled);
    this.viewer.scene.requestRender();
  }

  setImageryProvider(provider: ImageryProvider): void {
    this.assertAvailable();
    this.viewer.imageryLayers.removeAll(true);
    this.viewer.imageryLayers.add(new ImageryLayer(provider));
    this.viewer.scene.requestRender();
  }

  getAttributions(): readonly OpenEarthAttribution[] {
    const values: OpenEarthAttribution[] = [
      ...(this.options.imageryProvider ? [] : [{ text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' }]),
      { text: this.options.xrTileProvider?.attribution ?? '© OpenStreetMap contributors · © CARTO' },
      ...(this.buildingProvider ? [{ text: this.buildingProvider.attribution }] : []),
      ...(this.options.attributions ?? []),
    ];
    return values.filter((value, index) => values.findIndex((candidate) => candidate.text === value.text && candidate.href === value.href) === index);
  }

  private getDesktopView(): OpenEarthView {
    const camera = this.viewer.camera;
    const position = Cartographic.fromCartesian(camera.positionWC);
    return {
      longitude: CesiumMath.toDegrees(position.longitude),
      latitude: CesiumMath.toDegrees(position.latitude),
      height: position.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    };
  }

  async isXrSupported(): Promise<boolean> {
    this.assertAvailable();
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      return false;
    }
  }

  async enterXr(): Promise<void> {
    this.assertAvailable();
    if (this.xrActive) return;
    if (this.transitionPromise) return this.transitionPromise;
    const xr = this.getOrCreateXr();
    const initialView = this.getDesktopView();
    this.setLifecycle('entering-xr');
    this.transitionPromise = xr.enter(
      (returnedView) => {
        if (this.lifecycle === 'destroying' || this.lifecycle === 'destroyed') return;
        void this.flyTo(returnedView, 0).catch(() => undefined);
        if (this.buildingsEnabled) this.buildings?.resume();
        else this.buildings?.suspend();
        this.viewer.useDefaultRenderLoop = true;
        this.viewer.scene.requestRender();
        this.setLifecycle('ready');
        this.dispatchXrChange(false);
      },
      () => {
        this.buildings?.suspend();
        this.viewer.useDefaultRenderLoop = false;
        this.setLifecycle('xr');
        this.dispatchXrChange(true);
      },
      initialView,
    ).catch((error: unknown) => {
      this.viewer.useDefaultRenderLoop = true;
      if (this.buildingsEnabled) this.buildings?.resume();
      else this.buildings?.suspend();
      this.setLifecycle('ready');
      throw error;
    }).finally(() => { this.transitionPromise = null; });
    return this.transitionPromise;
  }

  async exitXr(): Promise<void> {
    if (!this.xrRenderer?.active) return;
    this.setLifecycle('exiting-xr');
    await this.xrRenderer.exit();
  }

  startPreview(options: OpenEarthPreviewOptions): void {
    this.assertAvailable();
    const xr = this.getOrCreateXr();
    try {
      xr.startPreview(
        options.distance,
        options.longitude ?? 10.2,
        options.latitude ?? 56.1,
        options.scale ?? 1,
      );
      this.buildings?.suspend();
      this.viewer.useDefaultRenderLoop = false;
    } catch (error) {
      this.viewer.useDefaultRenderLoop = true;
      throw error;
    }
  }

  stopPreview(): void {
    this.assertAvailable();
    this.xrRenderer?.stopPreview();
    if (this.buildingsEnabled) this.buildings?.resume();
    else this.buildings?.suspend();
    this.viewer.useDefaultRenderLoop = true;
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.setLifecycle('destroying');
    this.destroyPromise = this.performDestroy();
    return this.destroyPromise;
  }

  private installDoubleClickTravel(): void {
    this.viewer.screenSpaceEventHandler.setInputAction((movement: { position: { x: number; y: number } }) => {
      const position = this.viewer.camera.pickEllipsoid(
        new Cartesian2(movement.position.x, movement.position.y),
        this.viewer.scene.globe.ellipsoid,
      );
      if (!position) return;
      const target = Cartographic.fromCartesian(position);
      void this.flyTo({
        longitude: CesiumMath.toDegrees(target.longitude),
        latitude: CesiumMath.toDegrees(target.latitude),
        height: 10_000,
        heading: this.viewer.camera.heading,
        pitch: -CesiumMath.toRadians(55),
      }, 1.2).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.dispatchEvent(new CustomEvent<OpenEarthSourceErrorDetail>('sourceerror', {
          detail: { source: 'navigation', error: error instanceof Error ? error : new Error(String(error)) },
        }));
      });
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  private createXrCanvas(container: HTMLElement): HTMLCanvasElement {
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const canvas = document.createElement('canvas');
    canvas.className = 'openearth-xr-canvas';
    canvas.hidden = true;
    canvas.setAttribute('aria-label', 'Immersive WebXR globe');
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '1',
    });
    container.append(canvas);
    return canvas;
  }

  private dispatchXrChange(active: boolean): void {
    this.dispatchEvent(new CustomEvent<OpenEarthXrChangeDetail>('xrchange', { detail: { active } }));
  }

  private dispatchViewChange(source: OpenEarthViewChangeDetail['source']): void {
    if (this.lifecycle === 'destroying' || this.lifecycle === 'destroyed') return;
    this.dispatchEvent(new CustomEvent<OpenEarthViewChangeDetail>('viewchange', {
      detail: { view: this.getView(), source },
    }));
  }

  private setLifecycle(state: OpenEarthLifecycleState): void {
    if (this.lifecycle === state) return;
    this.lifecycle = state;
    this.dispatchEvent(new CustomEvent<OpenEarthStateChangeDetail>('statechange', { detail: { state } }));
  }

  private async performDestroy(): Promise<void> {
    try {
      this.removeCameraMoveListener();
      this.buildings?.dispose();
      await this.xrRenderer?.dispose().catch(() => undefined);
      if (!this.viewer.isDestroyed()) this.viewer.destroy();
      if (this.ownsXrCanvas) {
        this.xrCanvas.remove();
        this.options.container.style.position = this.originalContainerPosition;
      }
    } finally {
      this.setLifecycle('destroyed');
    }
  }

  private getOrCreateXr(): XrGlobeRenderer {
    this.assertAvailable();
    if (!this.xrRenderer) {
      this.xrRenderer = new XrGlobeRenderer(
        this.xrCanvas,
        this.options.xrTileProvider,
        this.buildingProvider,
        {
          comfort: this.options.xrComfort,
          onViewChange: () => {
            if (this.lifecycle === 'xr') this.dispatchViewChange('xr');
          },
          onSourceError: (error) => {
            this.dispatchEvent(new CustomEvent<OpenEarthSourceErrorDetail>('sourceerror', {
              detail: { source: 'xr', error },
            }));
          },
        },
      );
      this.xrRenderer.setBuildingsEnabled(this.buildingsEnabled);
      this.xrRenderer.setLightingEnabled(this.lightingEnabled);
    }
    return this.xrRenderer;
  }

  private assertAvailable(): void {
    if (this.lifecycle === 'destroying' || this.lifecycle === 'destroyed') {
      throw new Error('OpenEarth viewer has been destroyed');
    }
  }
}

export interface OpenEarthEventMap {
  readonly xrchange: CustomEvent<OpenEarthXrChangeDetail>;
  readonly viewchange: CustomEvent<OpenEarthViewChangeDetail>;
  readonly statechange: CustomEvent<OpenEarthStateChangeDetail>;
  readonly sourceerror: CustomEvent<OpenEarthSourceErrorDetail>;
}
