import { Renderer, Program, Mesh, Triangle } from 'ogl';

// Shared by the worker (OffscreenCanvas) and the main-thread fallback so both render identically.

export interface BalatroSceneProps {
  spinRotation: number;
  spinSpeed: number;
  offset: [number, number];
  color1: string;
  color2: string;
  color3: string;
  contrast: number;
  lighting: number;
  spinAmount: number;
  pixelFilter: number;
  spinEase: number;
  isRotate: boolean;
}

export interface BalatroLoop {
  resize(width: number, height: number): void;
  setMouse(x: number, y: number): void;
  setActive(active: boolean): void;
  dispose(): void;
}

export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

function hexToVec4(hex: string): [number, number, number, number] {
  let hexStr = hex.replace('#', '');
  let r = 0,
    g = 0,
    b = 0,
    a = 1;
  if (hexStr.length === 6) {
    r = parseInt(hexStr.slice(0, 2), 16) / 255;
    g = parseInt(hexStr.slice(2, 4), 16) / 255;
    b = parseInt(hexStr.slice(4, 6), 16) / 255;
  } else if (hexStr.length === 8) {
    r = parseInt(hexStr.slice(0, 2), 16) / 255;
    g = parseInt(hexStr.slice(2, 4), 16) / 255;
    b = parseInt(hexStr.slice(4, 6), 16) / 255;
    a = parseInt(hexStr.slice(6, 8), 16) / 255;
  }
  return [r, g, b, a];
}

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

#define PI 3.14159265359

uniform float iTime;
uniform vec3 iResolution;
uniform float uSpinRotation;
uniform float uSpinSpeed;
uniform vec2 uOffset;
uniform vec4 uColor1;
uniform vec4 uColor2;
uniform vec4 uColor3;
uniform float uContrast;
uniform float uLighting;
uniform float uSpinAmount;
uniform float uPixelFilter;
uniform float uSpinEase;
uniform bool uIsRotate;
uniform vec2 uMouse;

varying vec2 vUv;

vec4 effect(vec2 screenSize, vec2 screen_coords) {
    float pixel_size = length(screenSize.xy) / uPixelFilter;
    vec2 uv = (floor(screen_coords.xy * (1.0 / pixel_size)) * pixel_size - 0.5 * screenSize.xy) / length(screenSize.xy) - uOffset;
    float uv_len = length(uv);

    float speed = (uSpinRotation * uSpinEase * 0.2);
    if(uIsRotate){
       speed = iTime * speed;
    }
    speed += 302.2;

    float mouseInfluence = (uMouse.x * 2.0 - 1.0);
    speed += mouseInfluence * 0.1;

    float new_pixel_angle = atan(uv.y, uv.x) + speed - uSpinEase * 20.0 * (uSpinAmount * uv_len + (1.0 - uSpinAmount));
    vec2 mid = (screenSize.xy / length(screenSize.xy)) / 2.0;
    uv = (vec2(uv_len * cos(new_pixel_angle) + mid.x, uv_len * sin(new_pixel_angle) + mid.y) - mid);

    uv *= 30.0;
    float baseSpeed = iTime * uSpinSpeed;
    speed = baseSpeed + mouseInfluence * 2.0;

    vec2 uv2 = vec2(uv.x + uv.y);

    for(int i = 0; i < 5; i++) {
        uv2 += sin(max(uv.x, uv.y)) + uv;
        uv += 0.5 * vec2(
            cos(5.1123314 + 0.353 * uv2.y + speed * 0.131121),
            sin(uv2.x - 0.113 * speed)
        );
        uv -= cos(uv.x + uv.y) - sin(uv.x * 0.711 - uv.y);
    }

    float contrast_mod = (0.25 * uContrast + 0.5 * uSpinAmount + 1.2);
    float paint_res = min(2.0, max(0.0, length(uv) * 0.035 * contrast_mod));
    float c1p = max(0.0, 1.0 - contrast_mod * abs(1.0 - paint_res));
    float c2p = max(0.0, 1.0 - contrast_mod * abs(paint_res));
    float c3p = 1.0 - min(1.0, c1p + c2p);
    float light = (uLighting - 0.2) * max(c1p * 5.0 - 4.0, 0.0) + uLighting * max(c2p * 5.0 - 4.0, 0.0);

    return (0.3 / uContrast) * uColor1 + (1.0 - 0.3 / uContrast) * (uColor1 * c1p + uColor2 * c2p + vec4(c3p * uColor3.rgb, c3p * uColor1.a)) + light;
}

void main() {
    vec2 uv = vUv * iResolution.xy;
    gl_FragColor = effect(iResolution.xy, uv);
}
`;

const TARGET_FPS = 60;
const FRAME_BUDGET_MS = 1000 / TARGET_FPS;

// Starts the render loop on `canvas`; returns null when WebGL is unavailable.
export function startBalatro(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  props: BalatroSceneProps,
  width: number,
  height: number,
  frames: FrameScheduler,
  active: boolean,
): BalatroLoop | null {
  // WebGL guard — low-power, dpr 1, no AA, чтобы не терять контекст на ноутах/VPN + много <img> с видео-памятью
  let renderer: Renderer;
  try {
    renderer = new Renderer({
      canvas,
      antialias: false,
      dpr: 1,
      alpha: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    } as unknown as ConstructorParameters<typeof Renderer>[0]);
  } catch {
    return null;
  }
  const gl = renderer.gl;
  if (!gl) return null;
  try { (gl as unknown as WebGLRenderingContext).clearColor(0, 0, 0, 1); } catch { return null; }

  let destroyed = false;
  let isActive = active;
  let lastFrameMs = 0;
  let size = { w: width, h: height };

  const program = new Program(gl, {
    vertex: vertexShader,
    fragment: fragmentShader,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: [width, height, width / (height || 1)] },
      uSpinRotation: { value: props.spinRotation },
      uSpinSpeed: { value: props.spinSpeed },
      uOffset: { value: props.offset },
      uColor1: { value: hexToVec4(props.color1) },
      uColor2: { value: hexToVec4(props.color2) },
      uColor3: { value: hexToVec4(props.color3) },
      uContrast: { value: props.contrast },
      uLighting: { value: props.lighting },
      uSpinAmount: { value: props.spinAmount },
      uPixelFilter: { value: props.pixelFilter },
      uSpinEase: { value: props.spinEase },
      uIsRotate: { value: props.isRotate },
      uMouse: { value: [0.5, 0.5] },
    },
  });

  function resize(w: number, h: number) {
    if (destroyed || w === 0 || h === 0) return;
    size = { w, h };
    // render at 1x, CSS scales — 4x fewer fragments vs dpr=2, fixes 10fps on 1080p
    renderer.setSize(w, h);
    program.uniforms.iResolution.value = [gl.drawingBufferWidth || w, gl.drawingBufferHeight || h, (gl.drawingBufferWidth || w) / (gl.drawingBufferHeight || h)];
  }
  resize(width, height);

  const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });
  let frameId = 0;
  let contextLost = false;

  function update(time: number) {
    if (destroyed || (gl as unknown as { isContextLost?: () => boolean }).isContextLost?.()) {
      contextLost = true;
      return;
    }
    frameId = frames.request(update);
    if (contextLost || !isActive) return;
    if (time - lastFrameMs < FRAME_BUDGET_MS - 1) return;
    lastFrameMs = time;
    program.uniforms.iTime.value = time * 0.001;
    try { renderer.render({ scene: mesh }); } catch {
      // если рендер упал — помечаем lost чтобы не спамить
      contextLost = true;
      frames.cancel(frameId);
    }
  }
  // context loss — обязательно preventDefault иначе canvas не восстановится
  const onContextLost = (e: Event) => { e.preventDefault(); contextLost = true; frames.cancel(frameId); console.warn('[Balatro] WebGL context lost — пауза'); };
  const onContextRestore = () => {
    contextLost = false;
    // на некоторых GPU нужно пересоздать size/resolution
    try { resize(size.w, size.h); } catch {}
    frameId = frames.request(update);
    console.warn('[Balatro] WebGL context restored');
  };
  canvas.addEventListener('webglcontextlost', onContextLost as EventListener);
  canvas.addEventListener('webglcontextrestored', onContextRestore as EventListener);
  frameId = frames.request(update);

  return {
    resize,
    setMouse(x, y) { program.uniforms.uMouse.value = [x, y]; },
    setActive(next) { isActive = next; },
    dispose() {
      destroyed = true;
      frames.cancel(frameId);
      canvas.removeEventListener('webglcontextlost', onContextLost as EventListener);
      canvas.removeEventListener('webglcontextrestored', onContextRestore as EventListener);
      // не форсим loseContext если уже lost — иначе Chrome шлёт "context was lost" в консоль
      try {
        if (!(gl as unknown as { isContextLost?: () => boolean }).isContextLost?.()) {
          (gl.getExtension('WEBGL_lose_context') as unknown as { loseContext(): void })?.loseContext();
        }
      } catch { /* ignore */ }
    },
  };
}
