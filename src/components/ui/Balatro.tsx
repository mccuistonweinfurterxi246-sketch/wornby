import React, { useEffect, useRef } from 'react';
import { BalatroLoop, BalatroSceneProps, startBalatro } from './balatroScene';
import type { BalatroWorkerMessage } from './balatro.worker';

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

const supportsOffscreen = typeof window !== 'undefined'
  && typeof Worker !== 'undefined'
  && typeof HTMLCanvasElement !== 'undefined'
  && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  return canvas;
}

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
    const props: BalatroSceneProps = { spinRotation, spinSpeed, offset, color1, color2, color3, contrast, lighting, spinAmount, pixelFilter, spinEase, isRotate };
    const reduceMotionQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    let reduceMotion = !!reduceMotionQuery?.matches;
    let inView = true;
    const isActive = () => !reduceMotion && inView && document.visibilityState === 'visible';
    const size = () => ({ width: container.clientWidth || container.offsetWidth, height: container.clientHeight || container.offsetHeight });

    let canvas = createCanvas();
    container.appendChild(canvas);
    let worker: Worker | null = null;
    let loop: BalatroLoop | null = null;
    const send = (message: BalatroWorkerMessage) => worker?.postMessage(message);

    // The shader renders in a worker on an OffscreenCanvas: on the main thread every background frame had to
    // wait for page rendering, so it dropped to ~40fps with uneven pacing whenever the page was busy.
    const startOnMainThread = () => {
      if (worker) {
        worker.terminate();
        worker = null;
        // a transferred canvas cannot get a main-thread context any more
        canvas.remove();
        canvas = createCanvas();
        container.appendChild(canvas);
      }
      const { width, height } = size();
      loop = startBalatro(canvas, props, width, height, { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) }, isActive());
    };
    if (supportsOffscreen) {
      try {
        worker = new Worker(new URL('./balatro.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ type: string }>) => { if (event.data?.type === 'failed') startOnMainThread(); };
        worker.onerror = () => startOnMainThread();
        const offscreen = canvas.transferControlToOffscreen();
        const { width, height } = size();
        worker.postMessage({ type: 'init', canvas: offscreen, props, width, height, active: isActive() } satisfies BalatroWorkerMessage, [offscreen]);
      } catch {
        startOnMainThread();
      }
    } else {
      startOnMainThread();
    }

    const syncActive = () => {
      const active = isActive();
      loop?.setActive(active);
      send({ type: 'active', active });
    };
    const onReduceChange = (e: MediaQueryListEvent) => { reduceMotion = e.matches; syncActive(); };
    reduceMotionQuery?.addEventListener?.('change', onReduceChange);

    function resize() {
      const { width, height } = size();
      if (width === 0 || height === 0) return;
      loop?.resize(width, height);
      send({ type: 'resize', width, height });
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(container);
    window.addEventListener('resize', resize, { passive: true } as AddEventListenerOptions);
    // visibility: pause rendering when the tab is hidden or the container is offscreen
    document.addEventListener('visibilitychange', syncActive);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      inView = entries[0]?.isIntersecting ?? true;
      syncActive();
    }, { threshold: 0 }) : null;
    io?.observe(container);

    function handleMouseMove(e: MouseEvent) {
      if (!mouseInteraction) return;
      const rect = container.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = 1.0 - (e.clientY - rect.top) / rect.height;
      loop?.setMouse(x, y);
      send({ type: 'mouse', x, y });
    }
    container.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('resize', resize);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', syncActive);
      reduceMotionQuery?.removeEventListener?.('change', onReduceChange);
      container.removeEventListener('mousemove', handleMouseMove);
      send({ type: 'dispose' });
      worker?.terminate();
      loop?.dispose();
      canvas.remove();
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
