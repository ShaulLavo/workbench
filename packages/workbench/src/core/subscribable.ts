export interface Subscribable<T> {
  /**
   * Must return a referentially stable value when underlying state has not changed.
   * Returning a fresh object/array per call breaks React.useSyncExternalStore.
   */
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface WritableSubscribable<T> extends Subscribable<T> {
  set(next: T | ((previous: T) => T)): void;
}

/** Minimal framework-neutral reactive store compatible with React.useSyncExternalStore. */
export function createSubscribable<T>(
  initial: T,
  equals: (a: T, b: T) => boolean = Object.is,
): WritableSubscribable<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (equals(value, resolved)) return;
      value = resolved;
      for (const listener of listeners) listener();
    },
  };
}

/** Memoized derived subscribable that only emits when `equals(prev, next)` is false. */
export function createDerivedSubscribable<TInput, TOutput>(
  source: Subscribable<TInput>,
  project: (input: TInput) => TOutput,
  equals: (a: TOutput, b: TOutput) => boolean = Object.is,
): Subscribable<TOutput> {
  let lastInput = source.getSnapshot();
  let lastOutput = project(lastInput);

  const recompute = (): TOutput => {
    const currentInput = source.getSnapshot();
    if (Object.is(currentInput, lastInput)) return lastOutput;
    lastInput = currentInput;
    const candidate = project(currentInput);
    if (!equals(lastOutput, candidate)) lastOutput = candidate;
    return lastOutput;
  };

  return {
    getSnapshot: recompute,
    subscribe(listener) {
      return source.subscribe(() => {
        const previous = lastOutput;
        const next = recompute();
        if (!equals(previous, next)) listener();
      });
    },
  };
}
