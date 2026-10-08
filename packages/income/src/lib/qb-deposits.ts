import { dollarsToCents } from "@inventory/money";
import { MAX_WINDOW_DAYS, QuickBooksClient, type AccessTokenSource, type QboRealm } from "@inventory/quickbooks";
import type { QbDeposit, QbDepositSource } from "../contract";
import { isoDay } from "../runtime";

/** An inclusive YYYY-MM-DD date range. */
export type DayRange = [from: string, to: string];

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const shift = (day: string, n: number) => isoDay(new Date(dayMs(day) + n * DAY_MS));

/** Merge overlapping and adjacent ranges, then split each into windows of at most MAX_WINDOW_DAYS. */
export function depositWindows(ranges: DayRange[]): DayRange[] {
  const merged: DayRange[] = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0].localeCompare(b[0]))) {
    const last = merged.at(-1);
    if (last && from <= shift(last[1], 1)) {
      if (to > last[1]) last[1] = to;
    } else {
      merged.push([from, to]);
    }
  }
  return merged.flatMap(([from, to]) => {
    const out: DayRange[] = [];
    for (let start = from; start <= to; start = shift(start, MAX_WINDOW_DAYS)) {
      const end = shift(start, MAX_WINDOW_DAYS - 1);
      out.push([start, end < to ? end : to]);
    }
    return out;
  });
}

/** Every deposit dated inside any of `ranges`, read one bounded window at a time. */
export async function depositsIn(source: QbDepositSource, ranges: DayRange[]): Promise<QbDeposit[]> {
  const out: QbDeposit[] = [];
  for (const [from, to] of depositWindows(ranges)) out.push(...(await source.depositsBetween(from, to)));
  return out;
}

/** The deposit port over QuickBooks, using the host's one AccessTokenSource. */
export function quickBooksDepositSource(tokens: AccessTokenSource, realm: QboRealm): QbDepositSource {
  const client = new QuickBooksClient(tokens, realm);
  return {
    async depositsBetween(from, to) {
      return (await client.depositsBetween(from, to)).map((d) => ({
        id: d.Id,
        txnDate: d.TxnDate,
        totalCents: dollarsToCents(d.TotalAmt),
        depositToAccount: d.DepositToAccountRef?.value ?? null,
      }));
    },
  };
}
