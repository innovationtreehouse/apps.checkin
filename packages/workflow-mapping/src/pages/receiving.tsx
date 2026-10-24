"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Anchor, Badge, Button, Group, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { STATE_LABEL, api, errorMessage, formatCents, notifyNavCounts, useCanManage, useLoad } from "../components/api";

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

  // Retry resets the receipt to applying, then applies it, as the receipt page's Retry apply does.
  async function retry(id: number) {
    setRetrying(id);
    try {
      await api(`/receipts/${id}/retry-apply`, { method: "POST" });
      const res = await api<{ state?: string; validationNotes?: string | null }>(`/receipts/${id}/apply`, { method: "POST" });
      if (res.state === "apply_failed") notifications.show({ message: res.validationNotes ?? "Apply failed", color: "red", autoClose: false });
      else notifications.show({ message: "Applied", color: "green" });
    } catch (err) {
      notifications.show({ message: errorMessage(err), color: "red", autoClose: false });
    } finally {
      setRetrying(null);
      rows.reload();
      counts.reload();
      notifyNavCounts();
    }
  }

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>Receiving</Title>
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
                      <Button size="xs" variant="light" loading={retrying === r.id} onClick={() => void retry(r.id)}>
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
