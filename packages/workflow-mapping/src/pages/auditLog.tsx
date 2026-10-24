"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, Anchor, Code, Group, Select, Table, Text, Title } from "@mantine/core";
import { api, useLoad } from "../components/api";
import { auditEventLabel } from "../db/schema";

interface AuditRow {
  id: number;
  actorUsername?: string | null;
  eventType: string;
  receivedReceiptId?: number | null;
  lineStatusId?: number | null;
  fromState: string | null;
  toState: string | null;
  details?: unknown;
  createdAt: string;
}

interface ReceiptLines {
  WorkflowReceiptView: { lineItems: { receiptLineItemId: number; lineNumber: number; description: string }[] };
  ReceivedReceiptLineStatus: { id: number; receiptLineItemId: number }[];
}

/** Line label by line status id, or "failed" when the receipt's detail didn't load. */
type ReceiptLineLabels = Map<number, string> | "failed";

// The route's server-side cap is 500.
const LIMIT_OPTIONS = ["50", "100", "500"];

function lineLabels(detail: ReceiptLines): Map<number, string> {
  const items = new Map(detail.WorkflowReceiptView.lineItems.map((li) => [li.receiptLineItemId, li]));
  const labels = new Map<number, string>();
  for (const ls of detail.ReceivedReceiptLineStatus) {
    const li = items.get(ls.receiptLineItemId);
    if (li) labels.set(ls.id, `${li.lineNumber} · ${li.description}`);
  }
  return labels;
}

/** Loads each receipt a line event touched, once, so the Line column matches the receipt page's numbering. */
function useLineLabels(rows: AuditRow[] | null): Map<number, ReceiptLineLabels> {
  const [byReceipt, setByReceipt] = useState<Map<number, ReceiptLineLabels>>(new Map());
  const touched = (rows ?? []).flatMap((r) => (r.lineStatusId != null && r.receivedReceiptId != null ? [r.receivedReceiptId] : []));
  const wanted = [...new Set(touched)].filter((id) => !byReceipt.has(id));
  const key = wanted.join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const ids = key.split(",").map(Number);
    void Promise.all(ids.map((id) =>
      api<ReceiptLines>(`/receipts/${id}`)
        .then((d): [number, ReceiptLineLabels] => [id, lineLabels(d)])
        .catch((): [number, ReceiptLineLabels] => [id, "failed"]),
    )).then((loaded) => {
      if (!cancelled) setByReceipt((prev) => new Map([...prev, ...loaded]));
    });
    return () => { cancelled = true; };
  }, [key]);

  return byReceipt;
}

/** /inventory/receiving/audit-log — every receipt transition and line decision, newest first. */
export default function AuditLogPage() {
  const [limit, setLimit] = useState("100");
  const log = useLoad<AuditRow[]>(`/audit-log?limit=${limit}`);
  const lines = useLineLabels(log.data);

  const lineCell = (e: AuditRow) => {
    if (e.lineStatusId == null) return "";
    const labels = e.receivedReceiptId != null ? lines.get(e.receivedReceiptId) : "failed";
    if (labels === undefined) return "…";
    return labels === "failed" ? "—" : labels.get(e.lineStatusId) ?? "—";
  };

  return (
    <>
      <Anchor component={Link} href="/inventory/receiving" size="sm">← Receiving</Anchor>
      <Group justify="space-between" my="md">
        <Title order={3}>Receiving audit log</Title>
        <Group gap="sm">
          <Select label="Rows" data={LIMIT_OPTIONS} value={limit} onChange={(v) => setLimit(v ?? "100")} allowDeselect={false} w={90} size="xs" />
          {log.data && <Text size="sm" c="dimmed">{log.data.length} entries</Text>}
        </Group>
      </Group>
      {log.error && <Alert color="red" mb="md" title="Couldn't load the audit log">{log.error}</Alert>}
      {log.data === null ? <Text c="dimmed">Loading…</Text>
        : log.data.length === 0 ? <Text c="dimmed">No activity yet.</Text>
        : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>When</Table.Th>
                <Table.Th>Who</Table.Th>
                <Table.Th>Event</Table.Th>
                <Table.Th>Receipt</Table.Th>
                <Table.Th>Line</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Details</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {log.data.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{new Date(e.createdAt).toLocaleString()}</Table.Td>
                  <Table.Td>{e.actorUsername ?? "system"}</Table.Td>
                  <Table.Td>{auditEventLabel(e.eventType)}</Table.Td>
                  <Table.Td>
                    {e.receivedReceiptId
                      ? <Anchor component={Link} href={`/inventory/receiving/${e.receivedReceiptId}?from=/inventory/receiving/audit-log`}>#{e.receivedReceiptId}</Anchor>
                      : "—"}
                  </Table.Td>
                  <Table.Td>{lineCell(e)}</Table.Td>
                  <Table.Td>{e.fromState || e.toState ? `${e.fromState ?? "—"} → ${e.toState ?? "—"}` : ""}</Table.Td>
                  <Table.Td>{e.details ? <Code>{JSON.stringify(e.details)}</Code> : ""}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
    </>
  );
}
