import {
  AmbientLight,
  ArrayCamera,
  BufferGeometry,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Quaternion,
  Vector3,
  WebGLRenderer,
} from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import {
  CARTO_VOYAGER,
  createGlobalOverviewTexture,
  XyzTileGlobe,
  type XyzTileProvider,
} from './XyzTileGlobe';
import { XrBuildingLayer } from '../buildings/XrBuildingLayer';
import type { BuildingTileProvider } from '../buildings/BuildingProvider';
import {
  directionGeodetic,
  EARTH_RADIUS_METERS,
  geodeticDirection,
  globeUnitsToMetres,
  greatCircleDistanceMeters,
  metresToGlobeUnits,
  normalizeView,
  type GeodeticView,
} from '../core/Geo';
import { createXrAtmosphere, createXrStarField, disposeXrStarField } from './XrSky';

const STARTING_YAW = -0.8;
const DEAD_ZONE = 0.12;
const EARTH_RADIUS = 1.45;
// Below roughly one Earth radius of altitude, keep the viewed surface around
// human room scale. Near the ground, a camera-relative ENU patch takes over.
const FLIGHT_SCALE_ALTITUDE = 1.6;
const MIN_VIRTUAL_ALTITUDE = 0.00008;
const MAX_VIRTUAL_ALTITUDE = 24;
const MAX_PLANET_SCALE = FLIGHT_SCALE_ALTITUDE / MIN_VIRTUAL_ALTITUDE;
const MIN_PHYSICAL_CLEARANCE = 0.04;
const ORBIT_ZOOM_RATE = 0.95;
const SURFACE_ZOOM_RATE = 0.28;
const ORBIT_PINCH_EXPONENT = 2;
const SURFACE_PINCH_EXPONENT = 0.75;
const XR_NEAR = 0.01;
const XR_MIN_FAR = 40;
const SNAP_TURN_ANGLE = MathUtils.degToRad(30);
const LOCAL_MODE_ENTER_METERS = 6_000;
const LOCAL_MODE_EXIT_METERS = 8_000;
const LOCAL_TILT_RESPONSE = 5;
const LOCAL_MIN_PATCH_RADIUS_METERS = 4_000;
const LOCAL_MAX_PATCH_RADIUS_METERS = 120_000;
const XR_DEPTH_UPDATE_INTERVAL_MS = 250;
const SOURCE_CREDIT = '© OpenStreetMap contributors · © CARTO · © OpenFreeMap · © OpenMapTiles';

type Hand = 'left' | 'right';
type XrRendererState = 'idle' | 'preview' | 'entering' | 'immersive' | 'exiting' | 'disposing' | 'disposed';
type HandState = {
  source: XRInputSource;
  ray: Group;
  grip: Group;
  trigger: boolean;
  squeeze: boolean;
  kind: 'controller' | 'hand';
};

export interface XrComfortOptions {
  readonly turnMode?: 'smooth' | 'snap';
  readonly snapTurnRadians?: number;
  readonly movementScale?: number;
  readonly foveation?: number;
  readonly handTracking?: boolean;
}

export interface XrGlobeRendererOptions {
  readonly minimumHeightMeters?: number;
  readonly maximumHeightMeters?: number;
  readonly comfort?: XrComfortOptions;
  readonly onViewChange?: (view: GeodeticView) => void;
  readonly onSourceError?: (error: Error) => void;
}

/**
 * A single, compositor-owned Three.js scene for immersive presentation.
 * Cesium remains the precision desktop renderer; this renderer deliberately
 * owns the whole headset frame so WebXR can supply correct per-eye cameras.
 */
export class XrGlobeRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(65, 1, XR_NEAR, XR_MIN_FAR);
  private readonly planetRig = new Group();
  private readonly nearGroundRoot = new Group();
  private readonly clock = new Clock();
  private readonly hands = new Map<Hand, HandState>();
  private readonly controllerRays: Group[] = [];
  private readonly controllerGrips: Group[] = [];
  private readonly handGroups: Group[] = [];
  private readonly listenerCleanup: Array<() => void> = [];
  private readonly tiles: XyzTileGlobe;
  private readonly buildings: XrBuildingLayer | null;
  private readonly ambientLight = new AmbientLight(0xffffff, 0.72);
  private readonly sunLight = new DirectionalLight(0xffffff, 1.45);
  private readonly stars = createXrStarField();
  private readonly atmosphere = createXrAtmosphere(EARTH_RADIUS);
  private readonly overviewAbort = new AbortController();
  private readonly cameraPosition = new Vector3();
  private readonly cameraInGlobeSpace = new Vector3();
  private readonly controllerDirection = new Vector3();
  private readonly flightTangent = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly worldDown = new Vector3(0, -1, 0);
  private readonly worldForward = new Vector3(0, 0, 1);
  private readonly rayQuaternion = new Quaternion();
  private readonly grabStartPlanet = new Quaternion();
  private readonly grabStartControllerPosition = new Vector3();
  private readonly currentControllerPosition = new Vector3();
  private readonly grabStartOutward = new Vector3();
  private readonly grabTranslation = new Vector3();
  private readonly grabTangent = new Vector3();
  private readonly grabAxis = new Vector3();
  private readonly grabRotation = new Quaternion();
  private readonly dualStartLeft = new Vector3();
  private readonly dualStartRight = new Vector3();
  private readonly dualStartMidpoint = new Vector3();
  private readonly dualStartVector = new Vector3();
  private readonly dualStartPlanetPosition = new Vector3();
  private readonly dualCurrentLeft = new Vector3();
  private readonly dualCurrentRight = new Vector3();
  private readonly dualCurrentMidpoint = new Vector3();
  private readonly dualCurrentVector = new Vector3();
  private readonly dualOffset = new Vector3();
  private readonly dualViewOffset = new Vector3();
  private readonly previewTarget = new Vector3();
  private readonly dualRotation = new Quaternion();
  private readonly dualStartPlanet = new Quaternion();
  private readonly dualStartFrame = new Quaternion();
  private readonly dualCurrentFrame = new Quaternion();
  private readonly frameMatrix = new Matrix4();
  private readonly frameX = new Vector3();
  private readonly frameY = new Vector3();
  private readonly frameZ = new Vector3();
  private readonly frameLeftUp = new Vector3();
  private readonly frameRightUp = new Vector3();
  private readonly localFrameMatrix = new Matrix4();
  private readonly localEast = new Vector3();
  private readonly localNorth = new Vector3();
  private readonly localSouth = new Vector3();
  private readonly localRadial = new Vector3();
  private readonly surfaceWorld = new Vector3();
  private readonly centreDirection = new Vector3();
  private readonly gazeDirection = new Vector3();
  private readonly gazeEnd = new Vector3();
  private readonly gazeInGlobeSpace = new Vector3();
  private readonly outwardWorld = new Vector3();
  private readonly localSurfaceDirection = new Vector3();
  private readonly inversePlanet = new Quaternion();
  private readonly headingRotation = new Quaternion();
  private readonly resizeObserver: ResizeObserver | null;
  private dualStartDistance = 1;
  private dualStartAltitude = 1;
  private grabStartAltitude = 1;
  private session: XRSession | null = null;
  private onEnd: ((finalView: GeodeticView) => void) | null = null;
  private state: XrRendererState = 'idle';
  private enterPromise: Promise<void> | null = null;
  private exitPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private snapTurnReady = true;
  private currentHeading = 0;
  private frameTimeAverage = 1 / 72;
  private lastViewEventTime = 0;
  private lastQualityUpdateTime = 0;
  private attribution: Sprite | null = null;
  private comfort: XrComfortOptions;
  private lightingEnabled = true;
  private buildingsEnabled = true;
  private localSurfaceActive = false;
  private localAnchorLongitude = Number.NaN;
  private localAnchorLatitude = Number.NaN;
  /** Stable scale used to build tangent geometry for the current local session. */
  private localMetersPerWorldUnit = Number.NaN;
  private localMaxRadiusMeters = Number.NaN;
  private xrDepthFar = XR_MIN_FAR;
  private lastXrDepthUpdateTime = 0;
  private xrDepthUpdateInFlight = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    tileProvider: XyzTileProvider = CARTO_VOYAGER,
    buildingProvider: BuildingTileProvider | null = null,
    private readonly options: XrGlobeRendererOptions = {},
  ) {
    this.comfort = { ...options.comfort };
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFoveation(MathUtils.clamp(this.comfort.foveation ?? 0.6, 0, 1));
    this.tiles = new XyzTileGlobe(EARTH_RADIUS, tileProvider);
    this.buildings = buildingProvider ? new XrBuildingLayer(EARTH_RADIUS, buildingProvider) : null;

    this.scene.background = new Color(0x030812);
    this.camera.position.set(0, 1.6, 0);
    this.scene.add(this.camera);
    this.scene.add(this.ambientLight);
    this.sunLight.position.set(-3, 4, 2);
    this.scene.add(this.sunLight, this.stars);

    const material = new MeshBasicMaterial({ color: 0xd9e7f5 });
    const earth = new Mesh(new SphereGeometry(EARTH_RADIUS, 192, 128), material);
    this.planetRig.position.set(0, 1.35, -3.3);
    this.planetRig.rotation.y = STARTING_YAW;
    this.planetRig.add(earth);
    this.planetRig.add(this.atmosphere);
    this.planetRig.add(this.tiles.group);
    if (this.buildings) this.planetRig.add(this.buildings.group);
    this.scene.add(this.planetRig);
    this.nearGroundRoot.visible = false;
    this.scene.add(this.nearGroundRoot);
    this.attribution = this.createAttributionSprite([tileProvider.attribution, buildingProvider?.attribution].filter(Boolean).join(' · ') || SOURCE_CREDIT);
    this.camera.add(this.attribution);

    // Never place a Web-Mercator XYZ tile directly on a sphere: its UVs are
    // equirectangular and would make the globe disagree with the close tiles.
    // This overview is reprojected from the same provider used by the surface.
    void createGlobalOverviewTexture(tileProvider, 3, this.overviewAbort.signal)
      .then((texture) => {
        if (this.overviewAbort.signal.aborted) texture.dispose();
        else { material.map = texture; material.needsUpdate = true; }
      })
      .catch((error: unknown) => this.options.onSourceError?.(
        error instanceof Error ? error : new Error('XR overview failed', { cause: error }),
      ));

    for (let index = 0; index < 2; index += 1) this.installInput(index);
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => { if (this.state === 'preview') this.resizePreview(); });
    this.resizeObserver?.observe(canvas.parentElement ?? canvas);
  }

  get active(): boolean { return this.state === 'immersive'; }
  get lifecycleState(): XrRendererState { return this.state; }

  setComfortOptions(options: XrComfortOptions): void {
    this.assertUsable();
    this.comfort = { ...this.comfort, ...options };
    if (options.foveation !== undefined) this.renderer.xr.setFoveation(MathUtils.clamp(options.foveation, 0, 1));
  }

  setBuildingsEnabled(enabled: boolean): void {
    this.assertUsable();
    if (this.buildingsEnabled === enabled) return;
    this.buildingsEnabled = enabled;
    if (!this.buildings) return;
    if (!enabled) {
      this.buildings.suspend();
    } else if (this.state === 'preview' || this.state === 'immersive') {
      this.buildings.resume();
    }
  }

  setLightingEnabled(enabled: boolean): void {
    this.assertUsable();
    this.lightingEnabled = enabled;
    this.sunLight.visible = enabled;
    if (!enabled) this.atmosphere.visible = false;
  }

  setView(view: GeodeticView): void {
    this.assertUsable();
    if (this.localSurfaceActive) this.leaveNearGround();
    const normalized = normalizeView(view);
    const direction = geodeticDirection(normalized.longitude, normalized.latitude);
    this.previewTarget.set(direction.x, direction.y, direction.z);
    this.planetRig.quaternion.setFromUnitVectors(this.previewTarget, this.worldForward);
    this.currentHeading = normalized.heading ?? 0;
    this.headingRotation.setFromAxisAngle(this.worldForward, -this.currentHeading);
    this.planetRig.quaternion.premultiply(this.headingRotation);
    this.cameraPosition.copy(this.camera.position);
    this.setVirtualAltitude(metresToGlobeUnits(normalized.height, EARTH_RADIUS));
    this.notifyViewChange(true);
  }

  getView(): GeodeticView {
    this.assertUsable();
    return this.captureView();
  }

  private captureView(): GeodeticView {
    // The session remains assigned during the `end` event even though `exit()`
    // has moved the lifecycle state to exiting. Use it to preserve the final
    // headset pose instead of falling back to the base preview camera.
    const camera = this.session ? this.renderer.xr.getCamera() : this.camera;
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.outwardWorld.copy(this.cameraPosition).sub(this.planetRig.position);
    if (this.outwardWorld.lengthSq() < 1e-12) this.outwardWorld.copy(this.worldForward);
    this.outwardWorld.normalize();
    this.inversePlanet.copy(this.planetRig.quaternion).invert();
    this.localSurfaceDirection.copy(this.outwardWorld).applyQuaternion(this.inversePlanet).normalize();
    const coordinates = directionGeodetic(this.localSurfaceDirection);
    return {
      ...coordinates,
      height: globeUnitsToMetres(this.getVirtualAltitude(), EARTH_RADIUS),
      heading: this.currentHeading,
      pitch: -Math.PI / 2,
      roll: 0,
    };
  }

  /** Development-only deterministic renderer used to inspect the exact tile
   * coverage at a chosen physical camera-to-centre distance without a headset. */
  startPreview(distance: number, longitude = 10.2, latitude = 56.1, scale = 1): void {
    this.assertUsable();
    if (this.state === 'immersive' || this.state === 'entering' || this.state === 'exiting') {
      throw new Error('Cannot start a preview during an immersive transition');
    }
    this.state = 'preview';
    if (this.localSurfaceActive) this.leaveNearGround();
    this.canvas.hidden = false;
    this.resumeLayers();
    this.resizePreview();
    this.camera.position.set(0, 1.6, 0);
    const safeScale = MathUtils.clamp(scale, 1, MAX_PLANET_SCALE);
    this.planetRig.position.set(
      0,
      1.6,
      -Math.max((EARTH_RADIUS + MIN_VIRTUAL_ALTITUDE) * safeScale, distance),
    );
    const lon = MathUtils.degToRad(longitude);
    const lat = MathUtils.degToRad(latitude);
    // Match SphereGeometry's equirectangular convention: longitude increases
    // toward local -Z. The detailed tile shell uses the same handedness.
    this.previewTarget.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    this.planetRig.quaternion.setFromUnitVectors(this.previewTarget, this.worldForward);
    this.planetRig.scale.setScalar(safeScale);
    this.clock.start();
    this.renderer.setAnimationLoop(this.renderPreview);
  }

  enter(onEnd: (finalView: GeodeticView) => void, onStarted: () => void, initialView?: GeodeticView): Promise<void> {
    this.assertUsable();
    if (this.state === 'immersive') return Promise.resolve();
    if (this.enterPromise) return this.enterPromise;
    this.enterPromise = this.performEnter(onEnd, onStarted, initialView)
      .finally(() => { this.enterPromise = null; });
    return this.enterPromise;
  }

  exit(): Promise<void> {
    if (this.state === 'disposed' || this.state === 'idle') return Promise.resolve();
    if (this.exitPromise) return this.exitPromise;
    if (this.state === 'preview') {
      this.stopPreview();
      return Promise.resolve();
    }
    this.state = 'exiting';
    this.exitPromise = (this.session?.end() ?? Promise.resolve())
      .finally(() => { this.exitPromise = null; });
    return this.exitPromise;
  }

  stopPreview(): void {
    if (this.state !== 'preview') return;
    this.renderer.setAnimationLoop(null);
    if (this.localSurfaceActive) this.leaveNearGround();
    this.suspendLayers();
    this.canvas.hidden = true;
    this.state = 'idle';
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state = 'disposing';
    this.disposePromise = this.performDispose();
    return this.disposePromise;
  }

  private async performEnter(
    onEnd: (finalView: GeodeticView) => void,
    onStarted: () => void,
    initialView?: GeodeticView,
  ): Promise<void> {
    if (this.state === 'preview') this.stopPreview();
    this.state = 'entering';
    const xr = navigator.xr;
    if (!xr) {
      this.state = 'idle';
      throw new Error('WebXR is unavailable');
    }
    if (initialView) this.setView(initialView);
    let session: XRSession;
    try {
      this.renderer.xr.setReferenceSpaceType('local-floor');
      session = await xr.requestSession('immersive-vr', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['bounded-floor', 'hand-tracking', 'layers'],
      });
    } catch (floorError) {
      // Permission denial and user cancellation must never prompt a second
      // request. Only retry when the required reference space is unsupported.
      if (!isXrCapabilityUnsupported(floorError)) {
        this.state = 'idle';
        throw floorError;
      }
      try {
        this.renderer.xr.setReferenceSpaceType('local');
        session = await xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking', 'layers'] });
      } catch (fallbackError) {
        this.state = 'idle';
        throw fallbackError;
      }
    }
    try {
      await session.updateRenderState({ depthNear: XR_NEAR, depthFar: XR_MIN_FAR });
      this.xrDepthFar = XR_MIN_FAR;
      this.lastXrDepthUpdateTime = performance.now();
    } catch (error) {
      this.state = 'idle';
      if (session.visibilityState !== 'hidden') await session.end().catch(() => undefined);
      throw error;
    }
    this.canvas.hidden = false;
    this.session = session;
    this.onEnd = onEnd;
    session.addEventListener('end', this.handleSessionEnd, { once: true });
    try {
      await this.renderer.xr.setSession(session);
      this.resumeLayers();
      this.clock.start();
      this.state = 'immersive';
      this.renderer.setAnimationLoop(this.render);
      onStarted();
    } catch (error) {
      this.renderer.setAnimationLoop(null);
      this.suspendLayers();
      session.removeEventListener('end', this.handleSessionEnd);
      this.session = null;
      this.onEnd = null;
      this.canvas.hidden = true;
      this.state = 'idle';
      if (session.visibilityState !== 'hidden') await session.end().catch(() => undefined);
      throw error;
    }
  }

  private async performDispose(): Promise<void> {
    try {
      if (this.session) await this.session.end().catch(() => undefined);
      this.renderer.setAnimationLoop(null);
      this.overviewAbort.abort();
      this.resizeObserver?.disconnect();
      for (const cleanup of this.listenerCleanup.splice(0)) cleanup();
      this.buildings?.dispose();
      this.tiles.dispose();
      this.planetRig.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else {
          if (material instanceof MeshBasicMaterial) material.map?.dispose();
          material.dispose();
        }
      });
      if (this.attribution) {
        this.attribution.geometry.dispose();
        this.attribution.material.map?.dispose();
        this.attribution.material.dispose();
        this.attribution.removeFromParent();
        this.attribution = null;
      }
      this.disposeInputVisuals();
      disposeXrStarField(this.stars);
      this.scene.clear();
      this.renderer.renderLists.dispose();
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.canvas.hidden = true;
    } finally {
      this.session = null;
      this.onEnd = null;
      this.state = 'disposed';
    }
  }

  private suspendLayers(): void {
    this.tiles.suspend();
    this.buildings?.suspend();
  }

  private resumeLayers(): void {
    this.tiles.resume();
    if (this.buildingsEnabled) this.buildings?.resume();
    else this.buildings?.suspend();
  }

  private disposeInputVisuals(): void {
    const roots = [
      ...this.controllerRays.splice(0),
      ...this.controllerGrips.splice(0),
      ...this.handGroups.splice(0),
    ];
    for (const root of roots) {
      root.traverse((object) => {
        if (!(object instanceof Mesh) && !(object instanceof Line)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          (material as typeof material & { map?: { dispose(): void } }).map?.dispose();
          material.dispose();
        }
      });
      root.removeFromParent();
    }
  }

  private readonly handleSessionEnd = (): void => {
    // Capture while WebXR still owns its final eye camera. The callback is
    // intentionally invoked after teardown so hosts can safely switch views.
    const finalView = this.captureView();
    const shouldNotify = this.state !== 'disposing';
    this.renderer.setAnimationLoop(null);
    this.hands.clear();
    this.session = null;
    this.xrDepthUpdateInFlight = false;
    if (this.localSurfaceActive) this.leaveNearGround();
    this.suspendLayers();
    this.canvas.hidden = true;
    const callback = this.onEnd;
    this.onEnd = null;
    if (this.state !== 'disposing' && this.state !== 'disposed') this.state = 'idle';
    if (shouldNotify) this.notifyViewChange(true, finalView);
    try { callback?.(finalView); } catch { /* Host callbacks cannot interrupt XR teardown. */ }
  };

  private readonly render = (): void => {
    const delta = Math.min(this.clock.getDelta(), 1 / 30);
    this.frameTimeAverage = MathUtils.lerp(this.frameTimeAverage, delta, 0.04);
    const xrCamera = this.renderer.xr.getCamera();
    this.cameraPosition.setFromMatrixPosition(xrCamera.matrixWorld);
    this.applyControllerInput(delta);
    const projection = this.xrProjection(xrCamera);
    this.gazeDirection.set(0, 0, -1).transformDirection(xrCamera.matrixWorld);
    this.updateSurfaceLayers(projection.fov, projection.aspect, this.gazeDirection, delta);
    this.updateDepthRange();
    this.adaptQuality();
    this.notifyViewChange();
    this.renderer.render(this.scene, this.camera);
  };

  private readonly renderPreview = (): void => {
    const delta = Math.min(this.clock.getDelta(), 1 / 30);
    this.scene.updateMatrixWorld();
    this.cameraPosition.copy(this.camera.position);
    this.camera.getWorldDirection(this.gazeDirection);
    this.updateSurfaceLayers(this.camera.fov, this.camera.aspect, this.gazeDirection, delta);
    this.renderer.render(this.scene, this.camera);
  };

  private applyControllerInput(delta: number): void {
    const left = this.hands.get('left');
    const right = this.hands.get('right');
    if (left) {
      const [rawX, rawY] = this.activeAxes(left.source);
      const x = this.shapeAxis(rawX);
      const y = this.shapeAxis(rawY);
      // Left stick pans the world below the viewer instead of duplicating
      // rotation. It is deliberately separate from the right-hand heading.
      if (this.localSurfaceActive) {
        const travel = this.localTravelAngularRate() * delta * this.movementScale();
        if (x !== 0) this.planetRig.rotateOnWorldAxis(this.localNorth, -x * travel);
        if (y !== 0) this.planetRig.rotateOnWorldAxis(this.localEast, -y * travel * (0.55 / 0.65));
      } else {
        const turnScale = this.stickTurnScale();
        if (x !== 0) this.planetRig.rotateOnWorldAxis(this.worldUp, -x * delta * 0.65 * turnScale * this.movementScale());
        if (y !== 0) this.planetRig.rotateX(-y * delta * 0.55 * turnScale * this.movementScale());
      }
    }
    const grabbing = left?.squeeze || right?.squeeze;
    if (right && !grabbing) {
      const [rawX, rawY] = this.activeAxes(right.source);
      const x = this.shapeAxis(rawX);
      const y = this.shapeAxis(rawY);
      if (this.comfort.turnMode === 'snap') this.applySnapTurn(x);
      else if (x !== 0) {
        // Heading is a comfort rotation, not surface travel; tying it to the
        // planet scale made turning effectively stop at street level.
        const turn = -x * delta * 0.85 * this.movementScale();
        this.planetRig.rotateOnWorldAxis(this.localSurfaceActive ? this.localRadial : this.worldUp, turn);
        // The world rotates opposite the viewer's clockwise heading.
        this.currentHeading -= turn;
      }
      if (y !== 0) this.moveRadially(y, delta);
    }
    if (left?.squeeze && right?.squeeze) this.updateDualGrab(left.grip, right.grip);
    else if (right?.squeeze) this.updateSingleGrab(right.grip);
    else if (left?.squeeze) this.updateSingleGrab(left.grip);
    if (!grabbing && right?.trigger) this.flyAlongRay(right.ray, delta, 1);
    if (!grabbing && left?.trigger) this.flyAlongRay(left.ray, delta, 0.28);
  }

  private reset(): void {
    this.planetRig.rotation.y = STARTING_YAW;
    this.planetRig.position.set(0, 1.35, -3.3);
    this.planetRig.scale.setScalar(1);
  }

  private activeAxes(source: XRInputSource): [number, number] {
    const axes = source.gamepad?.axes;
    if (!axes || axes.length < 2) return [0, 0];
    const first = [axes[0] ?? 0, axes[1] ?? 0] as [number, number];
    const second = axes.length >= 4 ? [axes[2] ?? 0, axes[3] ?? 0] as [number, number] : first;
    // Some runtimes retain a zeroed 2/3 pair. Choose the pair the user is
    // actually moving rather than relying on a nullish fallback.
    return Math.hypot(...first) > Math.hypot(...second) ? first : second;
  }

  private shapeAxis(value: number): number {
    const magnitude = Math.abs(value);
    if (magnitude <= DEAD_ZONE) return 0;
    const normalised = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
    return Math.sign(value) * normalised * normalised;
  }

  private stickTurnScale(): number {
    // A fixed angular rate turns into extreme ground speed after Earth scales
    // up. This keeps near-surface movement bounded in physical metres/second.
    const scale = Math.max(1, this.planetRig.scale.x);
    return 1 / (1 + (scale - 1) * 4);
  }

  private localTravelAngularRate(): number {
    const heightMeters = globeUnitsToMetres(this.getVirtualAltitude(), EARTH_RADIUS);
    // Geographic travel is most stable when expressed as real metres/second:
    // it slows to walking pace near the ground and reaches aircraft speed at
    // the tangent-mode boundary without depending on the rendered globe scale.
    const metersPerSecond = MathUtils.clamp(2 + heightMeters * 0.145, 2, 900);
    return metersPerSecond / EARTH_RADIUS_METERS;
  }

  private setTrigger(controller: Group, active: boolean): void {
    for (const state of this.hands.values()) if (state.ray === controller || state.grip === controller) state.trigger = active;
  }

  private startGrab(controller: Group): void {
    const state = this.handFor(controller);
    if (!state) return;
    state.squeeze = true;
    const left = this.hands.get('left');
    const right = this.hands.get('right');
    this.pulse(state, 0.18, 24);
    if (left?.squeeze && right?.squeeze) this.captureDualGrab(left.grip, right.grip);
    else this.captureSingleGrab(state.grip);
  }

  private endGrab(controller: Group): void {
    const state = this.handFor(controller);
    if (!state) return;
    state.squeeze = false;
    const remaining = [...this.hands.values()].find((hand) => hand.squeeze);
    if (remaining) this.captureSingleGrab(remaining.grip);
  }

  private captureSingleGrab(controller: Group): void {
    controller.getWorldPosition(this.grabStartControllerPosition);
    this.grabStartPlanet.copy(this.planetRig.quaternion);
    this.grabStartAltitude = this.getVirtualAltitude();
    this.grabStartOutward.copy(this.cameraPosition).sub(this.planetRig.position);
    if (this.grabStartOutward.lengthSq() < 0.000001) this.grabStartOutward.set(0, 0, 1);
    this.grabStartOutward.normalize();
  }

  private updateSingleGrab(controller: Group): void {
    controller.getWorldPosition(this.currentControllerPosition);
    this.grabTranslation.copy(this.currentControllerPosition).sub(this.grabStartControllerPosition);
    const radialDrag = this.grabTranslation.dot(this.grabStartOutward);
    this.grabTangent.copy(this.grabTranslation)
      .addScaledVector(this.grabStartOutward, -radialDrag);
    const tangentDistance = this.grabTangent.length();
    if (tangentDistance > 0.000001) {
      this.grabAxis.crossVectors(this.grabStartOutward, this.grabTangent).normalize();
      const physicalRadius = EARTH_RADIUS * Math.max(1, this.planetRig.scale.x);
      this.grabRotation.setFromAxisAngle(this.grabAxis, tangentDistance / physicalRadius);
      this.planetRig.quaternion.copy(this.grabRotation).multiply(this.grabStartPlanet);
    } else {
      this.planetRig.quaternion.copy(this.grabStartPlanet);
    }
    // Pulling the grabbed terrain toward the viewer descends; pushing it away
    // climbs. Tangential hand motion drags the surface beneath a stationary
    // viewer instead of carrying a small globe in the controller.
    this.setVirtualAltitude(this.grabStartAltitude * Math.exp(-radialDrag * 1.8));
  }

  private captureDualGrab(left: Group, right: Group): void {
    left.getWorldPosition(this.dualStartLeft);
    right.getWorldPosition(this.dualStartRight);
    this.dualStartMidpoint.copy(this.dualStartLeft).add(this.dualStartRight).multiplyScalar(0.5);
    this.dualStartVector.copy(this.dualStartRight).sub(this.dualStartLeft);
    this.dualStartDistance = Math.max(0.03, this.dualStartVector.length());
    this.dualStartVector.normalize();
    this.controllerFrame(left, right, this.dualStartFrame);
    this.dualStartPlanetPosition.copy(this.planetRig.position);
    this.dualStartPlanet.copy(this.planetRig.quaternion);
    this.dualStartAltitude = this.getVirtualAltitude();
  }

  private updateDualGrab(left: Group, right: Group): void {
    left.getWorldPosition(this.dualCurrentLeft);
    right.getWorldPosition(this.dualCurrentRight);
    this.dualCurrentMidpoint.copy(this.dualCurrentLeft).add(this.dualCurrentRight).multiplyScalar(0.5);
    this.dualCurrentVector.copy(this.dualCurrentRight).sub(this.dualCurrentLeft);
    const distance = Math.max(0.03, this.dualCurrentVector.length());
    const pinchRatio = MathUtils.clamp(distance / this.dualStartDistance, 0.2, 5);
    this.dualCurrentVector.normalize();
    this.controllerFrame(left, right, this.dualCurrentFrame);
    this.dualRotation.copy(this.dualStartFrame).invert().premultiply(this.dualCurrentFrame);
    this.planetRig.quaternion.copy(this.dualRotation).multiply(this.dualStartPlanet);
    // Keep the two-hand transform anchored at the midpoint, then apply pinch
    // to the shared virtual altitude—not camera FoV. This keeps every control
    // on the same zoom model and gives tile LOD a stable altitude.
    this.dualOffset.copy(this.dualStartPlanetPosition).sub(this.dualStartMidpoint)
      .applyQuaternion(this.dualRotation);
    this.planetRig.position.copy(this.dualCurrentMidpoint).add(this.dualOffset);
    const pinchExponent = MathUtils.lerp(
      ORBIT_PINCH_EXPONENT,
      SURFACE_PINCH_EXPONENT,
      this.nearSurfaceProgress(this.dualStartAltitude),
    );
    this.setVirtualAltitude(this.dualStartAltitude / Math.pow(pinchRatio, pinchExponent));
  }

  private handFor(controller: Group): HandState | undefined {
    return [...this.hands.values()].find((state) => state.ray === controller || state.grip === controller);
  }

  private flyAlongRay(controller: Group, delta: number, speed: number): void {
    // WebXR target rays point along controller-local -Z. Object3D's generic
    // getWorldDirection uses +Z for a Group, which made trigger flight move
    // the globe away and looked like a non-working zoom control.
    controller.getWorldQuaternion(this.rayQuaternion);
    this.controllerDirection.set(0, 0, -1).applyQuaternion(this.rayQuaternion).normalize();
    this.dualViewOffset.copy(this.planetRig.position).sub(this.cameraPosition);
    if (this.dualViewOffset.lengthSq() < 0.000001) this.dualViewOffset.set(0, 0, -1);
    this.dualViewOffset.normalize();
    const radialAlignment = this.controllerDirection.dot(this.dualViewOffset);
    this.flightTangent.copy(this.controllerDirection)
      .addScaledVector(this.dualViewOffset, -radialAlignment);
    const scale = this.planetRig.scale.x;
    const physicalClearance = Math.max(
      MIN_PHYSICAL_CLEARANCE,
      this.planetRig.position.distanceTo(this.cameraPosition) - EARTH_RADIUS * scale,
    );
    const lateralSpeed = Math.min(3, Math.max(0.08, physicalClearance * 1.4));
    this.planetRig.position.addScaledVector(this.flightTangent, -delta * speed * lateralSpeed);
    if (Math.abs(radialAlignment) > 0.08) {
      const altitude = this.getVirtualAltitude();
      this.setVirtualAltitude(
        altitude * Math.exp(-radialAlignment * delta * speed * this.zoomRateForAltitude(altitude)),
      );
    } else {
      this.enforceMinimumDistance();
    }
  }

  private moveRadially(input: number, delta: number): void {
    const altitude = this.getVirtualAltitude();
    this.setVirtualAltitude(altitude * Math.exp(input * delta * this.zoomRateForAltitude(altitude)));
  }

  private zoomRateForAltitude(altitude: number): number {
    return MathUtils.lerp(
      ORBIT_ZOOM_RATE,
      SURFACE_ZOOM_RATE,
      this.nearSurfaceProgress(altitude),
    );
  }

  private nearSurfaceProgress(altitude: number): number {
    if (altitude >= FLIGHT_SCALE_ALTITUDE) return 0;
    const minimum = this.minimumVirtualAltitude();
    return MathUtils.clamp(
      Math.log(FLIGHT_SCALE_ALTITUDE / Math.max(minimum, altitude))
        / Math.log(FLIGHT_SCALE_ALTITUDE / minimum),
      0,
      1,
    );
  }

  private enforceMinimumDistance(): void {
    this.dualViewOffset.copy(this.planetRig.position).sub(this.cameraPosition);
    const distance = this.dualViewOffset.length();
    const minimum = EARTH_RADIUS * this.planetRig.scale.x + MIN_PHYSICAL_CLEARANCE;
    if (distance < minimum) {
      if (distance < 0.000001) this.dualViewOffset.set(0, 0, -1);
      this.planetRig.position.copy(this.cameraPosition).addScaledVector(this.dualViewOffset.normalize(), minimum);
    }
  }

  private getVirtualAltitude(): number {
    const scale = Math.max(1, this.planetRig.scale.x);
    return MathUtils.clamp(
      this.planetRig.position.distanceTo(this.cameraPosition) / scale - EARTH_RADIUS,
      this.minimumVirtualAltitude(),
      MAX_VIRTUAL_ALTITUDE,
    );
  }

  /**
   * Orbital travel reduces physical camera-to-surface distance. Below the
   * flight threshold, further zoom enlarges Earth while keeping its surface at
   * a comfortable physical distance. In globe-local coordinates the virtual
   * altitude still falls continuously, so tile LOD progresses to buildings.
   */
  private setVirtualAltitude(requestedAltitude: number): void {
    const minimum = this.minimumVirtualAltitude();
    const altitude = MathUtils.clamp(requestedAltitude, minimum, this.maximumVirtualAltitude());
    const scale = MathUtils.clamp(FLIGHT_SCALE_ALTITUDE / altitude, 1, FLIGHT_SCALE_ALTITUDE / minimum);
    this.dualViewOffset.copy(this.planetRig.position).sub(this.cameraPosition);
    if (this.dualViewOffset.lengthSq() < 0.000001) this.dualViewOffset.set(0, 0, -1);
    const centreDistance = (EARTH_RADIUS + altitude) * scale;
    this.planetRig.scale.setScalar(scale);
    this.planetRig.position.copy(this.cameraPosition)
      .addScaledVector(this.dualViewOffset.normalize(), centreDistance);
    this.enforceMinimumDistance();
  }

  private installInput(index: number): void {
    const ray = this.renderer.xr.getController(index);
    const grip = this.renderer.xr.getControllerGrip(index);
    this.controllerRays.push(ray);
    this.controllerGrips.push(grip);

    const rayGeometry = new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0, -1)]);
    const rayVisual = new Line(rayGeometry, new LineBasicMaterial({ color: 0x9be5ff, transparent: true, opacity: 0.7 }));
    rayVisual.scale.z = 3;
    ray.add(rayVisual);
    grip.add(new Mesh(
      new SphereGeometry(0.035, 12, 8),
      new MeshBasicMaterial({ color: 0xc8f08b, transparent: true, opacity: 0.8 }),
    ));

    const connected = (event: { data: XRInputSource }): void => {
      const hand = event.data.handedness;
      if (hand !== 'left' && hand !== 'right') return;
      this.hands.set(hand, { source: event.data, ray, grip, trigger: false, squeeze: false, kind: 'controller' });
    };
    const disconnected = (): void => {
      for (const [hand, state] of this.hands) if (state.ray === ray) this.hands.delete(hand);
    };
    const selectStart = (): void => this.setTrigger(ray, true);
    const selectEnd = (): void => this.setTrigger(ray, false);
    const squeezeStart = (): void => this.startGrab(grip);
    const squeezeEnd = (): void => this.endGrab(grip);
    ray.addEventListener('connected', connected);
    ray.addEventListener('disconnected', disconnected);
    ray.addEventListener('selectstart', selectStart);
    ray.addEventListener('selectend', selectEnd);
    ray.addEventListener('squeezestart', squeezeStart);
    ray.addEventListener('squeezeend', squeezeEnd);
    this.listenerCleanup.push(() => {
      ray.removeEventListener('connected', connected);
      ray.removeEventListener('disconnected', disconnected);
      ray.removeEventListener('selectstart', selectStart);
      ray.removeEventListener('selectend', selectEnd);
      ray.removeEventListener('squeezestart', squeezeStart);
      ray.removeEventListener('squeezeend', squeezeEnd);
    });
    this.scene.add(ray, grip);

    if (this.comfort.handTracking !== false) {
      const handGroup = this.renderer.xr.getHand(index);
      const model = new XRHandModelFactory().createHandModel(handGroup, 'spheres');
      handGroup.add(model);
      const handConnected = (event: { data: XRInputSource }): void => {
        const hand = event.data.handedness;
        if (hand !== 'left' && hand !== 'right') return;
        this.hands.set(hand, { source: event.data, ray: handGroup, grip: handGroup, trigger: false, squeeze: false, kind: 'hand' });
      };
      const handDisconnected = (): void => {
        for (const [hand, state] of this.hands) if (state.grip === handGroup) this.hands.delete(hand);
      };
      const pinchStart = (): void => this.startGrab(handGroup);
      const pinchEnd = (): void => this.endGrab(handGroup);
      handGroup.addEventListener('connected', handConnected);
      handGroup.addEventListener('disconnected', handDisconnected);
      handGroup.addEventListener('pinchstart', pinchStart);
      handGroup.addEventListener('pinchend', pinchEnd);
      this.listenerCleanup.push(() => {
        handGroup.removeEventListener('connected', handConnected);
        handGroup.removeEventListener('disconnected', handDisconnected);
        handGroup.removeEventListener('pinchstart', pinchStart);
        handGroup.removeEventListener('pinchend', pinchEnd);
      });
      this.handGroups.push(handGroup);
      this.scene.add(handGroup);
    }
  }

  private controllerFrame(left: Group, right: Group, target: Quaternion): void {
    left.getWorldPosition(this.dualCurrentLeft);
    right.getWorldPosition(this.dualCurrentRight);
    this.frameX.copy(this.dualCurrentRight).sub(this.dualCurrentLeft).normalize();
    left.getWorldQuaternion(this.rayQuaternion);
    this.frameLeftUp.set(0, 1, 0).applyQuaternion(this.rayQuaternion);
    right.getWorldQuaternion(this.rayQuaternion);
    this.frameRightUp.set(0, 1, 0).applyQuaternion(this.rayQuaternion);
    this.frameY.copy(this.frameLeftUp).add(this.frameRightUp);
    this.frameY.addScaledVector(this.frameX, -this.frameY.dot(this.frameX));
    if (this.frameY.lengthSq() < 1e-8) {
      this.frameY.copy(this.worldUp).addScaledVector(this.frameX, -this.worldUp.dot(this.frameX));
    }
    this.frameY.normalize();
    this.frameZ.crossVectors(this.frameX, this.frameY).normalize();
    this.frameY.crossVectors(this.frameZ, this.frameX).normalize();
    this.frameMatrix.makeBasis(this.frameX, this.frameY, this.frameZ);
    target.setFromRotationMatrix(this.frameMatrix);
  }

  private pulse(state: HandState, intensity: number, duration: number): void {
    const gamepad = state.source.gamepad as Gamepad & { hapticActuators?: Array<{ pulse(value: number, duration: number): Promise<boolean> }> };
    void gamepad?.hapticActuators?.[0]?.pulse(intensity, duration).catch(() => undefined);
  }

  private applySnapTurn(input: number): void {
    if (Math.abs(input) < 0.25) {
      this.snapTurnReady = true;
      return;
    }
    if (!this.snapTurnReady || Math.abs(input) < 0.72) return;
    const angle = -Math.sign(input) * (this.comfort.snapTurnRadians ?? SNAP_TURN_ANGLE);
    this.planetRig.rotateOnWorldAxis(this.localSurfaceActive ? this.localRadial : this.worldUp, angle);
    this.currentHeading -= angle;
    this.snapTurnReady = false;
  }

  private movementScale(): number { return Math.max(0.1, this.comfort.movementScale ?? 1); }

  private xrProjection(camera: ArrayCamera): { fov: number; aspect: number } {
    let fov = 65;
    let aspect = 1;
    for (const eye of camera.cameras) {
      const elements = eye.projectionMatrix.elements;
      const eyeFov = MathUtils.radToDeg(2 * Math.atan(1 / Math.abs(elements[5] || 1)));
      const eyeAspect = Math.abs((elements[5] || 1) / (elements[0] || 1));
      if (Number.isFinite(eyeFov)) fov = Math.max(fov, eyeFov);
      if (Number.isFinite(eyeAspect)) aspect = Math.max(aspect, eyeAspect);
    }
    return { fov, aspect };
  }

  private updateSurfaceLayers(
    fov: number,
    aspect: number,
    worldGaze: Vector3,
    deltaSeconds: number,
  ): void {
    this.scene.updateMatrixWorld();
    this.cameraInGlobeSpace.copy(this.cameraPosition);
    this.planetRig.worldToLocal(this.cameraInGlobeSpace);
    const heightMeters = globeUnitsToMetres(
      Math.max(this.minimumVirtualAltitude(), this.cameraInGlobeSpace.length() - EARTH_RADIUS),
      EARTH_RADIUS,
    );
    const shouldUseLocal = heightMeters <= (this.localSurfaceActive ? LOCAL_MODE_EXIT_METERS : LOCAL_MODE_ENTER_METERS);
    const currentView = this.viewFromCurrentTransform(heightMeters);

    if (shouldUseLocal) this.configureNearGround(currentView, deltaSeconds);
    else if (this.localSurfaceActive) this.leaveNearGround();

    const skyVisibility = MathUtils.smoothstep(heightMeters, 40_000, 220_000);
    this.stars.visible = skyVisibility > 0.01;
    this.stars.material.opacity = 0.88 * skyVisibility;
    this.atmosphere.visible = this.lightingEnabled && skyVisibility > 0.01 && !this.localSurfaceActive;
    this.atmosphere.material.uniforms.glowStrength.value = skyVisibility;

    // The local transition can change the rig transform; derive selection rays
    // from the final matrix used for this frame.
    this.scene.updateMatrixWorld();
    this.cameraInGlobeSpace.copy(this.cameraPosition);
    this.planetRig.worldToLocal(this.cameraInGlobeSpace);
    this.gazeEnd.copy(this.cameraPosition).add(worldGaze);
    this.gazeInGlobeSpace.copy(this.gazeEnd);
    this.planetRig.worldToLocal(this.gazeInGlobeSpace);
    this.gazeInGlobeSpace.sub(this.cameraInGlobeSpace).normalize();
    const altitude = metresToGlobeUnits(heightMeters, EARTH_RADIUS);
    this.tiles.update({
      cameraInGlobeSpace: this.cameraInGlobeSpace,
      verticalFovDegrees: fov,
      aspect,
      gazeDirectionInGlobeSpace: this.gazeInGlobeSpace,
      altitude,
      localSurface: this.localSurfaceActive ? {
        anchorLongitudeDegrees: this.localAnchorLongitude,
        anchorLatitudeDegrees: this.localAnchorLatitude,
        metersPerWorldUnit: this.localMetersPerWorldUnit,
        maxRadiusMeters: this.localMaxRadiusMeters,
      } : null,
    });

    if (this.localSurfaceActive) {
      // setLocalMode configures a globe anchor for standalone consumers. This
      // renderer owns a separate ENU root, so keep the child itself identity.
      this.tiles.localGroup.position.set(0, 0, 0);
      this.tiles.localGroup.quaternion.identity();
      this.tiles.localGroup.scale.setScalar(1);
      this.buildings?.updateAt({
        longitudeRadians: MathUtils.degToRad(currentView.longitude),
        latitudeRadians: MathUtils.degToRad(currentView.latitude),
        altitudeMeters: heightMeters,
        verticalFovDegrees: fov,
        aspect,
      });
    } else {
      this.buildings?.update(this.cameraInGlobeSpace, fov, aspect);
    }
  }

  private configureNearGround(view: GeodeticView, deltaSeconds: number): void {
    // Keep the rendered altitude near room scale continuously. Tangent meshes
    // retain the scale from entry and their root absorbs the smooth ratio, so
    // zooming does not dispose/rebuild every building and focus-tile geometry.
    const worldMetersPerWorldUnit = Math.max(0.01, view.height / FLIGHT_SCALE_ALTITUDE);
    const entering = !this.localSurfaceActive;
    if (entering || !Number.isFinite(this.localMetersPerWorldUnit)) {
      this.localMetersPerWorldUnit = worldMetersPerWorldUnit;
    }
    const desiredPatchRadius = Math.min(
      LOCAL_MAX_PATCH_RADIUS_METERS,
      Math.max(
        LOCAL_MIN_PATCH_RADIUS_METERS,
        Math.sqrt(2 * EARTH_RADIUS_METERS * Math.max(1, view.height)) * 1.25,
      ),
    );
    this.localMaxRadiusMeters = quantizeLocalPatchRadius(desiredPatchRadius);
    const anchorInvalid = !Number.isFinite(this.localAnchorLongitude)
      || greatCircleDistanceMeters(
        { longitude: this.localAnchorLongitude, latitude: this.localAnchorLatitude },
        view,
      ) > Math.max(250, this.localMaxRadiusMeters * 0.1);
    if (anchorInvalid) {
      this.localAnchorLongitude = view.longitude;
      this.localAnchorLatitude = view.latitude;
    }

    if (entering) {
      this.localSurfaceActive = true;
      this.nearGroundRoot.visible = true;
      this.nearGroundRoot.add(this.tiles.localGroup);
      if (this.buildings) this.nearGroundRoot.add(this.buildings.group);
    }

    // Reorient the same geographic point from the former globe-in-front pose
    // toward a horizontal ground plane. The interpolation avoids a hard snap
    // during the aircraft-to-ground transition.
    this.centreDirection.copy(this.planetRig.position).sub(this.cameraPosition);
    if (this.centreDirection.lengthSq() < 1e-12) this.centreDirection.copy(this.worldDown);
    else this.centreDirection.normalize();
    const tiltAlpha = 1 - Math.exp(-LOCAL_TILT_RESPONSE * MathUtils.clamp(deltaSeconds, 0, 0.1));
    this.centreDirection.lerp(this.worldDown, tiltAlpha).normalize();
    this.localRadial.copy(this.centreDirection).multiplyScalar(-1);
    const longitude = MathUtils.degToRad(view.longitude);
    const latitude = MathUtils.degToRad(view.latitude);
    const cosLatitude = Math.cos(latitude);
    this.localSurfaceDirection.set(
      cosLatitude * Math.cos(longitude),
      Math.sin(latitude),
      -cosLatitude * Math.sin(longitude),
    );
    this.planetRig.quaternion.setFromUnitVectors(this.localSurfaceDirection, this.localRadial);
    this.headingRotation.setFromAxisAngle(this.localRadial, -this.currentHeading);
    this.planetRig.quaternion.premultiply(this.headingRotation);
    const globeScale = EARTH_RADIUS_METERS / (EARTH_RADIUS * worldMetersPerWorldUnit);
    const altitude = metresToGlobeUnits(view.height, EARTH_RADIUS);
    this.planetRig.scale.setScalar(globeScale);
    this.planetRig.position.copy(this.cameraPosition)
      .addScaledVector(this.centreDirection, (EARTH_RADIUS + altitude) * globeScale);

    this.configureNearGroundFrame(
      this.localAnchorLongitude,
      this.localAnchorLatitude,
      worldMetersPerWorldUnit,
    );
    if (this.buildings && (entering || anchorInvalid)) {
      this.buildings.setReferenceFrame({
        mode: 'local-tangent',
        anchorLongitudeDegrees: this.localAnchorLongitude,
        anchorLatitudeDegrees: this.localAnchorLatitude,
        metersPerWorldUnit: this.localMetersPerWorldUnit,
      });
    }
  }

  private configureNearGroundFrame(
    longitudeDegrees: number,
    latitudeDegrees: number,
    worldMetersPerWorldUnit: number,
  ): void {
    const longitude = MathUtils.degToRad(longitudeDegrees);
    const latitude = MathUtils.degToRad(latitudeDegrees);
    this.localEast.set(-Math.sin(longitude), 0, -Math.cos(longitude)).applyQuaternion(this.planetRig.quaternion);
    this.localNorth.set(
      -Math.sin(latitude) * Math.cos(longitude),
      Math.cos(latitude),
      Math.sin(latitude) * Math.sin(longitude),
    ).applyQuaternion(this.planetRig.quaternion);
    this.localRadial.set(
      Math.cos(latitude) * Math.cos(longitude),
      Math.sin(latitude),
      -Math.cos(latitude) * Math.sin(longitude),
    ).applyQuaternion(this.planetRig.quaternion);
    this.surfaceWorld.copy(this.localRadial)
      .multiplyScalar(EARTH_RADIUS * this.planetRig.scale.x)
      .add(this.planetRig.position);
    this.localSouth.copy(this.localNorth).multiplyScalar(-1);
    this.localFrameMatrix.makeBasis(this.localEast, this.localRadial, this.localSouth);
    this.nearGroundRoot.position.copy(this.surfaceWorld);
    this.nearGroundRoot.quaternion.setFromRotationMatrix(this.localFrameMatrix);
    this.nearGroundRoot.scale.setScalar(this.localMetersPerWorldUnit / worldMetersPerWorldUnit);
  }

  private leaveNearGround(): void {
    this.localSurfaceActive = false;
    this.nearGroundRoot.visible = false;
    this.tiles.group.add(this.tiles.localGroup);
    this.tiles.setLocalMode(null);
    if (this.buildings) {
      this.planetRig.add(this.buildings.group);
      this.buildings.group.position.set(0, 0, 0);
      this.buildings.group.quaternion.identity();
      this.buildings.setReferenceFrame({ mode: 'globe' });
    }
    this.nearGroundRoot.position.set(0, 0, 0);
    this.nearGroundRoot.quaternion.identity();
    this.nearGroundRoot.scale.setScalar(1);
    this.localAnchorLongitude = Number.NaN;
    this.localAnchorLatitude = Number.NaN;
    this.localMetersPerWorldUnit = Number.NaN;
    this.localMaxRadiusMeters = Number.NaN;
  }

  private viewFromCurrentTransform(height: number): GeodeticView {
    this.outwardWorld.copy(this.cameraPosition).sub(this.planetRig.position).normalize();
    this.inversePlanet.copy(this.planetRig.quaternion).invert();
    this.localSurfaceDirection.copy(this.outwardWorld).applyQuaternion(this.inversePlanet).normalize();
    return {
      ...directionGeodetic(this.localSurfaceDirection),
      height,
      heading: this.currentHeading,
      pitch: -Math.PI / 2,
      roll: 0,
    };
  }

  private updateDepthRange(): void {
    const scale = Math.max(1, this.planetRig.scale.x);
    const physicalRadius = EARTH_RADIUS * scale;
    const centreDistance = this.planetRig.position.distanceTo(this.cameraPosition);
    const clearance = Math.max(XR_NEAR, centreDistance - physicalRadius);
    const horizon = Math.sqrt(Math.max(0, clearance * (2 * physicalRadius + clearance)));
    const far = MathUtils.clamp(Math.max(XR_MIN_FAR, horizon * 1.6 + clearance), XR_MIN_FAR, 2_000_000);
    if (Math.abs(this.camera.far - far) / this.camera.far > 0.12) {
      this.camera.near = XR_NEAR;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    const session = this.session;
    const now = performance.now();
    if (
      !session
      || this.xrDepthUpdateInFlight
      || now - this.lastXrDepthUpdateTime < XR_DEPTH_UPDATE_INTERVAL_MS
      || Math.abs(this.xrDepthFar - far) / Math.max(XR_MIN_FAR, this.xrDepthFar) <= 0.12
    ) return;

    this.xrDepthUpdateInFlight = true;
    this.lastXrDepthUpdateTime = now;
    try {
      void session.updateRenderState({ depthNear: XR_NEAR, depthFar: far })
        .then(() => {
          if (this.session === session) this.xrDepthFar = far;
        })
        .catch(() => undefined)
        .finally(() => { this.xrDepthUpdateInFlight = false; });
    } catch {
      // A session can end between the frame check and updateRenderState.
      this.xrDepthUpdateInFlight = false;
    }
  }

  private adaptQuality(): void {
    const now = performance.now();
    if (now - this.lastQualityUpdateTime < 2_000) return;
    this.lastQualityUpdateTime = now;
    const configured = this.comfort.foveation;
    if (configured !== undefined) return;
    const target = this.frameTimeAverage > 1 / 64 ? 0.78 : this.frameTimeAverage < 1 / 82 ? 0.48 : 0.6;
    this.renderer.xr.setFoveation(target);
  }

  private resizePreview(): void {
    const width = Math.max(1, this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private notifyViewChange(force = false, view?: GeodeticView): void {
    if (!this.options.onViewChange) return;
    const now = performance.now();
    if (!force && now - this.lastViewEventTime < 120) return;
    this.lastViewEventTime = now;
    try { this.options.onViewChange(view ?? this.getView()); } catch { /* Host callbacks cannot stop XR rendering. */ }
  }

  private createAttributionSprite(text: string): Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for XR attribution');
    context.fillStyle = '#02070bcc';
    context.roundRect(0, 0, canvas.width, canvas.height, 28);
    context.fill();
    context.fillStyle = '#e9f8ff';
    context.font = '600 34px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(`${text} · openstreetmap.org/copyright`, canvas.width / 2, canvas.height / 2, canvas.width - 64);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0.78 }));
    sprite.position.set(0, -0.52, -1.25);
    sprite.scale.set(1.85, 0.116, 1);
    sprite.renderOrder = 10_000;
    return sprite;
  }

  private minimumVirtualAltitude(): number {
    return metresToGlobeUnits(Math.max(1, this.options.minimumHeightMeters ?? 2), EARTH_RADIUS);
  }

  private maximumVirtualAltitude(): number {
    return metresToGlobeUnits(Math.max(1_000, this.options.maximumHeightMeters ?? 100_000_000), EARTH_RADIUS);
  }

  private assertUsable(): void {
    if (this.state === 'disposing' || this.state === 'disposed') throw new Error('XR renderer has been disposed');
  }
}

function quantizeLocalPatchRadius(desiredRadiusMeters: number): number {
  const power = Math.round(Math.log2(desiredRadiusMeters / LOCAL_MIN_PATCH_RADIUS_METERS));
  return MathUtils.clamp(
    LOCAL_MIN_PATCH_RADIUS_METERS * 2 ** power,
    LOCAL_MIN_PATCH_RADIUS_METERS,
    LOCAL_MAX_PATCH_RADIUS_METERS,
  );
}

function isXrCapabilityUnsupported(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: unknown }).name === 'NotSupportedError';
}
