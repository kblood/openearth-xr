import { describe, expect, it } from 'vitest';
import { BookmarkStore } from '../src/features/Bookmarks';
import { NominatimSearchProvider, StaticSearchProvider, parseCoordinates } from '../src/features/Search';
import { formatDistance } from '../src/features/Measurement';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('standalone application features', () => {
  it('stores and restores normalized bookmarks', () => {
    const store = new BookmarkStore(new MemoryStorage());
    const bookmark = store.add('Home', { longitude: 372, latitude: 55.6, height: 100 });
    expect(bookmark.view.longitude).toBe(12);
    expect(store.list()).toHaveLength(1);
    expect(store.remove(bookmark.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('finds bilingual built-in places and coordinates', async () => {
    const provider = new StaticSearchProvider();
    expect((await provider.search('København'))[0]?.id).toBe('copenhagen');
    expect((await provider.search('danmark')).length).toBeGreaterThan(3);
    expect(parseCoordinates('55.6761, 12.5683')).toEqual({ latitude: 55.6761, longitude: 12.5683 });
  });

  it('formats measurement scale readably', () => {
    expect(formatDistance(812)).toBe('812 m');
    expect(formatDistance(1_250)).toBe('1.25 km');
  });

  it('caches explicit Nominatim searches and validates their response', async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify([{
        place_id: 12,
        display_name: 'København, Danmark',
        lat: '55.6761',
        lon: '12.5683',
        type: 'city',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = new NominatimSearchProvider('https://example.test/search', 'da,en', fetcher as typeof fetch);
    const result = (await provider.search('København'))[0];
    expect(result?.view.latitude).toBeCloseTo(55.6761, 8);
    expect(result?.view.longitude).toBeCloseTo(12.5683, 8);
    expect(await provider.search(' København ')).toHaveLength(1);
    expect(calls).toBe(1);

    const invalid = new NominatimSearchProvider(
      'https://example.test/search',
      'en',
      (async () => new Response('{}', { status: 200 })) as typeof fetch,
    );
    await expect(invalid.search('somewhere')).rejects.toThrow('invalid response');
  });
});
