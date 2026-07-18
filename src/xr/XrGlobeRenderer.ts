const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
out vec4 color;
uniform mat4 u_projection;
uniform mat4 u_viewInverse;
uniform vec4 u_viewport;
uniform vec3 u_center;
uniform float u_radius;
uniform float u_yaw;
uniform sampler2D u_map;
const float PI = 3.14159265359;
void main() {
  vec2 clip = ((gl_FragCoord.xy - u_viewport.xy) / u_viewport.zw) * 2.0 - 1.0;
  vec3 rayEye = normalize(vec3(clip.x / u_projection[0][0], clip.y / u_projection[1][1], -1.0));
  vec3 origin = (u_viewInverse * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 ray = normalize((u_viewInverse * vec4(rayEye, 0.0)).xyz);
  vec3 oc = origin - u_center;
  float b = dot(oc, ray), c = dot(oc, oc) - u_radius * u_radius;
  float h = b*b-c;
  if (h < 0.0) { color = vec4(0.004, 0.009, 0.025, 1.0); return; }
  float t = -b - sqrt(h); if (t < 0.0) t = -b + sqrt(h);
  vec3 p = origin + ray * t;
  vec3 n = normalize(p - u_center);
  float lon = atan(n.z, n.x) + u_yaw;
  float lat = asin(n.y);
  vec2 uv = vec2(fract(lon / (2.0 * PI) + .5), .5 - lat / PI);
  vec3 map = texture(u_map, uv).rgb;
  vec3 sun = normalize(vec3(-.4, .7, .55));
  float light = .22 + .78 * max(0.0, dot(n, sun));
  color = vec4(map * light, 1.0);
}`;

/**
 * Minimal, real immersive WebXR globe renderer. It deliberately uses a
 * separate WebGL context from the desktop Cesium scene: CesiumJS does not yet
 * own a WebXR compositor loop. The controls mirror Google Earth VR's basic
 * model—look naturally, thumbstick/trackpad rotates and flies/scales, and
 * trigger recentres the planet at a comfortable orbital distance.
 */
export class XrGlobeRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private session: XRSession | null = null;
  private texture: WebGLTexture | null = null;
  private yaw = -0.8;
  private radius = 1.45;
  private center: [number, number, number] = [0, -0.15, -3.3];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async enter(onEnd: () => void): Promise<void> {
    const xr = navigator.xr;
    if (!xr) throw new Error('WebXR is unavailable');
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    const gl = this.canvas.getContext('webgl2', { xrCompatible: true });
    if (!gl) throw new Error('WebGL 2 is required for immersive view');
    this.gl = gl;
    await gl.makeXRCompatible();
    const layer = new XRWebGLLayer(session, gl);
    await session.updateRenderState({ baseLayer: layer });
    this.program = this.createProgram(gl);
    this.texture = await this.createMapTexture(gl);
    this.session = session;
    const space = await session.requestReferenceSpace('local-floor');
    session.addEventListener('select', () => this.reset(), { passive: true });
    session.addEventListener('end', () => { this.session = null; this.canvas.hidden = true; onEnd(); }, { once: true });
    this.canvas.hidden = false;
    session.requestAnimationFrame((time, frame) => this.frame(time, frame, space));
  }

  async exit(): Promise<void> { await this.session?.end(); }

  private frame(_time: number, frame: XRFrame, space: XRReferenceSpace): void {
    const session = this.session;
    const gl = this.gl;
    const program = this.program;
    const layer = session?.renderState.baseLayer;
    if (!session || !gl || !program || !layer) return;
    this.applyControllerInput(session);
    const pose = frame.getViewerPose(space);
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    if (pose) for (const view of pose.views) {
      const viewport = layer.getViewport(view); if (!viewport) continue;
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.useProgram(program);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_projection'), false, view.projectionMatrix);
      // XRView.transform maps the eye from view space into the reference
      // space, i.e. it is the view-inverse matrix needed for world rays.
      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_viewInverse'), false, view.transform.matrix);
      gl.uniform4f(gl.getUniformLocation(program, 'u_viewport'), viewport.x, viewport.y, viewport.width, viewport.height);
      gl.uniform3f(gl.getUniformLocation(program, 'u_center'), ...this.center);
      gl.uniform1f(gl.getUniformLocation(program, 'u_radius'), this.radius);
      gl.uniform1f(gl.getUniformLocation(program, 'u_yaw'), this.yaw);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(gl.getUniformLocation(program, 'u_map'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    session.requestAnimationFrame((time, next) => this.frame(time, next, space));
  }

  private applyControllerInput(session: XRSession): void {
    for (const source of session.inputSources) {
      const axes = source.gamepad?.axes;
      if (!axes || axes.length < 2) continue;
      const horizontal = axes[0] ?? 0;
      const vertical = axes[1] ?? 0;
      if (Math.abs(horizontal) > 0.08) this.yaw += horizontal * 0.025;
      if (Math.abs(vertical) > 0.08) this.radius = Math.min(5, Math.max(0.18, this.radius * (1 - vertical * 0.02)));
    }
  }

  private reset(): void { this.yaw = -0.8; this.radius = 1.45; this.center = [0, -0.15, -3.3]; }

  private createProgram(gl: WebGL2RenderingContext): WebGLProgram {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'XR shader compile failed');
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'XR shader link failed');
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    return program;
  }

  private async createMapTexture(gl: WebGL2RenderingContext): Promise<WebGLTexture> {
    const image = new Image(); image.crossOrigin = 'anonymous'; image.src = 'https://tile.openstreetmap.org/0/0/0.png';
    await image.decode();
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }
}
