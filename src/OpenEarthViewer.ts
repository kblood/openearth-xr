import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventType,
  Viewer,
  type ImageryProvider,
} from 'cesium';
import { XrGlobeRenderer } from './xr/XrGlobeRenderer';
import type { XyzTileProvider } from './xr/XyzTileGlobe';
import { CesiumBuildingLayer } from './buildings/CesiumBuildingLayer';
import {
  OPENFREEMAP_BUILDINGS,
  type BuildingTileProvider,
} from './buildings/BuildingProvider';

export interface OpenEarthView {
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly heading?: number;
  readonly pitch?: number;
  readonly roll?: number;
}

export interface OpenEarthViewerOptions {
  readonly container: HTMLElement;
  /** Optional host-owned canvas. If omitted, the viewer creates one. */
  readonly xrCanvas?: HTMLCanvasElement;
  /** URL used by Cesium for Workers, Assets, Widgets, and ThirdParty files. */
  readonly cesiumBaseUrl?: string;
  readonly imageryProvider?: ImageryProvider;
  readonly imageryUrl?: string;
  /** Raster XYZ provider used by the immersive globe and its local LODs. */
  readonly xrTileProvider?: XyzTileProvider;
  /** Vector footprints extruded in desktop and XR. Pass null to disable. */
  readonly buildingProvider?: BuildingTileProvider | null;
  readonly initialView?: OpenEarthView;
  readonly minimumZoomDistance?: number;
  readonly maximumZoomDistance?: number;
}

export interface OpenEarthXrChangeDetail {
  readonly active: boolean;
}

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
  private xrRenderer: XrGlobeRenderer | null = null;
  private destroyed = false;

  constructor(readonly options: OpenEarthViewerOptions) {
    super();
    const { container } = options;
    (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = options.cesiumBaseUrl ?? './cesium/';

    this.ownsXrCanvas = !options.xrCanvas;
    this.originalContainerPosition = container.style.position;
    const imageryProvider = options.imageryProvider ?? new OpenStreetMapImageryProvider({
      url: options.imageryUrl ?? 'https://tile.openstreetmap.org/',
    });
    this.viewer = new Viewer(container, {
      baseLayer: new ImageryLayer(imageryProvider),
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
    this.flyTo(this.initialView, 0);
  }

  /** Lazily creates the immersive renderer when a host needs its low-level API. */
  get xr(): XrGlobeRenderer { return this.getOrCreateXr(); }

  get xrActive(): boolean { return this.xrRenderer?.active ?? false; }

  flyTo(view: OpenEarthView, duration = 1.6): void {
    this.assertAvailable();
    this.viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
      orientation: {
        heading: view.heading ?? 0,
        pitch: view.pitch ?? -CesiumMath.PI_OVER_TWO,
        roll: view.roll ?? 0,
      },
      duration,
    });
  }

  reset(duration = 1.6): void { this.flyTo(this.initialView, duration); }

  getView(): OpenEarthView {
    this.assertAvailable();
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
    await this.getOrCreateXr().enter(
      () => {
        this.viewer.useDefaultRenderLoop = true;
        this.dispatchXrChange(false);
      },
      () => {
        this.viewer.useDefaultRenderLoop = false;
        this.dispatchXrChange(true);
      },
    );
  }

  async exitXr(): Promise<void> { await this.xrRenderer?.exit(); }

  startPreview(options: OpenEarthPreviewOptions): void {
    this.assertAvailable();
    this.viewer.useDefaultRenderLoop = false;
    this.getOrCreateXr().startPreview(
      options.distance,
      options.longitude ?? 10.2,
      options.latitude ?? 56.1,
      options.scale ?? 1,
    );
  }

  stopPreview(): void {
    this.assertAvailable();
    this.xrRenderer?.stopPreview();
    this.viewer.useDefaultRenderLoop = true;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.buildings?.dispose();
    await this.xrRenderer?.dispose();
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
    if (this.ownsXrCanvas) {
      this.xrCanvas.remove();
      this.options.container.style.position = this.originalContainerPosition;
    }
    this.destroyed = true;
  }

  private installDoubleClickTravel(): void {
    this.viewer.screenSpaceEventHandler.setInputAction((movement: { position: { x: number; y: number } }) => {
      const position = this.viewer.camera.pickEllipsoid(
        new Cartesian2(movement.position.x, movement.position.y),
        this.viewer.scene.globe.ellipsoid,
      );
      if (!position) return;
      const target = Cartographic.fromCartesian(position);
      this.flyTo({
        longitude: CesiumMath.toDegrees(target.longitude),
        latitude: CesiumMath.toDegrees(target.latitude),
        height: 10_000,
        heading: this.viewer.camera.heading,
        pitch: -CesiumMath.toRadians(55),
      }, 1.2);
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

  private getOrCreateXr(): XrGlobeRenderer {
    this.assertAvailable();
    this.xrRenderer ??= new XrGlobeRenderer(
      this.xrCanvas,
      this.options.xrTileProvider,
      this.buildingProvider,
    );
    return this.xrRenderer;
  }

  private assertAvailable(): void {
    if (this.destroyed) throw new Error('OpenEarth viewer has been destroyed');
  }
}
