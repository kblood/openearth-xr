/** WGS84 semi-major axis used by Cesium and Web-Mercator providers. */
export const EARTH_RADIUS_METERS = 6_378_137;
export const MAX_MERCATOR_LATITUDE = 85.05112878;

export interface GeodeticView {
  /** Longitude in degrees. */
  readonly longitude: number;
  /** Latitude in degrees. */
  readonly latitude: number;
  /** Height above the ellipsoid in metres. */
  readonly height: number;
  /** Heading in radians, clockwise from north. */
  readonly heading?: number;
  /** Pitch in radians. */
  readonly pitch?: number;
  /** Roll in radians. */
  readonly roll?: number;
}

export interface UnitDirection {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function normalizeView(view: GeodeticView): GeodeticView {
  if (![view.longitude, view.latitude, view.height].every(Number.isFinite)) {
    throw new TypeError('Longitude, latitude, and height must be finite numbers');
  }
  return {
    longitude: wrapLongitude(view.longitude),
    latitude: clamp(view.latitude, -90, 90),
    height: Math.max(0, view.height),
    heading: wrapRadians(finiteOr(view.heading, 0)),
    pitch: clamp(finiteOr(view.pitch, -Math.PI / 2), -Math.PI / 2, Math.PI / 2),
    roll: wrapRadians(finiteOr(view.roll, 0)),
  };
}

/** Direction matching Three.js SphereGeometry and OpenEarth's east-toward--Z convention. */
export function geodeticDirection(longitudeDegrees: number, latitudeDegrees: number): UnitDirection {
  const longitude = degreesToRadians(wrapLongitude(longitudeDegrees));
  const latitude = degreesToRadians(clamp(latitudeDegrees, -90, 90));
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.cos(longitude),
    y: Math.sin(latitude),
    z: -cosLatitude * Math.sin(longitude),
  };
}

export function directionGeodetic(direction: UnitDirection): Pick<GeodeticView, 'longitude' | 'latitude'> {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new TypeError('Direction must have a non-zero finite length');
  }
  return {
    longitude: wrapLongitude(radiansToDegrees(Math.atan2(-direction.z, direction.x))),
    latitude: radiansToDegrees(Math.asin(clamp(direction.y / length, -1, 1))),
  };
}

export function metresToGlobeUnits(metres: number, globeRadius: number): number {
  return metres / EARTH_RADIUS_METERS * globeRadius;
}

export function globeUnitsToMetres(units: number, globeRadius: number): number {
  return units / globeRadius * EARTH_RADIUS_METERS;
}

export function greatCircleDistanceMeters(
  left: Pick<GeodeticView, 'longitude' | 'latitude'>,
  right: Pick<GeodeticView, 'longitude' | 'latitude'>,
): number {
  const latitude1 = degreesToRadians(left.latitude);
  const latitude2 = degreesToRadians(right.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = degreesToRadians(wrapLongitude(right.longitude - left.longitude));
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function wrapLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function wrapRadians(radians: number): number {
  return ((radians + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

export function degreesToRadians(degrees: number): number { return degrees * Math.PI / 180; }
export function radiansToDegrees(radians: number): number { return radians * 180 / Math.PI; }

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
