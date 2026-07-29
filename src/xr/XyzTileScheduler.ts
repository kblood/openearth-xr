import {
  loadXyzProviderTile,
  validateXyzTileProvider,
  type XyzTileErrorResult,
  type XyzTileEvent,
  type XyzTileEventListener,
  type XyzTileProvider,
  type XyzTileResult,
} from "./XyzTileProvider";
import {
  XyzTileCache,
  type XyzTileCacheOptions,
  type XyzTileLease,
} from "./XyzTileCache";

export interface XyzTileSchedulerOptions extends XyzTileCacheOptions {
  readonly concurrency?: number;
  readonly cache?: XyzTileCache;
  readonly onTileEvent?: XyzTileEventListener;
}

export interface XyzTileRequestOptions {
  /** Larger values start first. Equal priorities remain FIFO. */
  readonly priority?: number;
  readonly signal?: AbortSignal;
}

export type XyzScheduledTileResult =
  | {
      readonly status: "loaded";
      readonly lease: XyzTileLease;
      readonly fromCache: boolean;
    }
  | { readonly status: "missing"; readonly retryAt: number }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retryAt: number;
    };

type WorkOutcome =
  | { readonly status: "loaded" }
  | { readonly status: "missing"; readonly retryAt: number }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retryAt: number;
    }
  | { readonly status: "cancelled" };

type Work = {
  readonly key: string;
  readonly provider: XyzTileProvider;
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly order: number;
  readonly controller: AbortController;
  readonly promise: Promise<WorkOutcome>;
  readonly resolve: (outcome: WorkOutcome) => void;
  priority: number;
  consumers: number;
  started: boolean;
  settled: boolean;
  cancelled: boolean;
};

/** Shared bounded queue for raster fetch, deduplication, retry and image ownership. */
export class XyzTileScheduler {
  readonly concurrency: number;
  readonly cache: XyzTileCache;
  private readonly onTileEvent?: XyzTileEventListener;
  private readonly providerTokens = new WeakMap<object, number>();
  private readonly validatedProviders = new WeakSet<object>();
  private readonly workByKey = new Map<string, Work>();
  private readonly queue: Work[] = [];
  private providerSequence = 0;
  private workSequence = 0;
  private activeCount = 0;
  private suspended = false;
  private disposed = false;

  constructor(options: XyzTileSchedulerOptions = {}) {
    this.concurrency = positiveInteger(
      options.concurrency ?? 6,
      "scheduler concurrency",
    );
    this.cache =
      options.cache ??
      new XyzTileCache({
        maxEntries: Math.max(this.concurrency, options.maxEntries ?? 192),
        missingTtlMs: options.missingTtlMs,
        errorBaseDelayMs: options.errorBaseDelayMs,
        errorMaxDelayMs: options.errorMaxDelayMs,
        now: options.now,
      });
    this.onTileEvent = options.onTileEvent;
  }

  get active(): number {
    return this.activeCount;
  }
  get pending(): number {
    return this.queue.length;
  }
  get isSuspended(): boolean {
    return this.suspended;
  }

  async request(
    provider: XyzTileProvider,
    z: number,
    x: number,
    y: number,
    options: XyzTileRequestOptions = {},
  ): Promise<XyzScheduledTileResult> {
    this.assertAvailable();
    this.validateOnce(provider);
    validateCoordinate(z, x, y);
    if (options.signal?.aborted) throw abortError();
    const key = this.keyFor(provider, z, x, y);
    const cached = this.cache.acquire(key);
    if (cached) {
      this.emit({
        type: "cache-hit",
        providerId: provider.id,
        z,
        x,
        y,
        fromCache: true,
      });
      return { status: "loaded", lease: cached, fromCache: true };
    }
    const blocked = this.cache.blocked(key);
    if (blocked) {
      this.emit({
        type: "retry-blocked",
        providerId: provider.id,
        z,
        x,
        y,
        error: blocked.error,
        retryAt: blocked.retryAt,
      });
      return blocked.status === "missing"
        ? { status: "missing", retryAt: blocked.retryAt }
        : { status: "error", error: blocked.error, retryAt: blocked.retryAt };
    }

    let work = this.workByKey.get(key);
    if (!work) {
      work = this.createWork(
        key,
        provider,
        z,
        x,
        y,
        finitePriority(options.priority),
      );
      this.workByKey.set(key, work);
      this.queue.push(work);
      this.emit({ type: "queued", providerId: provider.id, z, x, y });
    } else if (!work.started) {
      work.priority = Math.max(work.priority, finitePriority(options.priority));
    }
    work.consumers += 1;
    this.sortQueue();
    this.pump();
    return this.consume(work, options.signal);
  }

  suspend(): void {
    if (this.disposed) return;
    this.suspended = true;
  }

  resume(): void {
    this.assertAvailable();
    if (!this.suspended) return;
    this.suspended = false;
    this.pump();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const work of this.workByKey.values()) {
      work.cancelled = true;
      work.controller.abort();
      if (!work.settled) {
        work.settled = true;
        work.resolve({ status: "cancelled" });
      }
    }
    this.queue.length = 0;
    this.workByKey.clear();
    this.cache.dispose();
  }

  private createWork(
    key: string,
    provider: XyzTileProvider,
    z: number,
    x: number,
    y: number,
    priority: number,
  ): Work {
    let resolve!: (outcome: WorkOutcome) => void;
    const promise = new Promise<WorkOutcome>((complete) => {
      resolve = complete;
    });
    return {
      key,
      provider,
      z,
      x,
      y,
      priority,
      order: this.workSequence++,
      controller: new AbortController(),
      promise,
      resolve,
      consumers: 0,
      started: false,
      settled: false,
      cancelled: false,
    };
  }

  private consume(
    work: Work,
    signal?: AbortSignal,
  ): Promise<XyzScheduledTileResult> {
    return new Promise<XyzScheduledTileResult>((resolve, reject) => {
      let finished = false;
      const detach = (cancelled: boolean): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        work.consumers = Math.max(0, work.consumers - 1);
        if (cancelled && work.consumers === 0 && !work.settled)
          this.cancelUnobserved(work);
      };
      const onAbort = (): void => {
        detach(true);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      work.promise.then(
        (outcome) => {
          if (finished) return;
          if (outcome.status === "cancelled" || this.disposed) {
            detach(false);
            reject(abortError());
            return;
          }
          if (outcome.status === "loaded") {
            const lease = this.cache.acquire(work.key);
            if (!lease) {
              detach(false);
              reject(
                new Error(
                  `Loaded XYZ tile '${work.key}' was evicted before use`,
                ),
              );
              return;
            }
            detach(false);
            resolve({ status: "loaded", lease, fromCache: false });
            return;
          }
          detach(false);
          resolve(outcome);
        },
        (error) => {
          if (finished) return;
          detach(false);
          reject(error);
        },
      );
    });
  }

  private cancelUnobserved(work: Work): void {
    work.cancelled = true;
    work.controller.abort();
    this.emit({
      type: "cancelled",
      providerId: work.provider.id,
      z: work.z,
      x: work.x,
      y: work.y,
    });
    if (!work.started) {
      const index = this.queue.indexOf(work);
      if (index >= 0) this.queue.splice(index, 1);
      this.workByKey.delete(work.key);
      work.settled = true;
      work.resolve({ status: "cancelled" });
    }
  }

  private pump(): void {
    if (this.suspended || this.disposed) return;
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const work = this.queue.shift()!;
      if (work.cancelled) continue;
      work.started = true;
      this.activeCount += 1;
      void this.execute(work);
    }
  }

  private async execute(work: Work): Promise<void> {
    let result: XyzTileResult;
    try {
      result = await loadXyzProviderTile(
        work.provider,
        work.z,
        work.x,
        work.y,
        work.controller.signal,
      );
    } catch (error) {
      result = work.controller.signal.aborted
        ? { status: "error", error: abortError() }
        : { status: "error", error };
    }

    let outcome: WorkOutcome;
    let completionLease: XyzTileLease | null = null;
    if (this.disposed || work.cancelled || work.controller.signal.aborted) {
      if (result.status === "loaded") closeBitmap(result.image);
      outcome = { status: "cancelled" };
    } else if (result.status === "loaded") {
      completionLease = this.cache.putImage(work.key, result.image);
      // Keep the just-completed item pinned until promise consumers have had a
      // microtask turn to acquire their own leases.
      this.emit({
        type: "loaded",
        providerId: work.provider.id,
        z: work.z,
        x: work.x,
        y: work.y,
      });
      outcome = { status: "loaded" };
    } else if (result.status === "missing") {
      const negative = this.cache.putMissing(work.key, result);
      this.emit({
        type: "missing",
        providerId: work.provider.id,
        z: work.z,
        x: work.x,
        y: work.y,
        retryAt: negative.retryAt,
      });
      outcome = { status: "missing", retryAt: negative.retryAt };
    } else {
      const negative = this.cache.putError(
        work.key,
        result as XyzTileErrorResult,
      );
      this.emit({
        type: "error",
        providerId: work.provider.id,
        z: work.z,
        x: work.x,
        y: work.y,
        error: result.error,
        retryAt: negative.retryAt,
      });
      outcome = {
        status: "error",
        error: result.error,
        retryAt: negative.retryAt,
      };
    }

    work.settled = true;
    this.workByKey.delete(work.key);
    work.resolve(outcome);
    if (completionLease) queueMicrotask(() => completionLease?.release());
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.pump();
  }

  private sortQueue(): void {
    this.queue.sort(
      (left, right) =>
        right.priority - left.priority || left.order - right.order,
    );
  }

  private keyFor(
    provider: XyzTileProvider,
    z: number,
    x: number,
    y: number,
  ): string {
    let token = this.providerTokens.get(provider);
    if (token === undefined) {
      token = ++this.providerSequence;
      this.providerTokens.set(provider, token);
    }
    return `${token}/${z}/${x}/${y}`;
  }

  private validateOnce(provider: XyzTileProvider): void {
    if (this.validatedProviders.has(provider)) return;
    validateXyzTileProvider(provider);
    this.validatedProviders.add(provider);
  }

  private emit(event: XyzTileEvent): void {
    try {
      this.onTileEvent?.(event);
    } catch {
      /* Observers must not break streaming. */
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("XYZ tile scheduler has been disposed");
  }
}

function validateCoordinate(z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || z < 0 || z > 30)
    throw new RangeError("XYZ zoom must be an integer from 0 to 30");
  const count = 2 ** z;
  if (
    !Number.isInteger(x) ||
    x < 0 ||
    x >= count ||
    !Number.isInteger(y) ||
    y < 0 ||
    y >= count
  ) {
    throw new RangeError(`Invalid XYZ coordinate ${z}/${x}/${y}`);
  }
}

function finitePriority(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function closeBitmap(image: ImageBitmap): void {
  try {
    image.close();
  } catch {
    /* no-op */
  }
}

function abortError(): DOMException {
  return new DOMException("XYZ tile request cancelled", "AbortError");
}
