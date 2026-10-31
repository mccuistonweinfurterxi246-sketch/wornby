export interface SharedTask<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

// Waits on a task shared by identical requests. A waiter leaving early only rejects its own call;
// the shared work is aborted once the last waiter has left.
export function joinSharedTask<T>(task: SharedTask<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  task.waiters++;
  return new Promise<T>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      signal?.removeEventListener('abort', onAbort);
      if (--task.waiters === 0) task.controller.abort();
    };
    const onAbort = () => {
      leave();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    task.promise.then(
      (value) => { leave(); resolve(value); },
      (error) => { leave(); reject(error); },
    );
  });
}
