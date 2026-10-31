import { BalatroLoop, BalatroSceneProps, FrameScheduler, startBalatro } from './balatroScene';

// Renders the background off the main thread, so its frames no longer wait for page rendering work.

export type BalatroWorkerMessage =
  | { type: 'init'; canvas: OffscreenCanvas; props: BalatroSceneProps; width: number; height: number; active: boolean }
  | { type: 'resize'; width: number; height: number }
  | { type: 'mouse'; x: number; y: number }
  | { type: 'active'; active: boolean }
  | { type: 'dispose' };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<BalatroWorkerMessage>) => void) | null;
  postMessage(message: { type: 'failed' }): void;
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

// Dedicated workers have requestAnimationFrame in Chrome and Firefox; other engines get a timer at the same rate.
const frames: FrameScheduler = scope.requestAnimationFrame && scope.cancelAnimationFrame
  ? { request: (cb) => scope.requestAnimationFrame!(cb), cancel: (id) => scope.cancelAnimationFrame!(id) }
  : { request: (cb) => setTimeout(() => cb(performance.now()), 1000 / 60) as unknown as number, cancel: (id) => clearTimeout(id) };

let loop: BalatroLoop | null = null;

scope.onmessage = ({ data }) => {
  if (data.type === 'init') {
    loop = startBalatro(data.canvas, data.props, data.width, data.height, frames, data.active);
    if (!loop) scope.postMessage({ type: 'failed' });
  } else if (data.type === 'resize') loop?.resize(data.width, data.height);
  else if (data.type === 'mouse') loop?.setMouse(data.x, data.y);
  else if (data.type === 'active') loop?.setActive(data.active);
  else if (data.type === 'dispose') { loop?.dispose(); loop = null; }
};
