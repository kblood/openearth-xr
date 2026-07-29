import type {
  BuildingFootprint,
  BuildingTileProvider,
} from "./BuildingProvider";

const WEB_MERCATOR_LIMIT = (85.05112878 * Math.PI) / 180;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.68557849;

export interface BuildingTileSelectionOptions {
  readonly longitudeRadians: number;
  readonly latitudeRadians: number;
  readonly altitudeMeters: number;
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly maxTiles: number;
  readonly overscan?: number;
  readonly previousZoom?: number;
  readonly zoomHysteresis?: number;
}

export interface SelectedBuildingTile {
  readonly key: string;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly priority: number;
}

export interface BuildingTileSelection {
  readonly level: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly viewSpanMeters: number;
  readonly coveredSpanMeters: number;
  readonly signature: string;
  readonly tiles: readonly SelectedBuildingTile[];
}

/** Pure view-to-tile calculation, kept independent of either render engine. */
export function selectBuildingTiles(
  provider: BuildingTileProvider,
  options: BuildingTileSelectionOptions,
): BuildingTileSelection {
  const minimum = clampInteger(options.minZoom, 0, 30);
  const maximum = clampInteger(options.maxZoom, minimum, 30);
  const latitude = clamp(
    options.latitudeRadians,
    -WEB_MERCATOR_LIMIT,
    WEB_MERCATOR_LIMIT,
  );
  const altitude = Math.max(1, finite(options.altitudeMeters, 1));
  const fov = clamp(
    finite(options.verticalFovRadians, Math.PI / 3),
    Math.PI / 18,
    Math.PI * 0.9,
  );
  const aspect = clamp(finite(options.aspect, 1), 0.35, 4);
  const overscan = clamp(finite(options.overscan, 1.35), 1, 3);
  const tileBudget = Math.max(1, Math.floor(finite(options.maxTiles, 9)));
  const maximumRadius = Math.max(
    0,
    Math.floor((Math.sqrt(tileBudget) - 1) / 2),
  );
  const viewSpanMeters =
    Math.max(
      altitude * 2 * Math.tan(fov / 2),
      altitude * 2 * Math.tan(fov / 2) * aspect,
    ) * overscan;
  const circumferenceAtLatitude = Math.max(
    1,
    EARTH_CIRCUMFERENCE_METERS * Math.cos(latitude),
  );
  const desiredTilesAcross = Math.max(1, maximumRadius * 2 - 0.5);
  const continuousZoom = Math.log2(
    (circumferenceAtLatitude * desiredTilesAcross) / viewSpanMeters,
  );
  let level = clampInteger(Math.round(continuousZoom), minimum, maximum);
  const previous = options.previousZoom;
  const hysteresis = clamp(finite(options.zoomHysteresis, 0.65), 0, 1.5);
  if (
    previous !== undefined &&
    previous >= minimum &&
    previous <= maximum &&
    Math.abs(continuousZoom - previous) <= hysteresis
  ) {
    level = previous;
  }

  // Prefer reducing LOD to exceeding the renderer's hard tile budget.
  let radius = requiredRadius(
    viewSpanMeters,
    circumferenceAtLatitude / 2 ** level,
    maximumRadius,
  );
  while (level > minimum && (radius * 2 + 1) ** 2 > tileBudget) {
    level -= 1;
    radius = requiredRadius(
      viewSpanMeters,
      circumferenceAtLatitude / 2 ** level,
      maximumRadius,
    );
  }
  radius = Math.min(maximumRadius, radius);

  const count = 2 ** level;
  const centerX = wrap(
    Math.floor(((options.longitudeRadians + Math.PI) / (2 * Math.PI)) * count),
    count,
  );
  const centerY = clampInteger(
    Math.floor(((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2) * count),
    0,
    count - 1,
  );
  const tiles: SelectedBuildingTile[] = [];
  for (let row = -radius; row <= radius; row += 1) {
    const y = centerY + row;
    if (y < 0 || y >= count) continue;
    for (let column = -radius; column <= radius; column += 1) {
      const x = wrap(centerX + column, count);
      if (provider.hasTile && !provider.hasTile(level, x, y)) continue;
      tiles.push({
        key: `${level}/${x}/${y}`,
        z: level,
        x,
        y,
        priority: column * column + row * row,
      });
    }
  }
  tiles.sort(
    (left, right) =>
      left.priority - right.priority || left.y - right.y || left.x - right.x,
  );
  return {
    level,
    centerX,
    centerY,
    radius,
    viewSpanMeters,
    coveredSpanMeters:
      (circumferenceAtLatitude / 2 ** level) * (radius * 2 + 1),
    signature: `${level}/${centerX}/${centerY}/${radius}`,
    tiles,
  };
}

export interface BuildingDensityOptions {
  readonly maxFootprints: number;
  readonly maxVertices: number;
  readonly maxTriangles: number;
  readonly minAreaSquareMeters: number;
}

export interface BudgetedBuilding {
  readonly footprint: BuildingFootprint;
  readonly pointCount: number;
  readonly estimatedTriangles: number;
  readonly areaSquareMeters: number;
}

/** Keeps important footprints first and provides a deterministic hard geometry cap. */
export function budgetBuildingFootprints(
  buildings: ReadonlyArray<BuildingFootprint>,
  options: BuildingDensityOptions,
): readonly BudgetedBuilding[] {
  const candidates: BudgetedBuilding[] = [];
  for (const footprint of buildings) {
    const rings = footprint.rings.filter((ring) => ring.length >= 4);
    if (rings.length === 0) continue;
    const pointCount = rings.reduce(
      (sum, ring) => sum + openPointCount(ring),
      0,
    );
    if (pointCount < 3) continue;
    const areaSquareMeters = approximateAreaSquareMeters(rings[0]);
    if (
      !Number.isFinite(areaSquareMeters) ||
      areaSquareMeters < options.minAreaSquareMeters
    )
      continue;
    candidates.push({
      footprint,
      pointCount,
      estimatedTriangles:
        Math.max(1, pointCount + 2 * (rings.length - 1) - 2) + pointCount * 2,
      areaSquareMeters,
    });
  }
  candidates.sort(
    (left, right) =>
      right.areaSquareMeters - left.areaSquareMeters ||
      String(left.footprint.id ?? "").localeCompare(
        String(right.footprint.id ?? ""),
      ),
  );
  const selected: BudgetedBuilding[] = [];
  let vertices = 0;
  let triangles = 0;
  for (const candidate of candidates) {
    if (selected.length >= options.maxFootprints) break;
    const candidateVertices = candidate.pointCount * 5;
    if (
      vertices + candidateVertices > options.maxVertices ||
      triangles + candidate.estimatedTriangles > options.maxTriangles
    )
      continue;
    selected.push(candidate);
    vertices += candidateVertices;
    triangles += candidate.estimatedTriangles;
  }
  return selected;
}

export type ScheduledBuildingTask<T> = (signal: AbortSignal) => Promise<T>;

/** Small abort-aware FIFO with priority; callers retain retry state themselves. */
export class BuildingTaskQueue {
  private readonly pending: Array<{
    readonly priority: number;
    readonly controller: AbortController;
    readonly task: ScheduledBuildingTask<unknown>;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];
  private active = 0;
  private readonly activeControllers = new Set<AbortController>();
  private disposed = false;

  constructor(readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Building task concurrency must be positive");
  }

  schedule<T>(
    priority: number,
    controller: AbortController,
    task: ScheduledBuildingTask<T>,
  ): Promise<T> {
    if (this.disposed)
      return Promise.reject(
        new DOMException("Building task queue disposed", "AbortError"),
      );
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        priority,
        controller,
        task: task as ScheduledBuildingTask<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pending.sort((left, right) => left.priority - right.priority);
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeControllers) controller.abort();
    for (const item of this.pending.splice(0)) {
      item.controller.abort();
      item.reject(
        new DOMException("Building task queue disposed", "AbortError"),
      );
    }
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.active < this.concurrency &&
      this.pending.length > 0
    ) {
      const item = this.pending.shift()!;
      if (item.controller.signal.aborted) {
        item.reject(new DOMException("Building task cancelled", "AbortError"));
        continue;
      }
      this.active += 1;
      this.activeControllers.add(item.controller);
      void item
        .task(item.controller.signal)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeControllers.delete(item.controller);
          this.active -= 1;
          this.pump();
        });
    }
  }
}

export function buildingRetryDelay(
  attempt: number,
  random = Math.random,
): number {
  const exponential = Math.min(
    60_000,
    1_000 * 2 ** Math.min(6, Math.max(0, attempt - 1)),
  );
  return Math.round(exponential * (0.8 + clamp(random(), 0, 1) * 0.4));
}

function requiredRadius(
  viewSpan: number,
  tileSpan: number,
  maximum: number,
): number {
  const across = Math.max(1, Math.ceil(viewSpan / Math.max(1, tileSpan)) + 1);
  return Math.min(maximum, Math.max(0, Math.ceil((across - 1) / 2)));
}

function approximateAreaSquareMeters(
  ring: BuildingFootprint["rings"][number],
): number {
  const count = openPointCount(ring);
  if (count < 3) return 0;
  const latitude =
    ((ring.slice(0, count).reduce((sum, point) => sum + point[1], 0) / count) *
      Math.PI) /
    180;
  const metresPerDegreeLatitude = 111_132;
  const metresPerDegreeLongitude = 111_320 * Math.max(0.01, Math.cos(latitude));
  let twiceArea = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const x1 = ring[index][0] * metresPerDegreeLongitude;
    const y1 = ring[index][1] * metresPerDegreeLatitude;
    const x2 = ring[next][0] * metresPerDegreeLongitude;
    const y2 = ring[next][1] * metresPerDegreeLatitude;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2;
}

function openPointCount(ring: BuildingFootprint["rings"][number]): number {
  const last = ring.length - 1;
  return ring.length > 1 &&
    ring[0][0] === ring[last][0] &&
    ring[0][1] === ring[last][1]
    ? last
    : ring.length;
}

function finite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(
    maximum,
    Math.max(minimum, Math.floor(finite(value, minimum))),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function wrap(value: number, count: number): number {
  return ((value % count) + count) % count;
}
