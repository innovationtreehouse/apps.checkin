// Keeps every QuickBooks request in the process inside Intuit's limits (500 a minute, 10 a second per company).

/** Intuit's guidance on a 429 when no Retry-After is sent. */
const THROTTLE_PAUSE_MS = 60_000;
const MAX_RETRY_AFTER_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A token bucket (`perSecond`, holding at most that many), a cap on requests in flight, and one
 * pause every request waits out after a 429. Requests take their turn in arrival order.
 */
export class Pacer {
  private readonly perSecond: number;
  private readonly maxInFlight: number;
  private tokens: number;
  private refilledAt = Date.now();
  private inFlight = 0;
  private pausedUntil = 0;
  private freed: (() => void) | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  private countDay = "";
  private count = 0;

  /** Defaults to 5 a second and 4 in flight, half and less of Intuit's limits. */
  constructor({ perSecond = 5, maxInFlight = 4 }: { perSecond?: number; maxInFlight?: number } = {}) {
    this.perSecond = perSecond;
    this.maxInFlight = maxInFlight;
    this.tokens = perSecond;
  }

  /** Waits for this request's turn; call the returned function once the request is done. */
  acquire(): Promise<() => void> {
    const mine = this.turn.then(() => this.take());
    this.turn = mine.catch(() => {});
    return mine;
  }

  /** Starts (or extends) the shared pause after a 429, and answers when requests resume. */
  throttle(retryAfter: string | null): Date {
    const seconds = Number(retryAfter);
    const ms = retryAfter !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : THROTTLE_PAUSE_MS;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    return new Date(this.pausedUntil);
  }

  /** When the throttle pause ends; null when none is in force. */
  pauseEnds(): Date | null {
    return this.pausedUntil > Date.now() ? new Date(this.pausedUntil) : null;
  }

  /** Requests started so far this UTC day. */
  requestsToday(): number {
    return this.countDay === new Date().toISOString().slice(0, 10) ? this.count : 0;
  }

  private async take(): Promise<() => void> {
    for (;;) {
      // Only the request at the head of the line waits here, so one waiter slot is enough.
      while (this.inFlight >= this.maxInFlight) await new Promise<void>((r) => (this.freed = r));
      const now = Date.now();
      this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.refilledAt) * this.perSecond) / 1000);
      this.refilledAt = now;
      const wait = Math.max(this.pausedUntil - now, this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.perSecond));
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.tokens--;
    this.inFlight++;
    this.tally();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight--;
      const wake = this.freed;
      this.freed = null;
      wake?.();
    };
  }

  /** Logs the previous UTC day's request count at the first request of a new day, for Intuit's monthly allowance. */
  private tally(): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.countDay) {
      // ponytail: per process and logged only when the next day's first request comes; move to a DB counter if the monthly allowance gets tight.
      if (this.countDay) console.info("[quickbooks] requests per day", { day: this.countDay, requests: this.count });
      this.countDay = day;
      this.count = 0;
    }
    this.count++;
  }
}

/** One pacer per process, outside the client, because the host rebuilds the client every 60 seconds. */
export const qbPacer = new Pacer();
