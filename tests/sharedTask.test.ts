import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinSharedTask, SharedTask } from '../server/sharedTask';

function deferredTask() {
  let resolve!: (value: string) => void;
  const controller = new AbortController();
  const task: SharedTask<string> = { controller, waiters: 0, promise: new Promise<string>((r) => { resolve = r; }) };
  return { task, resolve, controller };
}

test('a waiter that leaves does not cancel the work for the others', async () => {
  const { task, resolve, controller } = deferredTask();
  const first = new AbortController();
  const firstWait = joinSharedTask(task, first.signal);
  const secondWait = joinSharedTask(task, new AbortController().signal);

  first.abort();
  await assert.rejects(firstWait, { name: 'AbortError' });
  assert.equal(controller.signal.aborted, false);

  resolve('profile');
  assert.equal(await secondWait, 'profile');
});

test('the shared work is aborted once every waiter has left', async () => {
  const { task, controller } = deferredTask();
  const a = new AbortController();
  const b = new AbortController();
  const waits = [joinSharedTask(task, a.signal), joinSharedTask(task, b.signal)];
  a.abort();
  b.abort();
  await Promise.allSettled(waits);
  assert.equal(controller.signal.aborted, true);
});
