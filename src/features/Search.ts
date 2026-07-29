import { normalizeView, type GeodeticView } from '../core/Geo';

export interface SearchResult {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly view: GeodeticView;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]>;
}

export class CompositeSearchProvider implements SearchProvider {
  readonly id = 'composite';
  constructor(private readonly providers: readonly SearchProvider[]) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    const groups = await Promise.allSettled(this.providers.map((provider) => provider.search(query, signal)));
    if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    const seen = new Set<string>();
    return groups.flatMap((group) => group.status === 'fulfilled' ? group.value : [])
      .filter((result) => {
        const key = `${result.label.toLocaleLowerCase()}|${result.view.longitude.toFixed(4)}|${result.view.latitude.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
}

export class StaticSearchProvider implements SearchProvider {
  readonly id = 'built-in';
  constructor(private readonly places: readonly SearchResult[] = DEFAULT_PLACES) {}

  async search(query: string): Promise<readonly SearchResult[]> {
    const coordinates = parseCoordinates(query);
    if (coordinates) return [{
      id: `coordinates:${coordinates.latitude},${coordinates.longitude}`,
      label: `${coordinates.latitude.toFixed(5)}, ${coordinates.longitude.toFixed(5)}`,
      description: 'Coordinates',
      view: { ...coordinates, height: 5_000, pitch: -Math.PI / 2 },
    }];
    const tokens = normalizeSearch(query).split(' ').filter(Boolean);
    if (tokens.length === 0) return [];
    return this.places
      .map((place) => ({ place, haystack: normalizeSearch(`${place.label} ${place.description ?? ''}`) }))
      .filter(({ haystack }) => tokens.every((token) => haystack.includes(token)))
      .sort((left, right) => score(right.haystack, tokens) - score(left.haystack, tokens))
      .slice(0, 8)
      .map(({ place }) => place);
  }
}

/** Optional user-initiated online geocoder. It is never used unless a host opts in. */
export class NominatimSearchProvider implements SearchProvider {
  readonly id = 'nominatim';
  private readonly cache = new Map<string, readonly SearchResult[]>();
  private requestGate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  constructor(
    private readonly endpoint = 'https://nominatim.openstreetmap.org/search',
    private readonly language = 'en,da',
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];
    const cached = this.cache.get(normalizedQuery);
    if (cached) return cached;
    // Serialize callers as well as delaying them: concurrent consumers of a
    // shared provider must not accidentally burst above OSMF's one-per-second
    // public-service limit.
    const reservation = this.requestGate.then(async () => {
      if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
      const wait = Math.max(0, 1_000 - (Date.now() - this.lastRequestAt));
      if (wait > 0) await abortableDelay(wait, signal);
      this.lastRequestAt = Date.now();
    });
    this.requestGate = reservation.catch(() => undefined);
    await reservation;
    const url = new URL(this.endpoint);
    url.searchParams.set('q', query.trim());
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '6');
    url.searchParams.set('addressdetails', '1');
    const response = await this.fetcher(url, {
      signal,
      mode: 'cors',
      headers: { Accept: 'application/json', 'Accept-Language': this.language },
    });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new TypeError('Search returned an invalid response');
    const results = payload.slice(0, 20).flatMap((value: unknown, index: number) => {
      if (!value || typeof value !== 'object') return [];
      const entry = value as Record<string, unknown>;
      const longitude = Number(entry.lon);
      const latitude = Number(entry.lat);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
      const type = typeof entry.type === 'string' ? entry.type : '';
      return [{
        id: String(entry.place_id ?? `${longitude}/${latitude}/${index}`),
        label: String(entry.display_name ?? `${latitude}, ${longitude}`),
        description: type,
        view: normalizeView({ longitude, latitude, height: heightForType(type), pitch: -Math.PI / 2 }),
      }];
    });
    this.cache.set(normalizedQuery, results);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value ?? '');
    return results;
  }
}

export const DEFAULT_PLACES: readonly SearchResult[] = [
  place('copenhagen', 'Copenhagen · København', 'Denmark · Danmark', 12.5683, 55.6761, 5_000),
  place('aarhus', 'Aarhus', 'Denmark · Danmark', 10.2039, 56.1629, 5_000),
  place('odense', 'Odense', 'Denmark · Danmark', 10.4024, 55.4038, 5_000),
  place('aalborg', 'Aalborg', 'Denmark · Danmark', 9.9217, 57.0488, 5_000),
  place('billund', 'Billund', 'Denmark · Danmark', 9.1518, 55.7284, 5_000),
  place('skagen', 'Skagen', 'Denmark · Danmark', 10.5839, 57.7209, 5_000),
  place('bornholm', 'Bornholm', 'Denmark · Danmark', 14.9167, 55.1667, 45_000),
  place('nuuk', 'Nuuk · Godthåb', 'Greenland · Kalaallit Nunaat', -51.7216, 64.1835, 8_000),
  place('torshavn', 'Tórshavn', 'Faroe Islands · Færøerne', -6.7716, 62.0079, 8_000),
  place('london', 'London', 'United Kingdom', -0.1276, 51.5072, 8_000),
  place('paris', 'Paris', 'France', 2.3522, 48.8566, 8_000),
  place('new-york', 'New York City', 'United States', -74.006, 40.7128, 12_000),
  place('tokyo', 'Tokyo', 'Japan', 139.6917, 35.6895, 12_000),
  place('sydney', 'Sydney', 'Australia', 151.2093, -33.8688, 12_000),
  place('cape-town', 'Cape Town', 'South Africa', 18.4241, -33.9249, 12_000),
];

export function parseCoordinates(query: string): Pick<GeodeticView, 'longitude' | 'latitude'> | null {
  const match = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  // The common search convention is latitude, longitude.
  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) return { latitude: first, longitude: second };
  if (Math.abs(first) <= 180 && Math.abs(second) <= 90) return { longitude: first, latitude: second };
  return null;
}

function place(id: string, label: string, description: string, longitude: number, latitude: number, height: number): SearchResult {
  return { id, label, description, view: { longitude, latitude, height, pitch: -Math.PI / 2 } };
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().trim();
}

function score(haystack: string, tokens: readonly string[]): number {
  return tokens.reduce((total, token) => total + (haystack.startsWith(token) ? 3 : 1), 0);
}

function heightForType(type: string): number {
  if (/house|building|address/.test(type)) return 500;
  if (/city|town|village/.test(type)) return 5_000;
  return 25_000;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Search cancelled', 'AbortError'));
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Search cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
