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

/** Re-reads every cached load: mounted ones now, the rest when next opened, even inside the dedupe window. */
export function invalidateLoads(): void {
  void mutate(() => true);
}

/** Empties every cached load. It revalidates so SWR also drops its dedupe markers, which would otherwise bring an earlier answer back. */
export function clearLoads(): void {
  generation += 1;
  failures.clear();
  retries.forEach((retry) => clearTimeout(retry));
  retries.clear();
  void mutate(() => true, undefined, { revalidate: true });
}
