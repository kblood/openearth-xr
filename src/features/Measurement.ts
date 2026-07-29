import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  LabelStyle,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium';
import { greatCircleDistanceMeters } from '../core/Geo';

export interface MeasurementChangeDetail {
  readonly active: boolean;
  readonly distanceMeters: number;
  readonly points: number;
}

/** Interactive two-point surface measurement that owns only its temporary Cesium entities. */
export class MeasurementController extends EventTarget {
  private readonly handler: ScreenSpaceEventHandler;
  private readonly entities: Entity[] = [];
  private readonly positions: Cartesian3[] = [];
  private active = false;

  constructor(private readonly viewer: Viewer) {
    super();
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction(this.handleClick, ScreenSpaceEventType.LEFT_CLICK);
  }

  get enabled(): boolean { return this.active; }

  enable(): void {
    this.active = true;
    this.clear();
    this.dispatch(0);
  }

  disable(): void {
    this.active = false;
    this.clear();
    this.dispatch(0);
  }

  toggle(): boolean {
    if (this.active) this.disable();
    else this.enable();
    return this.active;
  }

  clear(): void {
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    this.entities.length = 0;
    this.positions.length = 0;
    this.viewer.scene.requestRender();
  }

  destroy(): void {
    this.clear();
    if (!this.handler.isDestroyed()) this.handler.destroy();
  }

  private readonly handleClick = (movement: { position: Cartesian2 }): void => {
    if (!this.active) return;
    const ray = this.viewer.camera.getPickRay(movement.position);
    if (!ray) return;
    const position = this.viewer.scene.globe.pick(ray, this.viewer.scene);
    if (!position) return;
    if (this.positions.length >= 2) this.clear();
    this.positions.push(position);
    this.entities.push(this.viewer.entities.add({
      position,
      point: { pixelSize: 10, color: Color.fromCssColorString('#7bd7ff'), outlineColor: Color.WHITE, outlineWidth: 2 },
    }));
    let distance = 0;
    if (this.positions.length === 2) {
      const [leftCartesian, rightCartesian] = this.positions;
      const left = Cartographic.fromCartesian(leftCartesian);
      const right = Cartographic.fromCartesian(rightCartesian);
      distance = greatCircleDistanceMeters(
        { longitude: CesiumMath.toDegrees(left.longitude), latitude: CesiumMath.toDegrees(left.latitude) },
        { longitude: CesiumMath.toDegrees(right.longitude), latitude: CesiumMath.toDegrees(right.latitude) },
      );
      this.entities.push(this.viewer.entities.add({
        polyline: { positions: [...this.positions], width: 4, material: Color.fromCssColorString('#7bd7ff') },
      }));
      const midpoint = Cartesian3.add(leftCartesian, rightCartesian, new Cartesian3());
      if (Cartesian3.magnitudeSquared(midpoint) < 1) Cartesian3.clone(leftCartesian, midpoint);
      const labelRadius = (Cartesian3.magnitude(leftCartesian) + Cartesian3.magnitude(rightCartesian)) / 2 + 50;
      Cartesian3.normalize(midpoint, midpoint);
      Cartesian3.multiplyByScalar(midpoint, labelRadius, midpoint);
      this.entities.push(this.viewer.entities.add({
        position: midpoint,
        label: {
          text: formatDistance(distance),
          font: '600 16px system-ui',
          fillColor: Color.WHITE,
          showBackground: true,
          backgroundColor: Color.fromCssColorString('#07111fdd'),
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -10),
        },
      }));
    }
    this.viewer.scene.requestRender();
    this.dispatch(distance);
  };

  private dispatch(distanceMeters: number): void {
    this.dispatchEvent(new CustomEvent<MeasurementChangeDetail>('change', {
      detail: { active: this.active, distanceMeters, points: this.positions.length },
    }));
  }
}

export function formatDistance(distanceMeters: number): string {
  if (distanceMeters >= 100_000) return `${Math.round(distanceMeters / 1_000).toLocaleString()} km`;
  if (distanceMeters >= 1_000) return `${(distanceMeters / 1_000).toFixed(distanceMeters >= 10_000 ? 1 : 2)} km`;
  return `${Math.round(distanceMeters).toLocaleString()} m`;
}
