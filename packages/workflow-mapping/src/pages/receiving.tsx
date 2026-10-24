"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Anchor, Badge, Group, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { STATE_LABEL, formatCents, useLoad } from "../components/api";

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

// The apply-failed queue includes `applying`, so a receipt whose push never landed is still on a screen.
const QUEUES = {
  mapping: "pending_review",
  failed: "apply_failed,applying",
  all: "",
} as const;
type Queue = keyof typeof QUEUES;

const isQueue = (q: string | null): q is Queue => q !== null && Object.hasOwn(QUEUES, q);
const queueHref = (q: Queue) => `/inventory/receiving?queue=${q}`;

/** /inventory/receiving — the receipt-mapping queue and the apply-failed queue. The queue rides in `?queue=`. */
export default function ReceivingPage() {
  const router = useRouter();
  const param = useSearchParams().get("queue");
  const queue: Queue = isQueue(param) ? param : "mapping";
  const counts = useLoad<Counts>("/receipts/counts");
  const rows = useLoad<ReceiptRow[]>(`/receipts${QUEUES[queue] ? `?state=${QUEUES[queue]}` : ""}`);
  const c = counts.data;

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
          { value: "failed", label: `Apply failed${c ? ` (${c.apply_failed + c.applying})` : ""}` },
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
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
