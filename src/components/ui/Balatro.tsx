import { Renderer, Program, Mesh, Triangle } from 'ogl';
import React, { useEffect, useRef } from 'react';

interface BalatroProps {
  spinRotation?: number;
  spinSpeed?: number;
  offset?: [number, number];
  color1?: string;
  color2?: string;
  color3?: string;
  contrast?: number;
  lighting?: number;
  spinAmount?: number;
  pixelFilter?: number;
  spinEase?: number;
  isRotate?: boolean;
  mouseInteraction?: boolean;
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

const Balatro = React.memo(function Balatro({
  spinRotation = -2.0,
  spinSpeed = 7.0,
  offset = [0.0, 0.0] as [number, number],
  color1 = '#DE443B',
  color2 = '#006BB4',
  color3 = '#162325',
  contrast = 3.5,
  lighting = 0.4,
  spinAmount = 0.25,
  pixelFilter = 745.0,
  spinEase = 1.0,
  isRotate = false,
  mouseInteraction = true
}: BalatroProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const reduceMotionQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduceMotion = !!reduceMotionQuery?.matches;
    const onReduceChange = (e: MediaQueryListEvent) => { reduceMotion = e.matches; };
    reduceMotionQuery?.addEventListener?.('change', onReduceChange);

    // WebGL guard — low-power, dpr 1, no AA, чтобы не терять контекст на ноутах/VPN + много <img> с видео-памятью
    let renderer: Renderer;
    try {
      renderer = new Renderer({
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
      return;
    }
    const gl = renderer.gl;
    if (!gl) return;
    try { (gl as unknown as WebGLRenderingContext).clearColor(0, 0, 0, 1); } catch { return; }

    let program: Program;
    let destroyed = false;
    let isVisible = true;
    let lastFrameMs = 0;
    const TARGET_FPS = 60;
    const FRAME_BUDGET_MS = 1000 / TARGET_FPS;

    function resize() {
      if (destroyed) return;
      // render at 1x, CSS scales — 4x fewer fragments vs dpr=2, fixes 10fps on 1080p
      const w = container.clientWidth || container.offsetWidth;
      const h = container.clientHeight || container.offsetHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      (gl.canvas as HTMLCanvasElement).style.width = `100%`;
      (gl.canvas as HTMLCanvasElement).style.height = `100%`;
      (gl.canvas as HTMLCanvasElement).style.display = 'block';
      if (program) {
        program.uniforms.iResolution.value = [gl.drawingBufferWidth || w, gl.drawingBufferHeight || h, (gl.drawingBufferWidth || w) / (gl.drawingBufferHeight || h)];
      }
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(container);
    window.addEventListener('resize', resize, { passive: true } as AddEventListenerOptions);
    // visibility: pause when tab hidden or container offscreen
    const onVis = () => { isVisible = document.visibilityState === 'visible'; if (isVisible && !destroyed && !reduceMotion) animationFrameId = requestAnimationFrame(update); };
    document.addEventListener('visibilitychange', onVis);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      isVisible = entries[0]?.isIntersecting ?? true;
      if (isVisible && !destroyed && !reduceMotion) animationFrameId = requestAnimationFrame(update);
    }, { threshold: 0 }) : null;
    io?.observe(container);
    resize();

    const geometry = new Triangle(gl);
    program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        iTime: { value: 0 },
        iResolution: {
          value: [gl.canvas.width || container.clientWidth, gl.canvas.height || container.clientHeight, (gl.canvas.width || container.clientWidth) / (gl.canvas.height || 1)]
        },
        uSpinRotation: { value: spinRotation },
        uSpinSpeed: { value: spinSpeed },
        uOffset: { value: offset },
        uColor1: { value: hexToVec4(color1) },
        uColor2: { value: hexToVec4(color2) },
        uColor3: { value: hexToVec4(color3) },
        uContrast: { value: contrast },
        uLighting: { value: lighting },
        uSpinAmount: { value: spinAmount },
        uPixelFilter: { value: pixelFilter },
        uSpinEase: { value: spinEase },
        uIsRotate: { value: isRotate },
        uMouse: { value: [0.5, 0.5] }
      }
    });

    const mesh = new Mesh(gl, { geometry, program });
    let animationFrameId: number;

    let contextLost = false;
    function update(time: number) {
      if (destroyed || (gl as unknown as { isContextLost?: ()=>boolean }).isContextLost?.()) {
        contextLost = true;
        return;
      }
      animationFrameId = requestAnimationFrame(update);
      if (contextLost || reduceMotion || !isVisible || document.hidden) return;
      if (time - lastFrameMs < FRAME_BUDGET_MS - 1) return;
      lastFrameMs = time;
      program.uniforms.iTime.value = time * 0.001;
      try { renderer.render({ scene: mesh }); } catch {
        // если рендер упал — помечаем lost чтобы не спамить
        contextLost = true;
        cancelAnimationFrame(animationFrameId);
      }
    }
    // context loss — обязательно preventDefault иначе canvas не восстановится
    const onContextLost = (e: Event) => { e.preventDefault(); contextLost = true; cancelAnimationFrame(animationFrameId); console.warn('[Balatro] WebGL context lost — пауза'); };
    const onContextRestore = () => {
      contextLost = false;
      // на некоторых GPU нужно пересоздать size/resolution
      try { resize(); program.uniforms.iTime.value = performance.now()*0.001; } catch {}
      animationFrameId = requestAnimationFrame(update);
      console.warn('[Balatro] WebGL context restored');
    };
    (gl.canvas as HTMLCanvasElement).addEventListener('webglcontextlost', onContextLost as EventListener);
    (gl.canvas as HTMLCanvasElement).addEventListener('webglcontextrestored', onContextRestore as EventListener);
    animationFrameId = requestAnimationFrame(update);
    container.appendChild(gl.canvas as unknown as Node);

    function handleMouseMove(e: MouseEvent) {
      if (!mouseInteraction) return;
      const rect = container.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = 1.0 - (e.clientY - rect.top) / rect.height;
      program.uniforms.uMouse.value = [x, y];
    }
    container.addEventListener('mousemove', handleMouseMove);

    return () => {
      destroyed = true;
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      reduceMotionQuery?.removeEventListener?.('change', onReduceChange);
      container.removeEventListener('mousemove', handleMouseMove);
      (gl.canvas as HTMLCanvasElement).removeEventListener('webglcontextlost', onContextLost as EventListener);
      (gl.canvas as HTMLCanvasElement).removeEventListener('webglcontextrestored', onContextRestore as EventListener);
      try {
        if ((gl.canvas as HTMLCanvasElement).parentNode === container) container.removeChild(gl.canvas as unknown as Node);
      } catch { /* ignore */ }
      // не форсим loseContext если уже lost — иначе Chrome шлёт "context was lost" в консоль
      try {
        if (!(gl as unknown as { isContextLost?: ()=>boolean }).isContextLost?.()) {
          (gl.getExtension('WEBGL_lose_context') as unknown as { loseContext(): void })?.loseContext();
        }
      } catch { /* ignore */ }
    };
  }, [
    spinRotation,
    spinSpeed,
    color1,
    color2,
    color3,
    contrast,
    lighting,
    spinAmount,
    pixelFilter,
    spinEase,
    isRotate,
    mouseInteraction,
    offset[0],
    offset[1]
  ]);

  return <div ref={containerRef} className="w-full h-full" />;
});

export default Balatro;
