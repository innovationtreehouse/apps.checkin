import { KindedError } from "@checkin/component-kit";

/** An outside call that had not answered by its deadline. */
export class DeadlineError extends KindedError {
  constructor(what: string) {
    super("system", `${what} did not answer before its deadline`);
  }
}

/**
 * Settles as `call` does, or rejects with DeadlineError at `deadline` (epoch ms), whichever is first.
 * Past the deadline `call` is never started. A call that loses runs on unobserved: its result is dropped.
 * An infinite deadline sets no timer.
 */
export function byDeadline<T>(deadline: number, what: string, call: () => Promise<T>): Promise<T> {
  if (deadline === Infinity) return call();
  if (Date.now() >= deadline) return Promise.reject(new DeadlineError(what));
  const pending = call();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(what)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
}
