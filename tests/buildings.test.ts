import { describe, expect, it, vi } from "vitest";
import vtPbf from "vt-pbf";
import {
  BuildingProviderError,
  MvtBuildingProvider,
  decodeMvtBuildingTile,
  type BuildingFootprint,
  type BuildingTileProvider,
} from "../src/buildings/BuildingProvider";
import {
  createBuildingGeometry,
  createLocalTangentBuildingGeometry,
  XrBuildingLayer,
} from "../src/buildings/XrBuildingLayer";
import {
  BuildingTaskQueue,
  budgetBuildingFootprints,
  buildingRetryDelay,
  selectBuildingTiles,
} from "../src/buildings/BuildingStreaming";

describe("MVT building decoding", () => {
  it("preserves footprint holes and OpenMapTiles extrusion fields", () => {
    const bytes = vtPbf.fromGeojsonVt(
      {
        building: {
          features: [
            {
              id: 42,
              type: 3,
              tags: {
                render_height: 24,
                render_min_height: 3,
                colour: "aabbcc",
              },
              geometry: [
                [
                  [500, 500],
                  [3500, 500],
                  [3500, 3500],
                  [500, 3500],
                  [500, 500],
                ],
                [
                  [1400, 1400],
                  [1400, 2600],
                  [2600, 2600],
                  [2600, 1400],
                  [1400, 1400],
                ],
              ],
            },
          ],
        },
      },
      { extent: 4096, version: 2 },
    );

    const [building] = decodeMvtBuildingTile(bytes, 14, 8_764, 5_125);
    expect(building.rings).toHaveLength(2);
    expect(building.heightMeters).toBe(24);
    expect(building.minHeightMeters).toBe(3);
    expect(building.color).toBe("aabbcc");
  });

  it("filters outlines and applies a safe default height", () => {
    const bytes = vtPbf.fromGeojsonVt(
      {
        building: {
          features: [
            polygonFeature({ hide_3d: true, render_height: 80 }),
            polygonFeature({}),
          ],
        },
      },
      { extent: 4096, version: 2 },
    );

    const buildings = decodeMvtBuildingTile(bytes, 14, 0, 0);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].heightMeters).toBe(9);
  });

  it("rejects corrupt and adversarial payloads with structured errors", () => {
    expect(() =>
      decodeMvtBuildingTile(new Uint8Array([255, 255, 255]), 14, 0, 0),
    ).toThrowError(
      expect.objectContaining({ code: "DECODE", retryable: false }),
    );
    const bytes = vtPbf.fromGeojsonVt(
      {
        building: { features: [polygonFeature({}), polygonFeature({})] },
      },
      { extent: 4096, version: 2 },
    );
    expect(() =>
      decodeMvtBuildingTile(bytes, 14, 0, 0, "building", 9, { maxFeatures: 1 }),
    ).toThrowError(expect.objectContaining({ code: "DECODE_LIMIT" }));
    expect(() =>
      decodeMvtBuildingTile(bytes, 14, 0, 0, "building", 9, { maxVertices: 4 }),
    ).toThrowError(expect.objectContaining({ code: "DECODE_LIMIT" }));
  });
});

describe("MVT provider hardening", () => {
  it("does not choose an unrelated child for below-min requests and maps descendants safely", async () => {
    const requests: string[] = [];
    const emptyTile = vtPbf.fromGeojsonVt(
      { building: { features: [] } },
      { extent: 4096, version: 2 },
    );
    const provider = new MvtBuildingProvider({
      id: "test",
      attribution: "test",
      minZoom: 13,
      maxZoom: 14,
      url: (z, x, y) => `https://tiles.test/${z}/${x}/${y}.pbf`,
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(Uint8Array.from(emptyTile).buffer, { status: 200 });
      },
    });
    await expect(provider.loadTile(12, 2_000, 1_000)).resolves.toEqual([]);
    expect(requests).toEqual([]);
    await provider.loadTile(16, 35_052, 20_512);
    expect(requests).toEqual(["https://tiles.test/14/8763/5128.pbf"]);
    expect(provider.hasTile(12, 2_000, 1_000)).toBe(false);
  });

  it("resolves relative TileJSON endpoints, layer metadata, bounds, and multiple templates", async () => {
    const requested: string[] = [];
    const emptyTile = vtPbf.fromGeojsonVt(
      { building: { features: [] } },
      { extent: 4096, version: 2 },
    );
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("source.json")) {
        const response = new Response(
          JSON.stringify({
            tiles: ["./a/{z}/{x}/{y}.pbf", "../b/{z}/{x}/{y}.pbf"],
            bounds: [10, 54, 14, 58],
            vector_layers: [{ id: "building", minzoom: 12, maxzoom: 15 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        Object.defineProperty(response, "url", {
          value: "https://example.test/maps/source.json",
        });
        return response;
      }
      return new Response(Uint8Array.from(emptyTile).buffer, { status: 200 });
    });
    const provider = new MvtBuildingProvider({
      id: "tilejson",
      attribution: "test",
      tileJsonUrl: "https://example.test/maps/source.json",
      fetch: fetcher,
    });
    await provider.loadTile(14, 8_763, 5_128);
    expect(provider.minZoom).toBe(12);
    expect(provider.maxZoom).toBe(15);
    expect(requested[1]).toMatch(
      /^https:\/\/example\.test\/(maps\/a|b)\/14\/8763\/5128\.pbf$/,
    );
    expect(provider.hasTile(14, 0, 0)).toBe(false);
  });

  it("enforces declared and actual byte limits", async () => {
    const provider = new MvtBuildingProvider({
      id: "large",
      attribution: "test",
      minZoom: 0,
      maxZoom: 0,
      maxTileBytes: 4,
      url: () => "https://tiles.test/large.pbf",
      fetch: async () => new Response(new ArrayBuffer(8), { status: 200 }),
    });
    await expect(provider.loadTile(0, 0, 0)).rejects.toMatchObject({
      code: "TILE_TOO_LARGE",
      retryable: false,
    });
  });

  it("reports cancellation without starting an aborted request", async () => {
    const fetcher = vi.fn();
    const provider = new MvtBuildingProvider({
      id: "abort",
      attribution: "test",
      minZoom: 0,
      maxZoom: 0,
      url: () => "https://tiles.test/0/0/0.pbf",
      fetch: fetcher,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.loadTile(0, 0, 0, controller.signal),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts an in-flight TileJSON request once every waiter cancels", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    });
    const provider = new MvtBuildingProvider({
      id: "tilejson-abort",
      attribution: "test",
      tileJsonUrl: "https://tiles.test/source.json",
      fetch: fetcher,
    });
    const controller = new AbortController();
    const request = provider.loadTile(14, 8_000, 5_000, controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "ABORTED" });
    expect(observedSignal!.aborted).toBe(true);
  });

  it("classifies malformed TileJSON as a non-retryable decode error", async () => {
    const provider = new MvtBuildingProvider({
      id: "bad-tilejson",
      attribution: "test",
      tileJsonUrl: "https://tiles.test/source.json",
      fetch: async () => new Response("{not-json", { status: 200 }),
    });
    await expect(provider.loadTile(14, 8_000, 5_000)).rejects.toMatchObject({
      code: "DECODE",
      retryable: false,
    });
  });
});

describe("building streaming policy", () => {
  const provider: BuildingTileProvider = {
    id: "selection",
    attribution: "test",
    minZoom: 12,
    maxZoom: 16,
    loadTile: async () => [],
  };

  it("keeps selection within budget and reduces LOD with altitude", () => {
    const close = selectBuildingTiles(provider, {
      longitudeRadians: (12.56 * Math.PI) / 180,
      latitudeRadians: (55.67 * Math.PI) / 180,
      altitudeMeters: 300,
      verticalFovRadians: Math.PI / 3,
      aspect: 1.2,
      minZoom: 12,
      maxZoom: 16,
      maxTiles: 9,
    });
    const far = selectBuildingTiles(provider, {
      longitudeRadians: (12.56 * Math.PI) / 180,
      latitudeRadians: (55.67 * Math.PI) / 180,
      altitudeMeters: 12_000,
      verticalFovRadians: Math.PI / 3,
      aspect: 1.2,
      minZoom: 12,
      maxZoom: 16,
      maxTiles: 9,
    });
    expect(close.tiles.length).toBeLessThanOrEqual(9);
    expect(far.tiles.length).toBeLessThanOrEqual(9);
    expect(close.level).toBeGreaterThan(far.level);
    expect(close.tiles[0].priority).toBe(0);
  });

  it("bounds concurrency and rejects queued work when disposed", async () => {
    const queue = new BuildingTaskQueue(2);
    let active = 0;
    let maximum = 0;
    const jobs = Array.from({ length: 5 }, (_, priority) => {
      const controller = new AbortController();
      return queue.schedule(priority, controller, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return priority;
      });
    });
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(maximum).toBe(2);
    queue.dispose();
    await expect(
      queue.schedule(0, new AbortController(), async () => 1),
    ).rejects.toThrow(/disposed/i);
  });

  it("uses exponential retry with bounded jitter", () => {
    expect(buildingRetryDelay(1, () => 0)).toBe(800);
    expect(buildingRetryDelay(2, () => 0.5)).toBe(2_000);
    expect(buildingRetryDelay(20, () => 1)).toBe(72_000);
  });

  it("retains failed XR tiles until their retry deadline", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const loadTile = vi.fn(async () => {
      throw new BuildingProviderError("HTTP", "temporary", true);
    });
    const layer = new XrBuildingLayer(
      1.45,
      {
        id: "retry",
        attribution: "test",
        minZoom: 14,
        maxZoom: 14,
        loadTile,
      },
      { maxTiles: 1, concurrency: 1 },
    );
    const view = {
      longitudeRadians: 0,
      latitudeRadians: 0,
      altitudeMeters: 500,
    };
    layer.updateAt(view);
    await vi.waitFor(() => expect(loadTile).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    layer.updateAt(view);
    expect(loadTile).toHaveBeenCalledTimes(1);
    now.mockReturnValue(3_000);
    layer.updateAt(view);
    await vi.waitFor(() => expect(loadTile).toHaveBeenCalledTimes(2));
    layer.dispose();
    now.mockRestore();
  });

  it("rebuilds loaded XR tiles for a local frame without refetching", async () => {
    const footprint: BuildingFootprint = {
      rings: [
        [
          [0, 0],
          [0.0001, 0],
          [0.0001, 0.0001],
          [0, 0.0001],
          [0, 0],
        ],
      ],
      minHeightMeters: 0,
      heightMeters: 12,
    };
    const loadTile = vi.fn(async () => [footprint]);
    const layer = new XrBuildingLayer(
      1.45,
      {
        id: "frame",
        attribution: "test",
        minZoom: 14,
        maxZoom: 14,
        loadTile,
      },
      { maxTiles: 1, concurrency: 1, minAreaSquareMeters: 0 },
    );
    layer.updateAt({
      longitudeRadians: 0,
      latitudeRadians: 0,
      altitudeMeters: 500,
    });
    await vi.waitFor(() => expect(layer.group.children).toHaveLength(1));
    layer.setReferenceFrame({
      mode: "local-tangent",
      anchorLongitudeDegrees: 0,
      anchorLatitudeDegrees: 0,
      metersPerWorldUnit: 1,
    });
    expect(layer.group.children).toHaveLength(0);
    layer.updateAt({
      longitudeRadians: 0,
      latitudeRadians: 0,
      altitudeMeters: 500,
    });
    expect(layer.group.children).toHaveLength(1);
    expect(loadTile).toHaveBeenCalledTimes(1);
    layer.dispose();
  });
});

describe("XR building geometry", () => {
  it("creates roofs and walls on the globe without flattening the footprint", () => {
    const footprint: BuildingFootprint = {
      rings: [
        [
          [12.56, 55.67],
          [12.561, 55.67],
          [12.561, 55.671],
          [12.56, 55.671],
          [12.56, 55.67],
        ],
      ],
      minHeightMeters: 0,
      heightMeters: 18,
    };
    const geometry = createBuildingGeometry([footprint], 1.45);

    expect(geometry).not.toBeNull();
    expect(geometry!.getAttribute("position").count).toBeGreaterThan(8);
    expect(geometry!.index!.count).toBeGreaterThan(12);
    expect(geometry!.boundingSphere!.radius).toBeGreaterThan(0);
    geometry!.dispose();
  });

  it("can produce near-origin metre-scale local tangent geometry", () => {
    const footprint: BuildingFootprint = {
      rings: [
        [
          [12.56, 55.67],
          [12.5602, 55.67],
          [12.5602, 55.6702],
          [12.56, 55.6702],
          [12.56, 55.67],
        ],
      ],
      minHeightMeters: 0,
      heightMeters: 20,
    };
    const geometry = createLocalTangentBuildingGeometry([footprint], {
      mode: "local-tangent",
      anchorLongitudeDegrees: 12.56,
      anchorLatitudeDegrees: 55.67,
      metersPerWorldUnit: 1,
    });
    const position = geometry!.getAttribute("position");
    let maximum = 0;
    for (let index = 0; index < position.count; index += 1) {
      maximum = Math.max(
        maximum,
        Math.abs(position.getX(index)),
        Math.abs(position.getY(index)),
        Math.abs(position.getZ(index)),
      );
    }
    expect(maximum).toBeGreaterThan(19);
    expect(maximum).toBeLessThan(30);
    geometry!.dispose();
  });

  it("filters tiny geometry and enforces hard density budgets", () => {
    const footprints = Array.from(
      { length: 10 },
      (_, index): BuildingFootprint => ({
        id: index,
        rings: [
          [
            [0, 0],
            [0.0001 + index * 0.000001, 0],
            [0.0001, 0.0001],
            [0, 0.0001],
            [0, 0],
          ],
        ],
        minHeightMeters: 0,
        heightMeters: 9,
      }),
    );
    const selected = budgetBuildingFootprints(footprints, {
      maxFootprints: 2,
      maxVertices: 1_000,
      maxTriangles: 1_000,
      minAreaSquareMeters: 1,
    });
    expect(selected).toHaveLength(2);
  });
});

function polygonFeature(tags: Record<string, string | number | boolean>) {
  return {
    type: 3,
    tags,
    geometry: [
      [
        [500, 500],
        [3500, 500],
        [3500, 3500],
        [500, 3500],
        [500, 500],
      ],
    ],
  };
}
