"use client";
import { useState } from "react";
import Link from "next/link";
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

/** /inventory/receiving — the receipt-mapping queue and the apply-failed queue. */
export default function ReceivingPage() {
  const [queue, setQueue] = useState<Queue>("mapping");
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
        onChange={(v) => setQueue(v as Queue)}
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
                    <Anchor component={Link} href={`/inventory/receiving/${r.id}`}>{new Date(r.createdAt).toLocaleString()}</Anchor>
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
