import { mutate } from "swr";

const failures = new Map<string, number>();

/** Counts one more failed read of `url` in its current retry chain. */
export function countFailure(url: string): number {
  const attempt = (failures.get(url) ?? 0) + 1;
  failures.set(url, attempt);
  return attempt;
}

export function endRetryChain(url: string): void {
  failures.delete(url);
}

/** Re-reads every cached load: mounted ones now, the rest when next opened, even inside the dedupe window. */
export function invalidateLoads(): void {
  void mutate(() => true);
}

/** Empties every cached load. It revalidates so SWR also drops its dedupe markers, which would otherwise bring an earlier answer back. */
export function clearLoads(): void {
  failures.clear();
  void mutate(() => true, undefined, { revalidate: true });
}
