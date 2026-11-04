/**
 * A tiny typed event bus used for cross-plugin communication.
 *
 * The two plugins must be usable independently: when Context OS is not
 * installed, Time Machine still works, and vice versa. A duck-typed bus is
 * therefore better than a hard service dependency — a subscriber list is a
 * plain object with `on`/`emit`, so a consumer can also attach to any object
 * that exposes the same two methods.
 *
 * Listener failures are contained: one throwing subscriber never breaks the
 * emitter, which matters because a broken consumer must not abort a restore.
 *
 * @module @harness-ext/shared/events
 */

/** A subscriber callback. */
export type BusListener<T> = (payload: T) => void;

/** Minimal public shape of a typed bus. */
export interface TypedBusLike<M> {
  on<K extends keyof M>(type: K, listener: BusListener<M[K]>): () => void;
  emit<K extends keyof M>(type: K, payload: M[K]): void;
}

/** One bus for one event map. */
export class TypedBus<M> implements TypedBusLike<M> {
  private readonly listeners = new Map<keyof M, Set<BusListener<never>>>();

  /** Subscribe; returns the unsubscribe function. */
  on<K extends keyof M>(type: K, listener: BusListener<M[K]>): () => void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as BusListener<never>);
    return () => {
      set?.delete(listener as BusListener<never>);
    };
  }

  /** Emit to every subscriber; listener errors are reported, not propagated. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.listeners.get(type);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        (listener as unknown as BusListener<M[K]>)(payload);
      } catch (error) {
        // A consumer must never be able to break the producer's operation.
        console.warn(`harness-ext: event listener for "${String(type)}" threw:`, error);
      }
    }
  }

  /** Drop every subscriber (plugin disposal). */
  clear(): void {
    this.listeners.clear();
  }

  /** How many subscribers one event currently has. */
  count<K extends keyof M>(type: K): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
