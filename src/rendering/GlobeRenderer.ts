const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() { uv = position; gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
uniform vec2 u_resolution;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_zoom;
const float PI = 3.14159265359;
vec3 rotateY(vec3 p, float a) { float c=cos(a), s=sin(a); return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z); }
vec3 rotateX(vec3 p, float a) { float c=cos(a), s=sin(a); return vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z); }
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
float terrain(vec2 p) { vec2 q=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hash(q),hash(q+vec2(1.,0.)),f.x),mix(hash(q+vec2(0.,1.)),hash(q+vec2(1.,1.)),f.x),f.y); }
void main() {
  vec2 p = (2.0*gl_FragCoord.xy-u_resolution.xy)/min(u_resolution.x,u_resolution.y);
  p /= u_zoom;
  float rr=dot(p,p);
  vec3 sky=mix(vec3(.01,.035,.09),vec3(.035,.12,.25),p.y+.5);
  if(rr>1.0){ outColor=vec4(sky,1.); return; }
  vec3 n=normalize(vec3(p,sqrt(1.0-rr)));
  n=rotateX(rotateY(n,u_yaw),u_pitch);
  float lon=atan(n.z,n.x), lat=asin(n.y);
  float land=terrain(vec2(lon*5.2,lat*8.5))+0.38*terrain(vec2(lon*13.,lat*20.));
  float coast=smoothstep(.54,.62,land + .08*sin(lon*2.0)*cos(lat*4.0));
  vec3 ocean=vec3(.015,.19,.34)*(0.7+0.3*n.y);
  vec3 ground=mix(ocean,vec3(.08,.31,.18)+.16*terrain(vec2(lon*25.,lat*30.)),coast);
  vec3 sun=normalize(vec3(-.5,.65,.7));
  float light=.28+.72*max(0.,dot(n,sun));
  float rim=pow(1.0-sqrt(1.0-rr),2.5);
  outColor=vec4(ground*light+vec3(.08,.24,.55)*rim,1.);
}`;

export class GlobeRenderer {
  readonly gl: WebGL2RenderingContext;
  xrSession: XRSession | null = null;
  private program: WebGLProgram;
  private yaw = -0.9;
  private pitch = 0.25;
  private zoom = 1;
  private dragging = false;
  private point = { x: 0, y: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, xrCompatible: true });
    if (!gl) throw new Error('WebGL 2 is required.');
    this.gl = gl;
    this.program = this.createProgram();
    this.bindControls();
  }

  start() { requestAnimationFrame(this.frame); }

  resetView() { this.yaw = -0.9; this.pitch = 0.25; this.zoom = 1; }

  async enterXR(session: XRSession) {
    this.xrSession = session;
    await this.gl.makeXRCompatible();
    const layer = new XRWebGLLayer(session, this.gl);
    session.updateRenderState({ baseLayer: layer });
    const space = await session.requestReferenceSpace('local');
    session.requestAnimationFrame((time, frame) => this.xrFrame(time, frame, space));
  }

  private frame = () => { if (!this.xrSession) this.draw(); requestAnimationFrame(this.frame); };
  private xrFrame = (_time: number, frame: XRFrame, space: XRReferenceSpace) => {
    if (!this.xrSession) return;
    const pose = frame.getViewerPose(space);
    const layer = this.xrSession.renderState.baseLayer;
    if (pose && layer) for (const view of pose.views) {
      const viewport = layer.getViewport(view); if (!viewport) continue;
      this.draw(viewport.x, viewport.y, viewport.width, viewport.height);
    }
    this.xrSession.requestAnimationFrame((time, nextFrame) => this.xrFrame(time, nextFrame, space));
  };

  private draw(x = 0, y = 0, width = this.canvas.width, height = this.canvas.height) {
    const { gl } = this;
    const scale = Math.min(devicePixelRatio, 2);
    if (!this.xrSession) {
      const w = Math.floor(this.canvas.clientWidth * scale), h = Math.floor(this.canvas.clientHeight * scale);
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      width = w; height = h;
    }
    gl.viewport(x, y, width, height); gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_resolution'), width, height);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_yaw'), this.yaw);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_pitch'), this.pitch);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_zoom'), this.zoom);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private createProgram() {
    const gl = this.gl, compile = (type: number, source: string) => { const shader=gl.createShader(type)!; gl.shaderSource(shader,source); gl.compileShader(shader); if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed'); return shader; };
    const program=gl.createProgram()!; gl.attachShader(program,compile(gl.VERTEX_SHADER,VERTEX)); gl.attachShader(program,compile(gl.FRAGMENT_SHADER,FRAGMENT)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed');
    const vertices = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, vertices); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    return program;
  }

  private bindControls() {
    this.canvas.addEventListener('pointerdown', (event) => { this.dragging = true; this.point = { x: event.clientX, y: event.clientY }; this.canvas.setPointerCapture(event.pointerId); });
    this.canvas.addEventListener('pointermove', (event) => { if (!this.dragging) return; this.yaw += (event.clientX-this.point.x)*.008; this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch+(event.clientY-this.point.y)*.008)); this.point={x:event.clientX,y:event.clientY}; });
    this.canvas.addEventListener('pointerup', () => { this.dragging = false; });
    this.canvas.addEventListener('wheel', (event) => { event.preventDefault(); this.zoom=Math.max(.55,Math.min(2.2,this.zoom-event.deltaY*.001)); }, { passive: false });
  }
}
