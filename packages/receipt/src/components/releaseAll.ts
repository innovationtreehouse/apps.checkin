import { HttpError, invalidateLoads } from "@checkin/component-ui";
import { api } from "./api";

export interface ReleaseOutcome {
  released: number;
  /** Already handled elsewhere (404, 409) or refused by the conflict rule (403). */
  skipped: number;
  /** The first other failure, which stops the run; null when every item was tried. */
  error: string | null;
  /** Items after the failed one, not tried because the run stopped. */
  notReached: number;
}

/** Statuses that skip one item: gone from the queue, claimed concurrently, or conflicted for this releaser. */
const SKIP = new Set([403, 404, 409]);

/** The run invalidates once at its end, so each release skips the re-read every write otherwise triggers. */
export const releaseOne = (id: number) =>
  api(`/mail-items/${id}/assign`, { method: "POST", body: JSON.stringify({ release: true }), invalidate: false });

/** Releases each item in turn, one request at a time, and stops at the first failure it cannot skip. */
export async function releaseAll(
  ids: number[],
  release: (id: number) => Promise<unknown>,
  onProgress: (tried: number) => void = () => {},
): Promise<ReleaseOutcome> {
  const out: ReleaseOutcome = { released: 0, skipped: 0, error: null, notReached: 0 };
  try {
    for (const [i, id] of ids.entries()) {
      try {
        await release(id);
        out.released++;
      } catch (err) {
        if (!(err instanceof HttpError && SKIP.has(err.status))) {
          return { ...out, error: err instanceof Error ? err.message : "Network error", notReached: ids.length - i - 1 };
        }
        out.skipped++;
      }
      onProgress(i + 1);
    }
    return out;
  } finally {
    invalidateLoads();
  }
}
