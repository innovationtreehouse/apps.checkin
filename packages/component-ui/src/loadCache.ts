import { mutate } from "swr";

const failures = new Map<string, number>();
const retries = new Map<string, ReturnType<typeof setTimeout>>();
let generation = 0;

/** Counts `clearLoads` calls, so rows kept outside the cache end with the person they were read for. */
export function loadGeneration(): number {
  return generation;
}

/** Counts one more failed read of `url` in its current retry chain. */
export function countFailure(url: string): number {
  const attempt = (failures.get(url) ?? 0) + 1;
  failures.set(url, attempt);
  return attempt;
}

/** Forgets the count of a key no page is reading, so its next open starts afresh. A pending retry stays for any other reader. */
export function forgetFailures(url: string): void {
  failures.delete(url);
}

export function endRetryChain(url: string): void {
  failures.delete(url);
  clearTimeout(retries.get(url));
  retries.delete(url);
}

/** A key has one pending retry at most, so a read started by a write can't begin a second chain. */
export function scheduleRetry(url: string, delayMs: number, retry: () => void): void {
  clearTimeout(retries.get(url));
  retries.set(url, setTimeout(retry, delayMs));
}

const stamps = new Map<string, number>();
const stampListeners = new Map<string, Set<() => void>>();

/** Records that `key` just answered with a body, whichever reader asked. */
export function stampAnswer(key: string): void {
  stamps.set(key, Date.now());
  stampListeners.get(key)?.forEach((listener) => listener());
}

/** When `key` last answered with a body, in epoch milliseconds; null before its first. */
export function answeredAt(key: string): number | null {
  return stamps.get(key) ?? null;
}

export function subscribeAnswers(key: string, listener: () => void): () => void {
  const listeners = stampListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  stampListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stampListeners.delete(key);
  };
}

const held = new Map<string, number>();

/** Keeps `invalidateLoads` off `url` until the returned release runs; holds on one key stack. */
export function holdFromInvalidation(url: string): () => void {
  held.set(url, (held.get(url) ?? 0) + 1);
  return () => {
    const left = (held.get(url) ?? 1) - 1;
    if (left > 0) held.set(url, left);
    else held.delete(url);
  };
}

/** Re-reads every cached load not held: mounted ones now, the rest when next opened, even inside the dedupe window. */
export function invalidateLoads(): void {
  void mutate((key) => typeof key !== "string" || !held.has(key));
}

/** Empties every cached load. It revalidates so SWR also drops its dedupe markers, which would otherwise bring an earlier answer back. */
export function clearLoads(): void {
  generation += 1;
  failures.clear();
  stamps.clear();
  stampListeners.forEach((listeners) => listeners.forEach((listener) => listener()));
  retries.forEach((retry) => clearTimeout(retry));
  retries.clear();
  void mutate(() => true, undefined, { revalidate: true });
}
