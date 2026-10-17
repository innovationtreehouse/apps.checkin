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

async function failure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") return body.error;
  } catch {
    // A body that is not JSON reports by status alone.
  }
  return `HTTP ${res.status}`;
}

/** Releases each item in turn, one request at a time, and stops at the first failure it cannot skip. */
export async function releaseAll(
  ids: number[],
  release: (id: number) => Promise<Response>,
  onProgress: (tried: number) => void = () => {},
): Promise<ReleaseOutcome> {
  const out: ReleaseOutcome = { released: 0, skipped: 0, error: null, notReached: 0 };
  for (const [i, id] of ids.entries()) {
    let res: Response;
    try {
      res = await release(id);
    } catch (err) {
      return { ...out, error: err instanceof Error ? err.message : "Network error", notReached: ids.length - i - 1 };
    }
    if (res.ok) out.released++;
    else if (SKIP.has(res.status)) out.skipped++;
    else return { ...out, error: await failure(res), notReached: ids.length - i - 1 };
    onProgress(i + 1);
  }
  return out;
}
