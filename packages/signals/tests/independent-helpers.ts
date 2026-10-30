import { afterEach } from "vitest";
import { createRenderEffect, createRoot, flush } from "../src/index.js";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  flush();
});

export function root<T>(fn: () => T): T {
  return createRoot(dispose => {
    disposers.push(dispose);
    return fn();
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  flush();
}

// A host task drains the runtime's own scheduled microtasks. Do not add a
// flush here: these tests also protect automatic scheduling.
export const task = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function render<T>(read: () => T): T[] {
  const values: T[] = [];
  createRenderEffect(read, value => {
    values.push(value);
  });
  return values;
}
