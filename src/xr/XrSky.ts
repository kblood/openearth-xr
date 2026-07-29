import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  FrontSide,
  Mesh,
  Points,
  PointsMaterial,
  ShaderMaterial,
  SphereGeometry,
  type ColorRepresentation,
} from 'three';

export interface XrStarFieldOptions {
  readonly count?: number;
  readonly innerRadius?: number;
  readonly outerRadius?: number;
  readonly seed?: number;
  readonly color?: ColorRepresentation;
}

/** A deterministic, allocation-free-at-runtime sky that works in both XR eyes. */
export function createXrStarField(options: XrStarFieldOptions = {}): Points<BufferGeometry, PointsMaterial> {
  const count = Math.max(0, Math.min(4_000, Math.floor(options.count ?? 1_100)));
  const innerRadius = Math.max(1, options.innerRadius ?? 28);
  const outerRadius = Math.max(innerRadius, options.outerRadius ?? 38);
  const positions = new Float32Array(count * 3);
  let state = (options.seed ?? 0x51f15e) >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let index = 0; index < count; index += 1) {
    const y = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radius = innerRadius + random() * (outerRadius - innerRadius);
    const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
    const offset = index * 3;
    positions[offset] = Math.cos(angle) * horizontal * radius;
    positions[offset + 1] = y * radius;
    positions[offset + 2] = Math.sin(angle) * horizontal * radius;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: options.color ?? 0xdceeff,
    size: 0.032,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  const stars = new Points(geometry, material);
  stars.name = 'OpenEarth stars';
  stars.frustumCulled = false;
  stars.renderOrder = -100;
  return stars;
}

/** Lightweight Fresnel shell used only at orbital/aircraft altitude. */
export function createXrAtmosphere(
  earthRadius: number,
  color: ColorRepresentation = 0x57bfff,
): Mesh<SphereGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    uniforms: {
      glowColor: { value: new Color(color) },
      glowStrength: { value: 1 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float glowStrength;
      varying vec3 vNormal;
      varying vec3 vViewDirection;
      void main() {
        float rim = pow(1.0 - clamp(dot(vNormal, vViewDirection), 0.0, 1.0), 2.35);
        gl_FragColor = vec4(glowColor, rim * 0.52 * glowStrength);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    blending: AdditiveBlending,
  });
  const atmosphere = new Mesh(new SphereGeometry(earthRadius * 1.018, 96, 64), material);
  atmosphere.name = 'OpenEarth atmosphere';
  atmosphere.renderOrder = 20;
  return atmosphere;
}

export function disposeXrStarField(stars: Points<BufferGeometry, PointsMaterial>): void {
  stars.removeFromParent();
  stars.geometry.dispose();
  stars.material.dispose();
}
