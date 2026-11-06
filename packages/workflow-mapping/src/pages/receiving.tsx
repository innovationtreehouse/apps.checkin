"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Anchor, Badge, Button, Group, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { STATE_LABEL, api, errorMessage, notifyNavCounts, useCanManage, useLoad } from "../components/api";
import { formatCents } from "@checkin/money";
import { isUnreadableReceiptNote } from "../lib/unreadable-receipt";

interface ReceiptRow {
  id: number;
  state: string;
  vendorName?: string | null;
  receiptTotalCents?: number | null;
  currency: string;
  lineItemCount: number;
  validationNotes?: string | null;
  createdAt: string;
}
type Counts = Record<"pending_review" | "apply_failed" | "applying", number>;

// Apply failed needs a person; In progress (`applying`) is shown but needs no one.
const QUEUES = {
  mapping: "pending_review",
  failed: "apply_failed",
  inProgress: "applying",
  all: "",
} as const;
type Queue = keyof typeof QUEUES;

const isQueue = (q: string | null): q is Queue => q !== null && Object.hasOwn(QUEUES, q);
const queueHref = (q: Queue) => `/inventory/receiving?queue=${q}`;

/** /inventory/receiving — the receipt-mapping, apply-failed and in-progress queues. The queue rides in `?queue=`. */
export default function ReceivingPage() {
  const router = useRouter();
  const param = useSearchParams().get("queue");
  const queue: Queue = isQueue(param) ? param : "mapping";
  const counts = useLoad<Counts>("/receipts/counts");
  const rows = useLoad<ReceiptRow[]>(`/receipts${QUEUES[queue] ? `?state=${QUEUES[queue]}` : ""}`);
  const c = counts.data;
  const canRetry = useCanManage() && queue === "failed";
  const [retrying, setRetrying] = useState<number | null>(null);
  const [bulk, setBulk] = useState<{ at: number; of: number } | null>(null);

  function reloadAll() {
    rows.reload();
    counts.reload();
    notifyNavCounts();
  }

  // Retry resets the receipt to applying, then applies it, as the receipt page's Retry apply does.
  // "sending": a part went through but wasn't recorded, so the receipt stays applying.
  async function retryOne(id: number): Promise<{ outcome: "applied" | "sending" } | { outcome: "failed"; message: string }> {
    try {
      await api(`/receipts/${id}/retry-apply`, { method: "POST" });
      const res = await api<{ state?: string; validationNotes?: string | null }>(`/receipts/${id}/apply`, { method: "POST" });
      if (res.state === "apply_failed") return { outcome: "failed", message: res.validationNotes ?? "Apply failed" };
      return { outcome: res.state === "applying" ? "sending" : "applied" };
    } catch (err) {
      return { outcome: "failed", message: errorMessage(err) };
    }
  }

  async function retry(id: number) {
    setRetrying(id);
    const result = await retryOne(id);
    notifications.show(result.outcome === "failed" ? { message: result.message, color: "red", autoClose: false } : { message: "Applied", color: "green" });
    setRetrying(null);
    reloadAll();
  }

  // A receipt whose stored data can't be read fails every retry, so Retry all leaves it out.
  const retryable = canRetry ? (rows.data ?? []).filter((r) => !isUnreadableReceiptNote(r.validationNotes)) : [];
  const skipped = (rows.data?.length ?? 0) - retryable.length;

  async function retryAll() {
    const ids = retryable.map((r) => r.id);
    const tally = { applied: 0, sending: 0, failed: 0 };
    for (const [i, id] of ids.entries()) {
      setBulk({ at: i + 1, of: ids.length });
      tally[(await retryOne(id)).outcome]++;
    }
    setBulk(null);
    const message = [
      `${tally.applied} applied`,
      tally.sending ? `${tally.sending} still sending` : "",
      `${tally.failed} still failed`,
      skipped ? `${skipped} skipped (stored data unreadable)` : "",
    ].filter(Boolean).join(", ");
    const allApplied = tally.applied === ids.length;
    notifications.show(allApplied ? { message, color: "green" } : { message, color: "red", autoClose: false });
    reloadAll();
  }

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Part mapping</Title>
        <Anchor component={Link} href="/inventory/receiving/audit-log" size="sm">Audit log</Anchor>
      </Group>
      <SegmentedControl
        mb="md"
        value={queue}
        onChange={(v) => { if (isQueue(v)) router.replace(queueHref(v), { scroll: false }); }}
        data={[
          { value: "mapping", label: `Needs mapping${c ? ` (${c.pending_review})` : ""}` },
          { value: "failed", label: `Apply failed${c ? ` (${c.apply_failed})` : ""}` },
          { value: "inProgress", label: `In progress${c ? ` (${c.applying})` : ""}` },
          { value: "all", label: "All" },
        ]}
      />
      {retryable.length > 0 && (
        <Group mb="md">
          <Button size="xs" variant="light" loading={bulk !== null} disabled={retrying !== null} onClick={() => void retryAll()}>
            Retry all ({retryable.length})
          </Button>
          {bulk && <Text size="sm" c="dimmed">Retrying {bulk.at} of {bulk.of}…</Text>}
        </Group>
      )}
      {rows.error && <Alert color="red" mb="md" title="Couldn't load receipts">{rows.error}</Alert>}
      {rows.data === null ? <Text c="dimmed">Loading…</Text>
        : rows.data.length === 0 ? <Text c="dimmed">No receipts here.</Text>
        : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Received</Table.Th>
                <Table.Th>Vendor</Table.Th>
                <Table.Th>Total</Table.Th>
                <Table.Th>Lines</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Notes</Table.Th>
                {canRetry && <Table.Th>Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.data.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Anchor component={Link} href={`/inventory/receiving/${r.id}?from=${encodeURIComponent(queueHref(queue))}`}>{new Date(r.createdAt).toLocaleString()}</Anchor>
                  </Table.Td>
                  <Table.Td>{r.vendorName ?? "—"}</Table.Td>
                  <Table.Td>{formatCents(r.receiptTotalCents, r.currency)}</Table.Td>
                  <Table.Td>{r.lineItemCount}</Table.Td>
                  <Table.Td><Badge variant="light">{STATE_LABEL[r.state] ?? r.state}</Badge></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{r.validationNotes ?? ""}</Text></Table.Td>
                  {canRetry && (
                    <Table.Td>
                      <Button size="xs" variant="light" loading={retrying === r.id} disabled={bulk !== null} onClick={() => void retry(r.id)}>
                        Retry
                      </Button>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
