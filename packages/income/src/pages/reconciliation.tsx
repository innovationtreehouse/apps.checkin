"use client";
import { Fragment, useState } from "react";
import { Anchor, Badge, Button, Code, Group, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, money, notifyNavCounts, useIsFinance, useLoad } from "../components/api";
import LoadError from "../components/LoadError";

interface ReconRow {
  id: number;
  payoutGid: string;
  payoutDate: string;
  payoutNetCents: number;
  status: string;
  kind: string | null;
  reason: string | null;
  qbNote: string | null;
}

interface Deposit {
  id: string;
  txnDate: string;
  totalCents: number;
  depositToAccount: string | null;
}

interface RunResult {
  status: string;
  matched: number;
  opened: number;
  drifted: number;
}

const KIND_HELP: Record<string, string> = {
  NO_DEPOSIT: "No QuickBooks deposit matches this payout; book it, match it, or dismiss it with a reason",
  AMBIGUOUS_DEPOSIT: "More than one deposit could be this payout",
  TXN_SUM_MISMATCH: "The payout's transactions don't add up to its net",
  DRIFT: "The payout or its deposit changed after it was reconciled",
  POST_FAILED: "Creating the deposit failed",
  OVER_CAP: "Larger than the per-run cap, so it is never created automatically; retry to create it",
  NEEDS_MAPPING: "Waiting for item decisions on the Items page; books itself on the next run once they are made",
};

async function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

/** One queue row's actions: on an open row, candidate deposits to match or exclude, dismiss, retry, book; on any row with an app note, clear it. */
function RowActions({ row, onDone }: { row: ReconRow; onDone: () => void }) {
  const candidates = useLoad<Deposit[]>(`/reconciliation/${row.id}/candidates`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      notifications.show({ message, color: "green" });
      onDone();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setBusy(false);
    }
  }

  const resolve = (body: unknown, message: string) => act(() => post(`/reconciliation/${row.id}/resolve`, body), message);
  const needReason = () => {
    if (!reason.trim()) notifications.show({ message: "Enter a reason first", color: "red", autoClose: false });
    return !!reason.trim();
  };

  const clearNote = row.qbNote && (
    <Button size="xs" variant="default" disabled={busy} onClick={() => needReason() && resolve({ action: "clear_note", reason }, "Note cleared")}>Clear note</Button>
  );
  if (row.status !== "OPEN") {
    return (
      <Group gap="xs" align="end">
        <TextInput size="xs" label="Reason (clear the note)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} w={320} />
        {clearNote}
      </Group>
    );
  }

  return (
    <>
      <Text size="sm" fw={500} mb="xs">Candidate deposits (±window, unclaimed, not excluded)</Text>
      {candidates.error ? <Text size="sm" c="red" mb="sm">{candidates.error}</Text>
        : candidates.data === null ? <Text size="sm" c="dimmed" mb="sm">Loading…</Text>
        : candidates.data.length === 0 ? <Text size="sm" c="dimmed" mb="sm">No candidates.</Text>
        : (
          <Table withTableBorder mb="sm">
            <Table.Tbody>
              {candidates.data.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td>{d.txnDate}</Table.Td>
                  <Table.Td>{money(d.totalCents)}</Table.Td>
                  <Table.Td><Code>{d.id}</Code></Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button size="xs" disabled={busy} onClick={() => resolve({ action: "match", depositId: d.id, ...(reason.trim() ? { reason } : {}) }, "Matched")}>Match</Button>
                      <Button
                        size="xs"
                        variant="light"
                        color="red"
                        disabled={busy}
                        onClick={() => needReason() && act(() => post("/qb-exclusions", { qbTxnId: d.id, reason }), "Deposit excluded for good")}
                      >
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
        <TextInput size="xs" label="Reason (dismiss, exclude, or match a deposit whose amount differs)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} w={320} />
        <Button size="xs" variant="default" disabled={busy} onClick={() => needReason() && resolve({ action: "dismiss", reason }, "Dismissed")}>
          Dismiss
        </Button>
        {(row.kind === "POST_FAILED" || row.kind === "OVER_CAP") && (
          <Button size="xs" variant="default" disabled={busy} onClick={() => resolve({ action: "retry" }, "Retried")}>Retry create</Button>
        )}
        {row.kind === "NO_DEPOSIT" && (
          <Button size="xs" variant="default" disabled={busy} onClick={() => resolve({ action: "book" }, "Booked")}>Book it</Button>
        )}
        {clearNote}
      </Group>
    </>
  );
}

/** /income/reconciliation — payouts that did not match a QuickBooks deposit, with why. */
export default function ReconciliationPage() {
  const rows = useLoad<ReconRow[]>("/reconciliation");
  const count = useLoad<{ total: number }>("/reconciliation/count");
  const isFinance = useIsFinance();
  const [open, setOpen] = useState<number | null>(null);
  const [running, setRunning] = useState(false);

  const reload = () => {
    setOpen(null);
    rows.reload();
    count.reload();
    notifyNavCounts();
  };

  async function runNow() {
    setRunning(true);
    try {
      const r = await post<RunResult>("/reconciliation/run", {});
      notifications.show({
        message: r.status === "ran" ? `Matched ${r.matched}, opened ${r.opened}, drifted ${r.drifted}` : `Nothing to run (${r.status})`,
        color: "green",
      });
      reload();
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Reconciliation {count.data ? <Badge ml="xs">{count.data.total}</Badge> : null}</Title>
        {isFinance && <Button size="sm" loading={running} onClick={runNow}>Run now</Button>}
      </Group>
      {rows.error && <LoadError what="the reconciliation queue" message={rows.error} onRetry={rows.reload} />}
      {rows.data === null ? <Text c="dimmed">Loading…</Text>
        : rows.data.length === 0 ? <Text c="dimmed">Nothing needs finance&apos;s attention.</Text>
        : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Payout date</Table.Th>
                <Table.Th>Net</Table.Th>
                <Table.Th>Why</Table.Th>
                <Table.Th>Payout</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.data.map((row) => (
                <Fragment key={row.id}>
                  <Table.Tr>
                    <Table.Td>{row.payoutDate}</Table.Td>
                    <Table.Td>{money(row.payoutNetCents)}</Table.Td>
                    <Table.Td>
                      <Badge size="sm" color="orange">{row.kind ?? row.status}</Badge>{" "}
                      <Text span size="sm" c="dimmed">{row.kind ? KIND_HELP[row.kind] : ""}</Text>
                      {row.reason && <Text size="sm">{row.reason}</Text>}
                      {row.qbNote && <Text size="sm" c="orange">{row.qbNote}</Text>}
                    </Table.Td>
                    <Table.Td><Code>{row.payoutGid}</Code></Table.Td>
                    <Table.Td>
                      {isFinance && (
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
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
