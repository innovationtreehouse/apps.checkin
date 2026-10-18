"use client";
import { Fragment, useState } from "react";
import { Anchor, Badge, Button, Code, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { act, api, cents, paged, useCanWrite, useLoad } from "../components/api";
import LoadError from "../components/LoadError";
import Pager from "../components/Pager";
import { QB_BOOKABLE_STATES, QB_HELD_STATES, QB_RETRYABLE_STATES } from "../lib/qb-queue-states";

interface HeldRow {
  id: number;
  disbursementId: string;
  payload: string;
  qbMatchState: string;
  qbDriftedTxnId: string | null;
  qbDriftCause: string | null;
  qbDepositTotalCents: number | null;
  qbDepositTxnDate: string | null;
  qbTxnId: string | null;
  qbNote: string | null;
}
interface Candidate { id: string; type: string; date: string; amountCents: number; memo: string | null }

const STATE_HELP: Record<string, string> = {
  AMBIGUOUS: "More than one QuickBooks deposit could be this disbursement, or its deposit is claimed twice and one needs voiding",
  UNBOOKED: "Not found in QuickBooks, and the app may not create it on its own; match the hand-booked deposit, book it, or dismiss it with a reason",
  BEFORE_LINE: "Not found in QuickBooks, and the app may not create it on its own; match the hand-booked deposit, book it, or dismiss it with a reason",
  POST_FAILED: "Creating the deposit failed; the drain retries it",
  NEEDS_FINANCE: "Out of automatic retries, or over the per-run cap",
  DRIFT: "Its booked QuickBooks deposit changed or disappeared; match it again, or dismiss it",
};

const DRIFT_CAUSE: Record<string, string> = {
  deposit_missing: "no longer in QuickBooks",
  deposit_changed: "changed in QuickBooks (see it marked below)",
};

/** What a drifted row had booked, and what became of it. */
function DriftNote({ row }: { row: HeldRow }) {
  if (row.qbMatchState !== "DRIFT") return null;
  const booked = row.qbDepositTotalCents === null ? "" : ` · booked ${cents(row.qbDepositTotalCents)}${row.qbDepositTxnDate ? ` on ${row.qbDepositTxnDate}` : ""}`;
  return (
    <Text size="xs" mt={4}>
      Deposit <Code>{row.qbDriftedTxnId ?? "—"}</Code>{booked} · {DRIFT_CAUSE[row.qbDriftCause ?? ""] ?? row.qbDriftCause ?? ""}
    </Text>
  );
}

/** The disbursement date and the net its deposit should total, from the stored payload. */
function facts(payload: string): { date: string; netCents: number | null } {
  try {
    const p = JSON.parse(payload) as { disbursementDate?: string | null; items?: { type: string; amountCents: number }[] };
    const netCents = (p.items ?? []).reduce((s, i) => s + (i.type === "fees" ? -i.amountCents : i.amountCents), 0);
    return { date: p.disbursementDate ?? "—", netCents };
  } catch {
    return { date: "—", netCents: null };
  }
}

const isIn = (states: readonly string[], state: string) => states.some((s) => s === state);

/** What finance should know about the row, from the drain, a lost claim or the daily sweep. */
function QbNote({ row }: { row: HeldRow }) {
  return row.qbNote ? <Text size="xs" mt={4} c="red">{row.qbNote}</Text> : null;
}

/** The saved row after a match or dismiss: the app may have linked its own deposit instead. */
function resolvedMessage(saved: unknown, fallback: string): string {
  const row = saved as Partial<HeldRow> | null;
  return row?.qbMatchState === "CREATED" && row.qbTxnId ? `The app had already booked deposit ${row.qbTxnId}; linked to it` : fallback;
}

/** One queued disbursement's actions: candidate deposits to match or exclude, retry, book, dismiss, or clear its note. */
function RowActions({ row, onDone }: { row: HeldRow; onDone: () => void }) {
  const base = `/disbursement-events/${encodeURIComponent(row.disbursementId)}`;
  const candidates = useLoad<Candidate[]>(`${base}/qb-candidates`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const held = isIn(QB_HELD_STATES, row.qbMatchState);
  async function run(call: () => Promise<unknown>, ok: string | ((saved: unknown) => string)) {
    setBusy(true);
    await act(call, ok, onDone);
    setBusy(false);
  }
  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

  if (!held) {
    return (
      <Group gap="xs" align="end">
        <TextInput size="xs" label="Reason (clear the note, e.g. the stray deposit is voided)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} w={340} />
        <Button size="xs" variant="default" disabled={busy || !reason.trim()} onClick={() => run(() => post(`${base}/qb-resolve`, { action: "clear", reason }), "Note cleared")}>
          Clear note
        </Button>
      </Group>
    );
  }

  return (
    <>
      <Text size="sm" fw={500} mb="xs">Candidate deposits (±7 days, unclaimed, not excluded)</Text>
      {candidates.error ? <Text size="sm" c="red" mb="sm">{candidates.error}</Text>
        : candidates.data === null ? <Text size="sm" c="dimmed" mb="sm">Loading…</Text>
        : candidates.data.length === 0 ? <Text size="sm" c="dimmed" mb="sm">No candidates.</Text>
        : (
          <Table withTableBorder mb="sm">
            <Table.Tbody>
              {candidates.data.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>{c.date}</Table.Td>
                  <Table.Td>{cents(c.amountCents)}</Table.Td>
                  <Table.Td>
                    <Code>{c.id}</Code>
                    {c.id === row.qbDriftedTxnId && <Badge size="xs" ml="xs" color="orange">booked deposit, as it is now</Badge>}
                  </Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{c.memo ?? ""}</Text></Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button size="xs" disabled={busy} onClick={() => run(() => post(`${base}/qb-resolve`, { action: "match", qbTxnId: c.id, ...(reason.trim() ? { reason } : {}) }), (saved) => resolvedMessage(saved, "Matched"))}>
                        Match
                      </Button>
                      <Button size="xs" variant="light" color="red" disabled={busy || !reason.trim()} onClick={() => run(() => post("/qb-exclusions", { qbTxnId: c.id, reason }), "Deposit excluded for good")}>
                        Exclude permanently
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      <Group gap="xs" align="end">
        <TextInput size="xs" label="Reason (dismiss, exclude, clear the note, or match a deposit whose amount differs)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} w={340} />
        <Button size="xs" variant="default" disabled={busy || !reason.trim()} onClick={() => run(() => post(`${base}/qb-resolve`, { action: "dismiss", reason }), (saved) => resolvedMessage(saved, "Dismissed"))}>
          Dismiss
        </Button>
        {isIn(QB_BOOKABLE_STATES, row.qbMatchState) && (
          <Button size="xs" disabled={busy} onClick={() => run(() => post(`${base}/qb-resolve`, { action: "book" }), "Booked in QuickBooks")}>
            Book it
          </Button>
        )}
        {row.qbNote && (
          <Button size="xs" variant="default" disabled={busy || !reason.trim()} onClick={() => run(() => post(`${base}/qb-resolve`, { action: "clear", reason }), "Note cleared")}>
            Clear note
          </Button>
        )}
        {isIn(QB_RETRYABLE_STATES, row.qbMatchState) && (
          <Button size="xs" variant="default" disabled={busy} onClick={() => run(() => post(`${base}/qb-resolve`, { action: "retry" }), "Handed back to the drain")}>
            Retry
          </Button>
        )}
      </Group>
    </>
  );
}

/** /donations/qb-queue — completed disbursements the drain holds for finance, and any carrying a note for finance. */
export default function QbQueuePage() {
  const canWrite = useCanWrite();
  const [page, setPage] = useState(1);
  const rows = useLoad<HeldRow[]>(paged(`/disbursement-events?qbState=${QB_HELD_STATES.join(",")}&noted=1`, page));
  const [open, setOpen] = useState<number | null>(null);

  const reload = () => {
    setOpen(null);
    rows.reload();
  };

  return (
    <>
      <Title order={3} mb="md">QuickBooks queue</Title>
      {rows.error && <LoadError what="the QuickBooks queue" message={rows.error} onRetry={rows.reload} />}
      {rows.data === null ? <Text c="dimmed">Loading…</Text>
        : rows.data.length === 0 ? <Text c="dimmed">Nothing needs finance&apos;s attention.</Text>
        : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Disbursement date</Table.Th>
                <Table.Th>Net</Table.Th>
                <Table.Th>Why</Table.Th>
                <Table.Th>Disbursement</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.data.map((row) => {
                const { date, netCents } = facts(row.payload);
                return (
                  <Fragment key={row.id}>
                    <Table.Tr>
                      <Table.Td>{date}</Table.Td>
                      <Table.Td>{netCents === null ? "—" : cents(netCents)}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" color="orange">{row.qbMatchState}</Badge>{" "}
                        <Text span size="sm" c="dimmed">{STATE_HELP[row.qbMatchState] ?? ""}</Text>
                        <DriftNote row={row} />
                        <QbNote row={row} />
                      </Table.Td>
                      <Table.Td><Code>{row.disbursementId}</Code></Table.Td>
                      <Table.Td>
                        {canWrite && (
                          <Anchor size="sm" onClick={() => setOpen(open === row.id ? null : row.id)}>
                            {open === row.id ? "Close" : "Resolve"}
                          </Anchor>
                        )}
                      </Table.Td>
                    </Table.Tr>
                    {open === row.id && (
                      <Table.Tr>
                        <Table.Td colSpan={5}><RowActions row={row} onDone={reload} /></Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      <Pager page={page} onChange={setPage} rows={rows.data} />
    </>
  );
}
