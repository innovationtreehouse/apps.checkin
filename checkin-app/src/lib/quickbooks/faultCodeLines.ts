/** One stored row: a fault code counted under one kind. */
export interface FaultCodeRow {
  code: string;
  kind: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastLane: string;
}

/** A code's rows folded into one line of the table. */
export interface FaultCodeLine {
  code: string;
  kinds: { kind: string; count: number }[];
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastLane: string;
}

/** Folds rows into one line per code, newest last-seen first; the lane is the latest row's. */
export function linesByCode(rows: FaultCodeRow[]): FaultCodeLine[] {
  const lines = new Map<string, FaultCodeLine>();
  for (const row of rows) {
    const line = lines.get(row.code);
    if (!line) {
      const { code, kind, count, firstSeenAt, lastSeenAt, lastLane } = row;
      lines.set(code, { code, kinds: [{ kind, count }], count, firstSeenAt, lastSeenAt, lastLane });
      continue;
    }
    line.kinds.push({ kind: row.kind, count: row.count });
    line.count += row.count;
    if (row.firstSeenAt < line.firstSeenAt) line.firstSeenAt = row.firstSeenAt;
    if (row.lastSeenAt > line.lastSeenAt) {
      line.lastSeenAt = row.lastSeenAt;
      line.lastLane = row.lastLane;
    }
  }
  for (const line of lines.values()) line.kinds.sort((a, b) => b.count - a.count);
  return [...lines.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
