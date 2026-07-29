import type {
  XyzTileErrorResult,
  XyzTileMissingResult,
} from "./XyzTileProvider";

type PositiveEntry = {
  readonly kind: "image";
  readonly image: ImageBitmap;
  references: number;
  touched: number;
};

type NegativeEntry = {
  readonly kind: "negative";
  readonly status: "missing" | "error";
  readonly error?: unknown;
  readonly retryAt: number;
  readonly attempt: number;
  touched: number;
};

type CacheEntry = PositiveEntry | NegativeEntry;

export interface XyzTileLease {
  readonly image: ImageBitmap;
  /** Releases this use of the scheduler-owned bitmap. Never close it directly. */
  release(): void;
}

export interface XyzNegativeCacheHit {
  readonly status: "missing" | "error";
  readonly error?: unknown;
  readonly retryAt: number;
  readonly attempt: number;
}

export interface XyzTileCacheOptions {
  readonly maxEntries?: number;
  readonly missingTtlMs?: number;
  readonly errorBaseDelayMs?: number;
  readonly errorMaxDelayMs?: number;
  readonly now?: () => number;
}

/** LRU image cache with leases and bounded negative retry state. */
export class XyzTileCache {
  readonly maxEntries: number;
  readonly missingTtlMs: number;
  readonly errorBaseDelayMs: number;
  readonly errorMaxDelayMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private disposed = false;

  constructor(options: XyzTileCacheOptions = {}) {
    this.maxEntries = positiveInteger(
      options.maxEntries ?? 192,
      "cache maxEntries",
    );
    this.missingTtlMs = nonNegative(
      options.missingTtlMs ?? 60_000,
      "missingTtlMs",
    );
    this.errorBaseDelayMs = nonNegative(
      options.errorBaseDelayMs ?? 1_000,
      "errorBaseDelayMs",
    );
    this.errorMaxDelayMs = nonNegative(
      options.errorMaxDelayMs ?? 30_000,
      "errorMaxDelayMs",
    );
    if (this.errorMaxDelayMs < this.errorBaseDelayMs) {
      throw new RangeError(
        "errorMaxDelayMs must be greater than or equal to errorBaseDelayMs",
      );
    }
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  acquire(key: string): XyzTileLease | null {
    this.assertAvailable();
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== "image") return null;
    entry.references += 1;
    this.touch(key, entry);
    return this.createLease(entry);
  }

  /** Stores and pins a new bitmap until the returned completion lease releases. */
  putImage(key: string, image: ImageBitmap): XyzTileLease {
    if (this.disposed) {
      closeBitmap(image);
      throw new Error("XYZ tile cache has been disposed");
    }
    const previous = this.entries.get(key);
    if (previous?.kind === "image" && previous.references > 0) {
      closeBitmap(image);
      throw new Error(`Cannot replace leased XYZ tile '${key}'`);
    }
    if (previous?.kind === "image" && previous.image !== image)
      closeBitmap(previous.image);
    this.entries.delete(key);
    const entry: PositiveEntry = {
      kind: "image",
      image,
      references: 1,
      touched: this.now(),
    };
    this.entries.set(key, entry);
    this.evict();
    return this.createLease(entry);
  }

  private createLease(entry: PositiveEntry): XyzTileLease {
    let released = false;
    return {
      image: entry.image,
      release: () => {
        if (released) return;
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        if (!this.disposed) this.evict();
      },
    };
  }

  blocked(key: string): XyzNegativeCacheHit | null {
    this.assertAvailable();
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== "negative") return null;
    this.touch(key, entry);
    if (entry.retryAt <= this.now()) return null;
    return {
      status: entry.status,
      error: entry.error,
      retryAt: entry.retryAt,
      attempt: entry.attempt,
    };
  }

  putMissing(key: string, result: XyzTileMissingResult): XyzNegativeCacheHit {
    const delay = result.retryAfterMs ?? this.missingTtlMs;
    return this.putNegative(key, "missing", undefined, delay, 0);
  }

  putError(key: string, result: XyzTileErrorResult): XyzNegativeCacheHit {
    const previous = this.entries.get(key);
    const attempt =
      previous?.kind === "negative" && previous.status === "error"
        ? previous.attempt + 1
        : 1;
    const exponential = Math.min(
      this.errorMaxDelayMs,
      this.errorBaseDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    return this.putNegative(
      key,
      "error",
      result.error,
      result.retryAfterMs ?? exponential,
      attempt,
    );
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.kind === "image") closeBitmap(entry.image);
    this.entries.delete(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values())
      if (entry.kind === "image") closeBitmap(entry.image);
    this.entries.clear();
  }

  private putNegative(
    key: string,
    status: "missing" | "error",
    error: unknown,
    delayMs: number,
    attempt: number,
  ): XyzNegativeCacheHit {
    this.assertAvailable();
    const delay = Number.isFinite(delayMs)
      ? nonNegative(delayMs, "retry delay")
      : Number.POSITIVE_INFINITY;
    const previous = this.entries.get(key);
    if (previous?.kind === "image") closeBitmap(previous.image);
    const retryAt =
      delay === Number.POSITIVE_INFINITY ? delay : this.now() + delay;
    const entry: NegativeEntry = {
      kind: "negative",
      status,
      error,
      retryAt,
      attempt,
      touched: this.now(),
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();
    return { status, error, retryAt, attempt };
  }

  private touch(key: string, entry: CacheEntry): void {
    entry.touched = this.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.kind === "image" && entry.references > 0) continue;
      if (entry.kind === "image") closeBitmap(entry.image);
      this.entries.delete(key);
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("XYZ tile cache has been disposed");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative number`);
  return value;
}

function closeBitmap(image: ImageBitmap): void {
  try {
    image.close();
  } catch {
    /* A host implementation may already have released it. */
  }
}
