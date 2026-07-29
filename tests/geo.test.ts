import { describe, expect, it } from 'vitest';
import {
  directionGeodetic,
  geodeticDirection,
  greatCircleDistanceMeters,
  normalizeView,
  wrapLongitude,
} from '../src/core/Geo';

describe('geodetic helpers', () => {
  it('round-trips globe directions without mirroring longitude', () => {
    for (const [longitude, latitude] of [[12.5683, 55.6761], [-74.006, 40.7128], [139.6917, 35.6895]]) {
      const result = directionGeodetic(geodeticDirection(longitude, latitude));
      expect(result.longitude).toBeCloseTo(longitude, 8);
      expect(result.latitude).toBeCloseTo(latitude, 8);
    }
  });

  it('normalizes externally supplied views', () => {
    expect(normalizeView({ longitude: 370, latitude: 100, height: -5 })).toMatchObject({
      longitude: 10,
      latitude: 90,
      height: 0,
    });
    expect(() => normalizeView({ longitude: Number.NaN, latitude: 0, height: 1 })).toThrow(TypeError);
    expect(normalizeView({ longitude: 0, latitude: 0, height: 1, heading: Math.PI * 3, pitch: 10, roll: -Math.PI * 3 })).toMatchObject({
      heading: -Math.PI,
      pitch: Math.PI / 2,
      roll: -Math.PI,
    });
  });

  it('computes realistic great-circle distances', () => {
    const copenhagenToAarhus = greatCircleDistanceMeters(
      { longitude: 12.5683, latitude: 55.6761 },
      { longitude: 10.2039, latitude: 56.1629 },
    );
    expect(copenhagenToAarhus).toBeGreaterThan(150_000);
    expect(copenhagenToAarhus).toBeLessThan(165_000);
    expect(wrapLongitude(-181)).toBe(179);
  });
});
