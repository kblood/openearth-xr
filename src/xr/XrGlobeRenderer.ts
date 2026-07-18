import {
  AmbientLight,
  Clock,
  Color,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Quaternion,
  Vector3,
  WebGLRenderer,
} from 'three';
import { CARTO_VOYAGER, createGlobalOverviewTexture, XyzTileGlobe } from './XyzTileGlobe';

const STARTING_YAW = -0.8;
const DEAD_ZONE = 0.12;
const EARTH_RADIUS = 1.45;
const MIN_ALTITUDE = 0.001;

type Hand = 'left' | 'right';
type HandState = { source: XRInputSource; controller: Group; trigger: boolean; squeeze: boolean };

/**
 * A single, compositor-owned Three.js scene for immersive presentation.
 * Cesium remains the precision desktop renderer; this renderer deliberately
 * owns the whole headset frame so WebXR can supply correct per-eye cameras.
 */
export class XrGlobeRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(65, 1, 0.00005, 30);
  private readonly planetRig = new Group();
  private readonly clock = new Clock();
  private readonly hands = new Map<Hand, HandState>();
  private readonly tiles = new XyzTileGlobe(EARTH_RADIUS, CARTO_VOYAGER);
  private readonly cameraPosition = new Vector3();
  private readonly cameraInGlobeSpace = new Vector3();
  private readonly controllerDirection = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly worldForward = new Vector3(0, 0, 1);
  private readonly grabStartController = new Quaternion();
  private readonly currentController = new Quaternion();
  private readonly grabStartPlanet = new Quaternion();
  private readonly inverseGrabStart = new Quaternion();
  private readonly grabStartControllerPosition = new Vector3();
  private readonly grabStartPlanetPosition = new Vector3();
  private readonly currentControllerPosition = new Vector3();
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
  private dualStartDistance = 1;
  private dualStartViewDistance = 1;
  private session: XRSession | null = null;
  private onEnd: (() => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFoveation(0.6);

    this.scene.background = new Color(0x030812);
    this.camera.position.set(0, 1.6, 0);
    this.scene.add(new AmbientLight(0xffffff, 0.72));
    const sun = new DirectionalLight(0xffffff, 1.45);
    sun.position.set(-3, 4, 2);
    this.scene.add(sun);

    const material = new MeshBasicMaterial({ color: 0xd9e7f5 });
    const earth = new Mesh(new SphereGeometry(EARTH_RADIUS, 64, 48), material);
    this.planetRig.position.set(0, 1.35, -3.3);
    this.planetRig.rotation.y = STARTING_YAW;
    this.planetRig.add(earth);
    this.planetRig.add(this.tiles.group);
    this.scene.add(this.planetRig);

    // Never place a Web-Mercator XYZ tile directly on a sphere: its UVs are
    // equirectangular and would make the globe disagree with the close tiles.
    // This overview is reprojected from the same provider used by the surface.
    void createGlobalOverviewTexture(CARTO_VOYAGER)
      .then((texture) => { material.map = texture; material.needsUpdate = true; })
      .catch(() => undefined);

    for (let index = 0; index < 2; index += 1) {
      const controller = this.renderer.xr.getController(index);
      controller.addEventListener('connected', (event: { data: XRInputSource }) => {
        const hand = event.data.handedness;
        if (hand === 'left' || hand === 'right') this.hands.set(hand, { source: event.data, controller, trigger: false, squeeze: false });
      });
      controller.addEventListener('disconnected', () => {
        for (const [hand, state] of this.hands) if (state.controller === controller) this.hands.delete(hand);
      });
      controller.addEventListener('selectstart', () => this.setTrigger(controller, true));
      controller.addEventListener('selectend', () => this.setTrigger(controller, false));
      controller.addEventListener('squeezestart', () => this.startGrab(controller));
      controller.addEventListener('squeezeend', () => this.endGrab(controller));
      this.scene.add(controller);
    }
  }

  get active(): boolean { return this.session !== null; }

  /** Development-only deterministic renderer used to inspect the exact tile
   * coverage at a chosen physical camera-to-centre distance without a headset. */
  startPreview(distance: number, longitude = 10.2, latitude = 56.1): void {
    this.canvas.hidden = false;
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(0, 1.6, 0);
    this.planetRig.position.set(0, 1.6, -Math.max(EARTH_RADIUS + MIN_ALTITUDE, distance));
    const lon = MathUtils.degToRad(longitude);
    const lat = MathUtils.degToRad(latitude);
    this.previewTarget.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    this.planetRig.quaternion.setFromUnitVectors(this.previewTarget, this.worldForward);
    this.planetRig.scale.setScalar(1);
    this.clock.start();
    this.renderer.setAnimationLoop(this.renderPreview);
  }

  async enter(onEnd: () => void, onStarted: () => void): Promise<void> {
    if (this.session) return;
    const xr = navigator.xr;
    if (!xr) throw new Error('WebXR is unavailable');

    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await session.updateRenderState({ depthNear: 0.00005 });
    this.canvas.hidden = false;
    this.session = session;
    this.onEnd = onEnd;
    session.addEventListener('end', this.handleSessionEnd, { once: true });
    try {
      await this.renderer.xr.setSession(session);
      this.clock.start();
      this.renderer.setAnimationLoop(this.render);
      onStarted();
    } catch (error) {
      this.session = null;
      this.canvas.hidden = true;
      await session.end();
      throw error;
    }
  }

  async exit(): Promise<void> { await this.session?.end(); }

  private readonly handleSessionEnd = (): void => {
    this.renderer.setAnimationLoop(null);
    this.hands.clear();
    this.session = null;
    this.canvas.hidden = true;
    const callback = this.onEnd;
    this.onEnd = null;
    callback?.();
  };

  private readonly render = (): void => {
    const delta = Math.min(this.clock.getDelta(), 1 / 30);
    this.applyControllerInput(delta);
    const xrCamera = this.renderer.xr.getCamera();
    this.cameraPosition.setFromMatrixPosition(xrCamera.matrixWorld);
    this.cameraInGlobeSpace.copy(this.cameraPosition);
    this.planetRig.worldToLocal(this.cameraInGlobeSpace);
    this.tiles.update(this.cameraInGlobeSpace, this.camera.fov, this.camera.aspect);
    this.renderer.render(this.scene, this.camera);
  };

  private readonly renderPreview = (): void => {
    this.scene.updateMatrixWorld();
    this.cameraPosition.copy(this.camera.position);
    this.cameraInGlobeSpace.copy(this.cameraPosition);
    this.planetRig.worldToLocal(this.cameraInGlobeSpace);
    this.tiles.update(this.cameraInGlobeSpace, this.camera.fov, this.camera.aspect);
    this.renderer.render(this.scene, this.camera);
  };

  private applyControllerInput(delta: number): void {
    const left = this.hands.get('left');
    const right = this.hands.get('right');
    if (left) {
      const [x, y] = this.activeAxes(left.source);
      // Left stick pans the world below the viewer instead of duplicating
      // rotation. It is deliberately separate from the right-hand heading.
      if (Math.abs(x) > DEAD_ZONE) this.planetRig.rotateOnWorldAxis(this.worldUp, -x * delta * 0.9);
      if (Math.abs(y) > DEAD_ZONE) this.planetRig.rotateX(-y * delta * 0.72);
    }
    const grabbing = left?.squeeze || right?.squeeze;
    if (right && !grabbing) {
      const [x, y] = this.activeAxes(right.source);
      if (Math.abs(x) > DEAD_ZONE) this.planetRig.rotateOnWorldAxis(this.worldUp, -x * delta * 1.35);
      if (Math.abs(y) > DEAD_ZONE) this.moveRadially(y, delta);
    }
    if (left?.squeeze && right?.squeeze) this.updateDualGrab(left.controller, right.controller);
    else if (right?.squeeze) this.updateSingleGrab(right.controller);
    else if (left?.squeeze) this.updateSingleGrab(left.controller);
    if (!grabbing && right?.trigger) this.flyAlongRay(right.controller, delta, 1);
    if (!grabbing && left?.trigger) this.flyAlongRay(left.controller, delta, 0.28);
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

  private setTrigger(controller: Group, active: boolean): void {
    for (const state of this.hands.values()) if (state.controller === controller) state.trigger = active;
  }

  private startGrab(controller: Group): void {
    const state = this.handFor(controller);
    if (!state) return;
    state.squeeze = true;
    const left = this.hands.get('left');
    const right = this.hands.get('right');
    if (left?.squeeze && right?.squeeze) this.captureDualGrab(left.controller, right.controller);
    else this.captureSingleGrab(controller);
  }

  private endGrab(controller: Group): void {
    const state = this.handFor(controller);
    if (!state) return;
    state.squeeze = false;
    const remaining = [...this.hands.values()].find((hand) => hand.squeeze);
    if (remaining) this.captureSingleGrab(remaining.controller);
  }

  private captureSingleGrab(controller: Group): void {
    controller.getWorldPosition(this.grabStartControllerPosition);
    controller.getWorldQuaternion(this.grabStartController);
    this.grabStartPlanetPosition.copy(this.planetRig.position);
    this.grabStartPlanet.copy(this.planetRig.quaternion);
  }

  private updateSingleGrab(controller: Group): void {
    controller.getWorldPosition(this.currentControllerPosition);
    controller.getWorldQuaternion(this.currentController);
    this.inverseGrabStart.copy(this.grabStartController).invert();
    this.currentController.multiply(this.inverseGrabStart).multiply(this.grabStartPlanet);
    this.planetRig.quaternion.copy(this.currentController);
    this.planetRig.position.copy(this.currentControllerPosition).sub(this.grabStartControllerPosition).add(this.grabStartPlanetPosition);
    this.enforceMinimumDistance();
  }

  private captureDualGrab(left: Group, right: Group): void {
    left.getWorldPosition(this.dualStartLeft);
    right.getWorldPosition(this.dualStartRight);
    this.dualStartMidpoint.copy(this.dualStartLeft).add(this.dualStartRight).multiplyScalar(0.5);
    this.dualStartVector.copy(this.dualStartRight).sub(this.dualStartLeft);
    this.dualStartDistance = Math.max(0.03, this.dualStartVector.length());
    this.dualStartVector.normalize();
    this.dualStartPlanetPosition.copy(this.planetRig.position);
    this.dualStartPlanet.copy(this.planetRig.quaternion);
    this.dualStartViewDistance = Math.max(EARTH_RADIUS + MIN_ALTITUDE, this.dualStartPlanetPosition.distanceTo(this.cameraPosition));
  }

  private updateDualGrab(left: Group, right: Group): void {
    left.getWorldPosition(this.dualCurrentLeft);
    right.getWorldPosition(this.dualCurrentRight);
    this.dualCurrentMidpoint.copy(this.dualCurrentLeft).add(this.dualCurrentRight).multiplyScalar(0.5);
    this.dualCurrentVector.copy(this.dualCurrentRight).sub(this.dualCurrentLeft);
    const distance = Math.max(0.03, this.dualCurrentVector.length());
    const pinchRatio = distance / this.dualStartDistance;
    this.dualCurrentVector.normalize();
    this.dualRotation.setFromUnitVectors(this.dualStartVector, this.dualCurrentVector);
    this.planetRig.quaternion.copy(this.dualRotation).multiply(this.dualStartPlanet);
    // Keep the globe carried by the midpoint, then apply pinch as *distance*
    // to the globe—not camera FoV or world scale. This keeps every control on
    // the same physical zoom model and gives tile LOD a stable altitude.
    this.dualOffset.copy(this.dualStartPlanetPosition).sub(this.dualStartMidpoint)
      .applyQuaternion(this.dualRotation);
    this.planetRig.position.copy(this.dualCurrentMidpoint).add(this.dualOffset);
    this.dualViewOffset.copy(this.planetRig.position).sub(this.cameraPosition);
    const viewDistance = Math.min(36, Math.max(EARTH_RADIUS + MIN_ALTITUDE, this.dualStartViewDistance / pinchRatio));
    this.planetRig.position.copy(this.cameraPosition).addScaledVector(this.dualViewOffset.normalize(), viewDistance);
    this.enforceMinimumDistance();
  }

  private handFor(controller: Group): HandState | undefined {
    return [...this.hands.values()].find((state) => state.controller === controller);
  }

  private flyAlongRay(controller: Group, delta: number, speed: number): void {
    controller.getWorldDirection(this.controllerDirection);
    const altitude = Math.max(MIN_ALTITUDE, this.planetRig.position.distanceTo(this.cameraPosition) - EARTH_RADIUS);
    const altitudeSpeed = Math.min(14, Math.max(0.06, altitude * 1.3));
    this.planetRig.position.addScaledVector(this.controllerDirection, -delta * speed * altitudeSpeed);
    this.enforceMinimumDistance();
  }

  private moveRadially(input: number, delta: number): void {
    this.dualViewOffset.copy(this.planetRig.position).sub(this.cameraPosition);
    const distance = this.dualViewOffset.length();
    const altitude = Math.max(MIN_ALTITUDE, distance - EARTH_RADIUS);
    const speed = Math.min(14, Math.max(0.06, altitude * 1.3));
    const nextDistance = Math.min(36, Math.max(EARTH_RADIUS + MIN_ALTITUDE, distance + input * delta * speed));
    this.planetRig.position.copy(this.cameraPosition).addScaledVector(this.dualViewOffset.normalize(), nextDistance);
  }

  private enforceMinimumDistance(): void {
    this.dualViewOffset.copy(this.planetRig.position).sub(this.cameraPosition);
    const distance = this.dualViewOffset.length();
    const minimum = EARTH_RADIUS + MIN_ALTITUDE;
    if (distance < minimum) {
      if (distance < 0.000001) this.dualViewOffset.set(0, 0, -1);
      this.planetRig.position.copy(this.cameraPosition).addScaledVector(this.dualViewOffset.normalize(), minimum);
    }
  }
}
