import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "three";
import {
  CompositeXyzTileProvider,
  XyzTileGlobe,
  type XyzAtlasReadyEvent,
  type XyzTileProvider,
} from "../src/xr/XyzTileGlobe";

describe("multi-ring XYZ globe streaming", () => {
  beforeEach(() => installCanvasDocument());
  afterEach(() => vi.unstubAllGlobals());

  it("loads atlas cells center-first and preserves the previous atlas on a partial failure", async () => {
    let failEasternTile = false;
    const calls: Array<{ x: number; y: number }> = [];
    const source = provider({
      minZoom: 3,
      maxZoom: 3,
      loadTile: async (_z, x, y) => {
        calls.push({ x, y });
        return failEasternTile && x === 5
          ? {
              status: "error",
              error: new Error("temporary pack read failure"),
              retryAfterMs: 10_000,
            }
          : bitmap(`${x}/${y}`);
      },
    });
    const events: XyzAtlasReadyEvent[] = [];
    const globe = new XyzTileGlobe(1, source, {
      schedulerOptions: { concurrency: 1 },
      onAtlasReady: (event) => events.push(event),
    });

    globe.update(cameraAt(-90, 0, 1.01), 60, 1);
    await vi.waitFor(() =>
      expect(events.some((event) => event.layer === "base")).toBe(true),
    );
    expect(calls[0]).toEqual({ x: 1, y: 3 });
    const firstKey = internalLayer(globe, "baseLayer").displayedKey;

    calls.length = 0;
    failEasternTile = true;
    globe.update(cameraAt(90, 0, 1.01), 60, 1);
    await vi.waitFor(() =>
      expect(calls.some((tile) => tile.x === 5)).toBe(true),
    );
    await vi.waitFor(() => expect(globe.scheduler.active).toBe(0));
    expect(internalLayer(globe, "baseLayer").displayedKey).toBe(firstKey);
    expect(events.filter((event) => event.layer === "base")).toHaveLength(1);
    globe.dispose();
  });

  it("uses gaze targeting and an optional tangent focus patch at human scale", async () => {
    const calls: Array<{ x: number; y: number }> = [];
    const events: XyzAtlasReadyEvent[] = [];
    const source = provider({
      minZoom: 4,
      maxZoom: 4,
      loadTile: async (_z, x, y) => {
        calls.push({ x, y });
        return bitmap(`${x}/${y}`);
      },
    });
    const globe = new XyzTileGlobe(1, source, {
      schedulerOptions: { concurrency: 1 },
      onAtlasReady: (event) => events.push(event),
    });
    globe.suspend();
    const camera = cameraAt(0, 0, 2);
    const target = cameraAt(45, 0, 1);
    const view = {
      cameraInGlobeSpace: camera,
      gazeDirectionInGlobeSpace: target.clone().sub(camera),
      verticalFovDegrees: 60,
      aspect: 1,
      altitude: 0.01,
      localSurface: {
        anchorLongitudeDegrees: 45,
        anchorLatitudeDegrees: 0,
        metersPerWorldUnit: 6_378_137,
      },
    };
    globe.update(view);
    expect(calls).toEqual([]);
    globe.resume();
    globe.update(view);

    await vi.waitFor(() =>
      expect(events.some((event) => event.layer === "focus")).toBe(true),
    );
    expect(calls[0].x).toBeGreaterThanOrEqual(9);
    const focus = events.find((event) => event.layer === "focus")!;
    expect(focus.localSurface).toBe(true);
    expect(globe.localGroup.parent).toBe(globe.group);
    expect(globe.localGroup.position.length()).toBeCloseTo(1, 5);
    expect(
      internalLayer(globe, "focusLayer").surface.geometry.index.count,
    ).toBeGreaterThan(0);
    globe.dispose();
  });

  it("does not publish late atlas work after disposal even when loaders ignore AbortSignal", async () => {
    const pending: Array<ReturnType<typeof deferred<ImageBitmap>>> = [];
    const source = provider({
      minZoom: 3,
      maxZoom: 3,
      loadTile: async () => {
        const request = deferred<ImageBitmap>();
        pending.push(request);
        return request.promise;
      },
    });
    const ready = vi.fn();
    const globe = new XyzTileGlobe(1, source, {
      schedulerOptions: { concurrency: 2 },
      onAtlasReady: ready,
    });
    globe.update(cameraAt(0, 0, 1.01), 60, 1);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    globe.dispose();
    const lateImages = pending.map((_, index) => bitmap(`late-${index}`));
    pending.forEach((request, index) => request.resolve(lateImages[index]));
    await vi.waitFor(() => {
      for (const image of lateImages)
        expect(image.close).toHaveBeenCalledOnce();
    });
    expect(ready).not.toHaveBeenCalled();
  });

  it("selects the best available local zoom outside a high-detail regional pack", async () => {
    const regionLoad = vi.fn(async () => bitmap("region"));
    const globalLoad = vi.fn(async () => bitmap("global"));
    const stitched = new CompositeXyzTileProvider({
      id: "mixed-lod",
      providers: [
        provider({
          id: "region",
          minZoom: 4,
          maxZoom: 4,
          bounds: [0, -20, 90, 20],
          loadTile: regionLoad,
        }),
        provider({
          id: "global",
          minZoom: 2,
          maxZoom: 2,
          loadTile: globalLoad,
        }),
      ],
    });
    const events: XyzAtlasReadyEvent[] = [];
    const globe = new XyzTileGlobe(1, stitched, {
      onAtlasReady: (event) => events.push(event),
    });
    globe.update(cameraAt(-90, 0, 1.01), 60, 1);
    await vi.waitFor(() =>
      expect(events.some((event) => event.layer === "base")).toBe(true),
    );
    expect(events.find((event) => event.layer === "base")?.level).toBe(2);
    expect(regionLoad).not.toHaveBeenCalled();
    expect(globalLoad).toHaveBeenCalled();
    globe.dispose();
  });
});

function provider(overrides: Partial<XyzTileProvider> = {}): XyzTileProvider {
  return {
    id: "globe-test",
    attribution: "Test data",
    minZoom: 0,
    maxZoom: 4,
    loadTile: async () => bitmap("default"),
    ...overrides,
  };
}

function cameraAt(
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

function bitmap(label: string) {
  return {
    label,
    width: 256,
    height: 256,
    close: vi.fn(),
  } as unknown as ImageBitmap & {
    label: string;
    close: ReturnType<typeof vi.fn>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function internalLayer(globe: XyzTileGlobe, name: "baseLayer" | "focusLayer") {
  return (
    globe as unknown as Record<
      string,
      {
        displayedKey: string;
        surface: { geometry: { index: { count: number } } };
      }
    >
  )[name];
}

class FakeCanvas {
  width = 300;
  height = 150;
  readonly context = {
    fillStyle: "",
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };

  getContext(kind: string) {
    return kind === "2d" ? this.context : null;
  }
}

function installCanvasDocument(): void {
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`Unexpected test element: ${tag}`);
      return new FakeCanvas();
    },
  });
}
