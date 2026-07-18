import {
  AmbientLight,
  Clock,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  TextureLoader,
  WebGLRenderer,
} from 'three';

const STARTING_YAW = -0.8;
const STARTING_SCALE = 1;
const DEAD_ZONE = 0.12;

/**
 * A single, compositor-owned Three.js scene for immersive presentation.
 * Cesium remains the precision desktop renderer; this renderer deliberately
 * owns the whole headset frame so WebXR can supply correct per-eye cameras.
 */
export class XrGlobeRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(65, 1, 0.05, 30);
  private readonly planetRig = new Group();
  private readonly clock = new Clock();
  private readonly controllers = new Map<number, XRInputSource>();
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
    const earth = new Mesh(new SphereGeometry(1.45, 64, 48), material);
    earth.rotation.y = Math.PI;
    this.planetRig.position.set(0, 1.35, -3.3);
    this.planetRig.rotation.y = STARTING_YAW;
    this.planetRig.add(earth);
    this.scene.add(this.planetRig);

    // OSM permits CORS image use. A neutral globe remains visible while the
    // texture downloads, so a transient tile failure never produces black VR.
    new TextureLoader().load(
      'https://tile.openstreetmap.org/0/0/0.png',
      (texture) => { material.map = texture; material.needsUpdate = true; },
    );

    for (let index = 0; index < 2; index += 1) {
      const controller = this.renderer.xr.getController(index);
      controller.addEventListener('connected', (event: { data: XRInputSource }) => this.controllers.set(index, event.data));
      controller.addEventListener('disconnected', () => this.controllers.delete(index));
      controller.addEventListener('selectstart', () => this.reset());
      this.scene.add(controller);
    }
  }

  get active(): boolean { return this.session !== null; }

  async enter(onEnd: () => void, onStarted: () => void): Promise<void> {
    if (this.session) return;
    const xr = navigator.xr;
    if (!xr) throw new Error('WebXR is unavailable');

    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
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
    this.controllers.clear();
    this.session = null;
    this.canvas.hidden = true;
    const callback = this.onEnd;
    this.onEnd = null;
    callback?.();
  };

  private readonly render = (): void => {
    const delta = Math.min(this.clock.getDelta(), 1 / 30);
    this.applyControllerInput(delta);
    this.renderer.render(this.scene, this.camera);
  };

  private applyControllerInput(delta: number): void {
    for (const source of this.controllers.values()) {
      const axes = source.gamepad?.axes;
      if (!axes || axes.length < 2) continue;
      // Quest Touch exposes stick axes at 2/3. Some trackpads expose them at
      // 0/1, so support both layouts instead of silently ignoring controls.
      const horizontal = axes[2] ?? axes[0] ?? 0;
      const vertical = axes[3] ?? axes[1] ?? 0;
      if (Math.abs(horizontal) > DEAD_ZONE) this.planetRig.rotation.y -= horizontal * delta * 1.65;
      if (Math.abs(vertical) > DEAD_ZONE) {
        const nextScale = this.planetRig.scale.x * Math.exp(-vertical * delta * 1.1);
        const scale = Math.min(2.8, Math.max(0.18, nextScale));
        this.planetRig.scale.setScalar(scale);
      }
    }
  }

  private reset(): void {
    this.planetRig.rotation.y = STARTING_YAW;
    this.planetRig.scale.setScalar(STARTING_SCALE);
  }
}
