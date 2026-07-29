import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShapeUtils,
  Vector2,
  Vector3,
} from "three";
import {
  BuildingProviderError,
  type BuildingFootprint,
  type BuildingPosition,
  type BuildingTileProvider,
} from "./BuildingProvider";
import {
  budgetBuildingFootprints,
  BuildingTaskQueue,
  buildingRetryDelay,
  selectBuildingTiles,
  type BuildingTileSelection,
  type SelectedBuildingTile,
} from "./BuildingStreaming";

const EARTH_RADIUS_METERS = 6_378_137;
const MAX_BUILDING_ALTITUDE_METERS = 17_500;
const SURFACE_OFFSET_METERS = 0.35;
const DEFAULT_COLOR = new Color("#d8c8ad");

export interface XrBuildingLayerOptions {
  readonly maxTiles?: number;
  readonly concurrency?: number;
  readonly maxFootprintsPerTile?: number;
  readonly maxVerticesPerTile?: number;
  readonly maxTrianglesPerTile?: number;
  readonly minAreaSquareMeters?: number;
}

/**
 * Local tangent coordinates are x=east, y=up, z=-north. Attach the layer group
 * to a camera-relative scene root when using this mode.
 */
export type XrBuildingReferenceFrame =
  | { readonly mode: "globe" }
  | {
      readonly mode: "local-tangent";
      readonly anchorLongitudeDegrees: number;
      readonly anchorLatitudeDegrees: number;
      readonly metersPerWorldUnit: number;
    };

export interface XrBuildingView {
  readonly longitudeRadians: number;
  readonly latitudeRadians: number;
  readonly altitudeMeters: number;
  readonly verticalFovDegrees?: number;
  readonly aspect?: number;
}

export interface BuildingGeometryOptions {
  readonly maxFootprints?: number;
  readonly maxVertices?: number;
  readonly maxTriangles?: number;
  readonly minAreaSquareMeters?: number;
  readonly referenceFrame?: XrBuildingReferenceFrame;
  /** Used by globe mode to keep Float32 positions close to zero. */
  readonly originLongitudeDegrees?: number;
  readonly originLatitudeDegrees?: number;
}

type TileRecord = {
  readonly tile: SelectedBuildingTile;
  controller: AbortController | null;
  state: "queued" | "loading" | "ready" | "failed";
  failures: number;
  retryAt: number;
  buildings?: ReadonlyArray<BuildingFootprint>;
  mesh?: Mesh;
};

/** Curved building extrusion with bounded, retry-safe streaming for WebXR. */
export class XrBuildingLayer {
  readonly group = new Group();
  private readonly tiles = new Map<string, TileRecord>();
  private readonly direction = new Vector3();
  private readonly queue: BuildingTaskQueue;
  private readonly material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0,
    side: FrontSide,
  });
  private readonly density;
  private readonly maxTiles: number;
  private selection: BuildingTileSelection | null = null;
  private referenceFrame: XrBuildingReferenceFrame = { mode: "globe" };
  private active = false;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly radius: number,
    readonly provider: BuildingTileProvider,
    options: XrBuildingLayerOptions = {},
  ) {
    if (!Number.isFinite(radius) || radius <= 0)
      throw new Error("XR building radius must be positive");
    this.maxTiles = Math.max(1, Math.floor(options.maxTiles ?? 9));
    this.queue = new BuildingTaskQueue(options.concurrency ?? 3);
    this.density = {
      maxFootprints: options.maxFootprintsPerTile ?? 2_500,
      maxVertices: options.maxVerticesPerTile ?? 125_000,
      maxTriangles: options.maxTrianglesPerTile ?? 75_000,
      minAreaSquareMeters: options.minAreaSquareMeters ?? 8,
    };
    this.group.renderOrder = 10;
  }

  /** Backward-compatible globe update; callers may now pass real XR FOV/aspect. */
  update(
    cameraInGlobeSpace: Vector3,
    verticalFovDegrees = 65,
    aspect = 1,
  ): void {
    if (this.disposed || this.suspended) return;
    const distance = cameraInGlobeSpace.length();
    if (distance <= 0) return this.deactivate();
    const altitudeMeters =
      ((distance - this.radius) / this.radius) * EARTH_RADIUS_METERS;
    this.direction.copy(cameraInGlobeSpace).divideScalar(distance);
    this.updateAt({
      longitudeRadians: Math.atan2(-this.direction.z, this.direction.x),
      latitudeRadians: Math.asin(Math.min(1, Math.max(-1, this.direction.y))),
      altitudeMeters,
      verticalFovDegrees,
      aspect,
    });
  }

  /** View-driven entry point used by camera-relative/local-tangent renderers. */
  updateAt(view: XrBuildingView): void {
    if (this.disposed || this.suspended) return;
    const wasActive = this.active;
    const enterAltitude = MAX_BUILDING_ALTITUDE_METERS * 0.9;
    const leaveAltitude = MAX_BUILDING_ALTITUDE_METERS * 1.1;
    const shouldBeActive =
      view.altitudeMeters >= 0 &&
      (this.active
        ? view.altitudeMeters <= leaveAltitude
        : view.altitudeMeters <= enterAltitude);
    if (!shouldBeActive) return this.deactivate();
    this.active = true;
    this.group.visible = true;
    const selection = selectBuildingTiles(this.provider, {
      longitudeRadians: view.longitudeRadians,
      latitudeRadians: view.latitudeRadians,
      altitudeMeters: Math.max(1, view.altitudeMeters),
      verticalFovRadians: ((view.verticalFovDegrees ?? 65) * Math.PI) / 180,
      aspect: view.aspect ?? 1,
      minZoom: this.provider.minZoom,
      maxZoom: this.provider.maxZoom,
      maxTiles: this.maxTiles,
      previousZoom: this.selection?.level,
    });
    if (
      selection.coveredSpanMeters <
      selection.viewSpanMeters * (wasActive ? 0.75 : 0.9)
    ) {
      return this.deactivate();
    }
    if (selection.signature === this.selection?.signature) {
      this.retryFailedTiles(performance.now());
      this.rebuildPendingMeshes();
      return;
    }
    this.selection = selection;
    const desired = new Set(selection.tiles.map((tile) => tile.key));
    for (const key of [...this.tiles.keys()])
      if (!desired.has(key)) this.removeTile(key);
    for (const tile of selection.tiles) {
      if (this.tiles.has(tile.key)) continue;
      const record: TileRecord = {
        tile,
        controller: null,
        state: "queued",
        failures: 0,
        retryAt: 0,
      };
      this.tiles.set(tile.key, record);
      this.requestTile(record);
    }
    this.retryFailedTiles(performance.now());
    this.rebuildPendingMeshes();
  }

  setReferenceFrame(frame: XrBuildingReferenceFrame): void {
    if (this.disposed) return;
    validateReferenceFrame(frame);
    if (sameReferenceFrame(this.referenceFrame, frame)) return;
    this.referenceFrame = frame;
    for (const record of this.tiles.values()) {
      if (!record.mesh) continue;
      record.mesh.removeFromParent();
      record.mesh.geometry.dispose();
      record.mesh = undefined;
    }
  }

  suspend(): void {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    this.deactivate();
  }

  resume(): void {
    if (!this.suspended || this.disposed) return;
    this.suspended = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.dispose();
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
    this.material.dispose();
    this.group.removeFromParent();
  }

  private deactivate(): void {
    this.active = false;
    this.selection = null;
    this.group.visible = false;
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  private requestTile(record: TileRecord): void {
    if (
      this.disposed ||
      this.suspended ||
      this.tiles.get(record.tile.key) !== record
    )
      return;
    const controller = new AbortController();
    record.controller = controller;
    record.state = "queued";
    void this.queue
      .schedule(record.tile.priority, controller, async (signal) => {
        record.state = "loading";
        return this.provider.loadTile(
          record.tile.z,
          record.tile.x,
          record.tile.y,
          signal,
        );
      })
      .then((buildings) => {
        if (
          this.disposed ||
          this.suspended ||
          controller.signal.aborted ||
          this.tiles.get(record.tile.key) !== record
        )
          return;
        record.buildings = buildings;
        this.installMesh(record, buildings);
        record.controller = null;
        record.state = "ready";
        record.failures = 0;
        record.retryAt = 0;
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          this.disposed ||
          this.tiles.get(record.tile.key) !== record
        )
          return;
        record.controller = null;
        record.state = "failed";
        record.failures += 1;
        record.retryAt = isRetryable(error)
          ? performance.now() + buildingRetryDelay(record.failures)
          : Number.POSITIVE_INFINITY;
      });
  }

  private retryFailedTiles(now: number): void {
    for (const record of this.tiles.values()) {
      if (record.state === "failed" && now >= record.retryAt)
        this.requestTile(record);
    }
  }

  private rebuildPendingMeshes(maximumPerFrame = 1): void {
    let rebuilt = 0;
    for (const record of this.tiles.values()) {
      if (record.state !== "ready" || !record.buildings || record.mesh)
        continue;
      this.installMesh(record, record.buildings);
      rebuilt += 1;
      if (rebuilt >= maximumPerFrame) break;
    }
  }

  private installMesh(
    record: TileRecord,
    buildings: ReadonlyArray<BuildingFootprint>,
  ): void {
    if (record.mesh) {
      record.mesh.removeFromParent();
      record.mesh.geometry.dispose();
      record.mesh = undefined;
    }
    const count = 2 ** record.tile.z;
    const originLongitudeDegrees = ((record.tile.x + 0.5) / count) * 360 - 180;
    const originLatitudeDegrees =
      (Math.atan(
        Math.sinh(Math.PI * (1 - (2 * (record.tile.y + 0.5)) / count)),
      ) *
        180) /
      Math.PI;
    const result = createBuildingGeometryResult(buildings, this.radius, {
      ...this.density,
      referenceFrame: this.referenceFrame,
      originLongitudeDegrees,
      originLatitudeDegrees,
    });
    if (!result) return;
    const mesh = new Mesh(result.geometry, this.material);
    mesh.position.copy(result.origin);
    mesh.renderOrder = 10;
    record.mesh = mesh;
    this.group.add(mesh);
  }

  private removeTile(key: string): void {
    const record = this.tiles.get(key);
    if (!record) return;
    record.controller?.abort();
    if (record.mesh) {
      record.mesh.removeFromParent();
      record.mesh.geometry.dispose();
    }
    this.tiles.delete(key);
  }
}

/** Existing globe-native helper; layer streaming additionally uses tile-local origins. */
export function createBuildingGeometry(
  buildings: ReadonlyArray<BuildingFootprint>,
  radius: number,
  options: BuildingGeometryOptions = {},
): BufferGeometry | null {
  return (
    createBuildingGeometryResult(buildings, radius, options)?.geometry ?? null
  );
}

export function createLocalTangentBuildingGeometry(
  buildings: ReadonlyArray<BuildingFootprint>,
  frame: Extract<XrBuildingReferenceFrame, { mode: "local-tangent" }>,
  options: Omit<BuildingGeometryOptions, "referenceFrame"> = {},
): BufferGeometry | null {
  return createBuildingGeometry(buildings, 1, {
    ...options,
    referenceFrame: frame,
  });
}

function createBuildingGeometryResult(
  buildings: ReadonlyArray<BuildingFootprint>,
  radius: number,
  options: BuildingGeometryOptions,
): { readonly geometry: BufferGeometry; readonly origin: Vector3 } | null {
  const frame = options.referenceFrame ?? { mode: "globe" };
  validateReferenceFrame(frame);
  const selected = budgetBuildingFootprints(buildings, {
    maxFootprints: options.maxFootprints ?? Number.MAX_SAFE_INTEGER,
    maxVertices: options.maxVertices ?? Number.MAX_SAFE_INTEGER,
    maxTriangles: options.maxTriangles ?? Number.MAX_SAFE_INTEGER,
    minAreaSquareMeters: options.minAreaSquareMeters ?? 0,
  });
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const hasGlobeOrigin =
    frame.mode === "globe" &&
    options.originLongitudeDegrees !== undefined &&
    options.originLatitudeDegrees !== undefined;
  const origin = hasGlobeOrigin
    ? globePosition(
        options.originLongitudeDegrees!,
        options.originLatitudeDegrees!,
        radius,
      )
    : new Vector3();
  const metersToWorld = radius / EARTH_RADIUS_METERS;
  for (const { footprint: building } of selected) {
    const rings = building.rings
      .map(openRing)
      .filter((ring) => ring.length >= 3);
    if (rings.length === 0) continue;
    const color = parseColor(building.color);
    const projectedRings = rings.map((ring) =>
      ring.map((position) => projectForTriangulation(position, frame, options)),
    );
    const faces = ShapeUtils.triangulateShape(
      projectedRings[0],
      projectedRings.slice(1),
    );
    const roofStart = positions.length / 3;
    for (const ring of rings) {
      for (const position of ring)
        pushVertex(
          positions,
          colors,
          position,
          building.heightMeters,
          radius,
          metersToWorld,
          frame,
          origin,
          color,
        );
    }
    for (const face of faces)
      indices.push(
        roofStart + face[0],
        roofStart + face[1],
        roofStart + face[2],
      );
    for (const ring of rings) {
      for (let index = 0; index < ring.length; index += 1) {
        const next = (index + 1) % ring.length;
        const sideStart = positions.length / 3;
        pushVertex(
          positions,
          colors,
          ring[index],
          building.minHeightMeters,
          radius,
          metersToWorld,
          frame,
          origin,
          color,
        );
        pushVertex(
          positions,
          colors,
          ring[next],
          building.minHeightMeters,
          radius,
          metersToWorld,
          frame,
          origin,
          color,
        );
        pushVertex(
          positions,
          colors,
          ring[index],
          building.heightMeters,
          radius,
          metersToWorld,
          frame,
          origin,
          color,
        );
        pushVertex(
          positions,
          colors,
          ring[next],
          building.heightMeters,
          radius,
          metersToWorld,
          frame,
          origin,
          color,
        );
        indices.push(
          sideStart,
          sideStart + 1,
          sideStart + 2,
          sideStart + 2,
          sideStart + 1,
          sideStart + 3,
        );
      }
    }
  }
  if (indices.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, origin };
}

function pushVertex(
  positions: number[],
  colors: number[],
  [longitudeDegrees, latitudeDegrees]: BuildingPosition,
  heightMeters: number,
  radius: number,
  metersToWorld: number,
  frame: XrBuildingReferenceFrame,
  origin: Vector3,
  color: Color,
): void {
  if (frame.mode === "local-tangent") {
    const latitudeRadians = (frame.anchorLatitudeDegrees * Math.PI) / 180;
    const eastMeters =
      ((wrappedLongitudeDelta(longitudeDegrees, frame.anchorLongitudeDegrees) *
        Math.PI) /
        180) *
      EARTH_RADIUS_METERS *
      Math.cos(latitudeRadians);
    const northMeters =
      (((latitudeDegrees - frame.anchorLatitudeDegrees) * Math.PI) / 180) *
      EARTH_RADIUS_METERS;
    positions.push(
      eastMeters / frame.metersPerWorldUnit,
      (heightMeters + SURFACE_OFFSET_METERS) / frame.metersPerWorldUnit,
      -northMeters / frame.metersPerWorldUnit,
    );
  } else {
    const point = globePosition(
      longitudeDegrees,
      latitudeDegrees,
      radius + (heightMeters + SURFACE_OFFSET_METERS) * metersToWorld,
    );
    positions.push(point.x - origin.x, point.y - origin.y, point.z - origin.z);
  }
  colors.push(color.r, color.g, color.b);
}

function projectForTriangulation(
  [longitude, latitude]: BuildingPosition,
  frame: XrBuildingReferenceFrame,
  options: BuildingGeometryOptions,
): Vector2 {
  const anchorLongitude =
    frame.mode === "local-tangent"
      ? frame.anchorLongitudeDegrees
      : (options.originLongitudeDegrees ?? longitude);
  const anchorLatitude =
    frame.mode === "local-tangent"
      ? frame.anchorLatitudeDegrees
      : (options.originLatitudeDegrees ?? latitude);
  return new Vector2(
    wrappedLongitudeDelta(longitude, anchorLongitude) *
      Math.cos((anchorLatitude * Math.PI) / 180),
    latitude - anchorLatitude,
  );
}

function globePosition(
  longitudeDegrees: number,
  latitudeDegrees: number,
  radius: number,
): Vector3 {
  const longitude = (longitudeDegrees * Math.PI) / 180;
  const latitude = (latitudeDegrees * Math.PI) / 180;
  const cosLatitude = Math.cos(latitude);
  return new Vector3(
    radius * cosLatitude * Math.cos(longitude),
    radius * Math.sin(latitude),
    -radius * cosLatitude * Math.sin(longitude),
  );
}

function openRing(
  ring: ReadonlyArray<BuildingPosition>,
): ReadonlyArray<BuildingPosition> {
  if (
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    return ring.slice(0, -1);
  }
  return ring;
}

function parseColor(value: string | undefined): Color {
  if (!value) return DEFAULT_COLOR;
  if (!/^(#?[0-9a-f]{3,8}|[a-z]+|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(value))
    return DEFAULT_COLOR;
  try {
    return new Color(/^[0-9a-f]{3,8}$/i.test(value) ? `#${value}` : value);
  } catch {
    return DEFAULT_COLOR;
  }
}

function validateReferenceFrame(frame: XrBuildingReferenceFrame): void {
  if (frame.mode === "globe") return;
  if (
    !Number.isFinite(frame.anchorLongitudeDegrees) ||
    !Number.isFinite(frame.anchorLatitudeDegrees) ||
    frame.anchorLatitudeDegrees < -90 ||
    frame.anchorLatitudeDegrees > 90 ||
    !Number.isFinite(frame.metersPerWorldUnit) ||
    frame.metersPerWorldUnit <= 0
  ) {
    throw new Error("Invalid XR local-tangent building reference frame");
  }
}

function sameReferenceFrame(
  left: XrBuildingReferenceFrame,
  right: XrBuildingReferenceFrame,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "globe" ||
      (right.mode === "local-tangent" &&
        left.anchorLongitudeDegrees === right.anchorLongitudeDegrees &&
        left.anchorLatitudeDegrees === right.anchorLatitudeDegrees &&
        left.metersPerWorldUnit === right.metersPerWorldUnit))
  );
}

function wrappedLongitudeDelta(longitude: number, anchor: number): number {
  return ((longitude - anchor + 540) % 360) - 180;
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof BuildingProviderError) || error.retryable;
}
