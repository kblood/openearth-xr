import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompositeXyzTileProvider,
  createGlobalOverviewTexture,
  validateXyzTileProvider,
  type XyzTileProvider,
} from "../src/xr/XyzTileGlobe";
import { XyzTileScheduler } from "../src/xr/XyzTileScheduler";

describe("XYZ provider validation and routing", () => {
  it("rejects malformed and unsafe zoom ranges", () => {
    expect(() => validateXyzTileProvider(provider({ minZoom: -1 }))).toThrow(
      /minZoom/,
    );
    expect(() =>
      validateXyzTileProvider(provider({ minZoom: 5, maxZoom: 4 })),
    ).toThrow(/greater/);
    expect(() => validateXyzTileProvider(provider({ maxZoom: 31 }))).toThrow(
      /maxZoom/,
    );
    expect(() =>
      validateXyzTileProvider({
        id: "empty",
        attribution: "",
        minZoom: 0,
        maxZoom: 1,
      }),
    ).toThrow(/url or loadTile/);
    expect(() =>
      validateXyzTileProvider(provider({ bounds: [-181, 0, 10, 20] })),
    ).toThrow(/bounds/);
  });

  it("routes stitched regional packs before a global fallback", async () => {
    const regionLoad = vi.fn(async () => ({ status: "missing" as const }));
    const globalLoad = vi.fn(async () => bitmap("global"));
    const region = provider({
      id: "region",
      minZoom: 2,
      maxZoom: 2,
      bounds: [0, 0, 20, 60],
      loadTile: regionLoad,
    });
    const global = provider({
      id: "global",
      minZoom: 2,
      maxZoom: 2,
      loadTile: globalLoad,
    });
    const composite = new CompositeXyzTileProvider({
      id: "stitched",
      providers: [region, global],
    });

    const inside = await composite.loadTile(2, 2, 1);
    expect(regionLoad).toHaveBeenCalledOnce();
    expect(globalLoad).toHaveBeenCalledOnce();
    expect(inside.status).toBe("loaded");

    regionLoad.mockClear();
    globalLoad.mockClear();
    const outside = await composite.loadTile(2, 0, 1);
    expect(regionLoad).not.toHaveBeenCalled();
    expect(globalLoad).toHaveBeenCalledOnce();
    expect(outside.status).toBe("loaded");
    if (inside.status === "loaded") inside.image.close();
    if (outside.status === "loaded") outside.image.close();
  });

  it("does not hide a regional provider error unless explicitly configured", async () => {
    const broken = provider({
      id: "broken",
      loadTile: async () => ({ status: "error", error: new Error("offline") }),
    });
    const fallbackLoad = vi.fn(async () => bitmap("fallback"));
    const fallback = provider({ id: "fallback", loadTile: fallbackLoad });
    const strict = new CompositeXyzTileProvider({
      id: "strict",
      providers: [broken, fallback],
    });
    expect((await strict.loadTile(1, 0, 0)).status).toBe("error");
    expect(fallbackLoad).not.toHaveBeenCalled();

    const tolerant = new CompositeXyzTileProvider({
      id: "tolerant",
      providers: [broken, fallback],
      fallbackOnError: true,
    });
    const result = await tolerant.loadTile(1, 0, 0);
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") result.image.close();
  });
});

describe("bounded XYZ scheduling and caching", () => {
  it("deduplicates in-flight requests and closes its transferred bitmap on disposal", async () => {
    const image = bitmap("shared");
    const loadTile = vi.fn(async () => image);
    const scheduler = new XyzTileScheduler();
    const source = provider({ loadTile });
    const [left, right] = await Promise.all([
      scheduler.request(source, 1, 0, 0),
      scheduler.request(source, 1, 0, 0),
    ]);
    expect(loadTile).toHaveBeenCalledOnce();
    expect(left.status).toBe("loaded");
    expect(right.status).toBe("loaded");
    if (left.status === "loaded") left.lease.release();
    if (right.status === "loaded") right.lease.release();
    scheduler.dispose();
    expect(image.close).toHaveBeenCalledOnce();
  });

  it("bounds concurrency and starts queued work by priority", async () => {
    let active = 0;
    let maximum = 0;
    const order: number[] = [];
    const source = provider({
      maxZoom: 3,
      loadTile: async (_z, x) => {
        active += 1;
        maximum = Math.max(maximum, active);
        order.push(x);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active -= 1;
        return bitmap(String(x));
      },
    });
    const scheduler = new XyzTileScheduler({ concurrency: 2 });
    scheduler.suspend();
    const requests = [
      scheduler.request(source, 3, 0, 0, { priority: 1 }),
      scheduler.request(source, 3, 1, 0, { priority: 50 }),
      scheduler.request(source, 3, 2, 0, { priority: 10 }),
      scheduler.request(source, 3, 3, 0, { priority: 5 }),
    ];
    expect(order).toEqual([]);
    scheduler.resume();
    const results = await Promise.all(requests);
    expect(maximum).toBe(2);
    expect(order.slice(0, 2)).toEqual([1, 2]);
    for (const result of results)
      if (result.status === "loaded") result.lease.release();
    scheduler.dispose();
  });

  it("uses LRU eviction and reloads an evicted tile", async () => {
    const images: ReturnType<typeof bitmap>[] = [];
    const loadTile = vi.fn(async (_z: number, x: number) => {
      const image = bitmap(String(x));
      images.push(image);
      return image;
    });
    const scheduler = new XyzTileScheduler({ concurrency: 1, maxEntries: 2 });
    const source = provider({ maxZoom: 2, loadTile });
    for (const x of [0, 1, 2]) {
      const result = await scheduler.request(source, 2, x, 0);
      if (result.status === "loaded") result.lease.release();
      await Promise.resolve();
    }
    expect(images[0].close).toHaveBeenCalledOnce();
    const reloaded = await scheduler.request(source, 2, 0, 0);
    if (reloaded.status === "loaded") reloaded.lease.release();
    expect(loadTile).toHaveBeenCalledTimes(4);
    scheduler.dispose();
  });

  it("negative-caches stable misses and applies error backoff", async () => {
    let now = 1_000;
    let mode: "missing" | "error" = "missing";
    const loadTile = vi.fn(async () =>
      mode === "missing"
        ? { status: "missing" as const }
        : { status: "error" as const, error: new Error("temporary") },
    );
    const events: string[] = [];
    const scheduler = new XyzTileScheduler({
      missingTtlMs: 100,
      errorBaseDelayMs: 20,
      errorMaxDelayMs: 100,
      now: () => now,
      onTileEvent: (event) => events.push(event.type),
    });
    const source = provider({ loadTile });
    expect((await scheduler.request(source, 1, 0, 0)).status).toBe("missing");
    expect((await scheduler.request(source, 1, 0, 0)).status).toBe("missing");
    expect(loadTile).toHaveBeenCalledOnce();
    now += 101;
    mode = "error";
    expect((await scheduler.request(source, 1, 0, 0)).status).toBe("error");
    expect((await scheduler.request(source, 1, 0, 0)).status).toBe("error");
    expect(loadTile).toHaveBeenCalledTimes(2);
    expect(events).toContain("retry-blocked");
    scheduler.dispose();
  });

  it("settles immediately on dispose and closes a late bitmap when a provider ignores abort", async () => {
    const pending = deferred<ReturnType<typeof bitmap>>();
    const source = provider({ loadTile: async () => pending.promise });
    const scheduler = new XyzTileScheduler();
    const request = scheduler.request(source, 1, 0, 0);
    await Promise.resolve();
    scheduler.dispose();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    const late = bitmap("late");
    pending.resolve(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
  });

  it("skips tiles excluded by provider coverage without invoking the loader", async () => {
    const loadTile = vi.fn(async () => bitmap("never"));
    const source = provider({
      minZoom: 2,
      maxZoom: 2,
      bounds: [0, 0, 20, 60],
      hasTile: (_z, x) => x === 2,
      loadTile,
    });
    const scheduler = new XyzTileScheduler();
    const result = await scheduler.request(source, 2, 0, 1);
    expect(result.status).toBe("missing");
    expect(loadTile).not.toHaveBeenCalled();
    scheduler.dispose();
  });
});

describe("safe orbital overview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a tiny fallback without touching a provider that starts above zoom four", async () => {
    installCanvasDocument();
    const loadTile = vi.fn(async () => bitmap("never"));
    const fallback = vi.fn();
    const texture = await createGlobalOverviewTexture(
      provider({
        minZoom: 13,
        maxZoom: 14,
        overviewFallbackColor: "#123456",
        loadTile,
      }),
      { onFallback: fallback },
    );
    expect(loadTile).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    expect((texture.image as unknown as FakeCanvas).width).toBe(16);
    texture.dispose();
  });

  it("uses an explicit low-resolution overview provider", async () => {
    installCanvasDocument();
    const localLoad = vi.fn(async () => bitmap("local"));
    const overviewImage = bitmap("overview");
    const overviewLoad = vi.fn(async () => overviewImage);
    const local = provider({ minZoom: 13, maxZoom: 14, loadTile: localLoad });
    const overview = provider({
      id: "overview",
      minZoom: 0,
      maxZoom: 2,
      loadTile: overviewLoad,
    });
    const texture = await createGlobalOverviewTexture(local, {
      zoom: 0,
      overviewProvider: overview,
    });
    expect(localLoad).not.toHaveBeenCalled();
    expect(overviewLoad).toHaveBeenCalledWith(0, 0, 0, expect.any(AbortSignal));
    expect(overviewImage.close).toHaveBeenCalledOnce();
    texture.dispose();
  });
});

function provider(overrides: Partial<XyzTileProvider> = {}): XyzTileProvider {
  return {
    id: "test",
    attribution: "Test data",
    minZoom: 0,
    maxZoom: 2,
    loadTile: async () => bitmap("default"),
    ...overrides,
  };
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
