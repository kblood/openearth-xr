import { describe, expect, it } from 'vitest';
import { createXrAtmosphere, createXrStarField, disposeXrStarField } from '../src/xr/XrSky';

describe('XR sky rendering', () => {
  it('creates a deterministic bounded star field', () => {
    const left = createXrStarField({ count: 12, innerRadius: 10, outerRadius: 12, seed: 42 });
    const right = createXrStarField({ count: 12, innerRadius: 10, outerRadius: 12, seed: 42 });
    const positions = left.geometry.getAttribute('position');
    expect(positions.count).toBe(12);
    expect(Array.from(positions.array)).toEqual(Array.from(right.geometry.getAttribute('position').array));
    for (let index = 0; index < positions.count; index += 1) {
      const radius = Math.hypot(positions.getX(index), positions.getY(index), positions.getZ(index));
      expect(radius).toBeGreaterThanOrEqual(9.999);
      expect(radius).toBeLessThanOrEqual(12.001);
    }
    disposeXrStarField(left);
    disposeXrStarField(right);
  });

  it('creates a slightly enlarged transparent atmosphere shell', () => {
    const atmosphere = createXrAtmosphere(2);
    expect(atmosphere.geometry.parameters.radius).toBeCloseTo(2.036);
    expect(atmosphere.material.transparent).toBe(true);
    expect(atmosphere.material.depthWrite).toBe(false);
    atmosphere.geometry.dispose();
    atmosphere.material.dispose();
  });
});
