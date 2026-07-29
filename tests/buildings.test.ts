import { describe, expect, it } from 'vitest';
import vtPbf from 'vt-pbf';
import { decodeMvtBuildingTile, type BuildingFootprint } from '../src/buildings/BuildingProvider';
import { createBuildingGeometry } from '../src/buildings/XrBuildingLayer';

describe('MVT building decoding', () => {
  it('preserves footprint holes and OpenMapTiles extrusion fields', () => {
    const bytes = vtPbf.fromGeojsonVt({
      building: {
        features: [{
          id: 42,
          type: 3,
          tags: { render_height: 24, render_min_height: 3, colour: 'aabbcc' },
          geometry: [
            [[500, 500], [3500, 500], [3500, 3500], [500, 3500], [500, 500]],
            [[1400, 1400], [1400, 2600], [2600, 2600], [2600, 1400], [1400, 1400]],
          ],
        }],
      },
    }, { extent: 4096, version: 2 });

    const [building] = decodeMvtBuildingTile(bytes, 14, 8_764, 5_125);
    expect(building.rings).toHaveLength(2);
    expect(building.heightMeters).toBe(24);
    expect(building.minHeightMeters).toBe(3);
    expect(building.color).toBe('aabbcc');
  });

  it('filters outlines and applies a safe default height', () => {
    const bytes = vtPbf.fromGeojsonVt({
      building: {
        features: [
          polygonFeature({ hide_3d: true, render_height: 80 }),
          polygonFeature({}),
        ],
      },
    }, { extent: 4096, version: 2 });

    const buildings = decodeMvtBuildingTile(bytes, 14, 0, 0);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].heightMeters).toBe(9);
  });
});

describe('XR building geometry', () => {
  it('creates roofs and walls on the globe without flattening the footprint', () => {
    const footprint: BuildingFootprint = {
      rings: [[
        [12.56, 55.67],
        [12.561, 55.67],
        [12.561, 55.671],
        [12.56, 55.671],
        [12.56, 55.67],
      ]],
      minHeightMeters: 0,
      heightMeters: 18,
    };
    const geometry = createBuildingGeometry([footprint], 1.45);

    expect(geometry).not.toBeNull();
    expect(geometry!.getAttribute('position').count).toBeGreaterThan(8);
    expect(geometry!.index!.count).toBeGreaterThan(12);
    expect(geometry!.boundingSphere!.radius).toBeGreaterThan(0);
    geometry!.dispose();
  });
});

function polygonFeature(tags: Record<string, string | number | boolean>) {
  return {
    type: 3,
    tags,
    geometry: [[[500, 500], [3500, 500], [3500, 3500], [500, 3500], [500, 500]]],
  };
}
