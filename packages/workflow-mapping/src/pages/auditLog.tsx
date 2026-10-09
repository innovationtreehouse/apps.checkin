"use client";
import Link from "next/link";
import { Alert, Anchor, Code, Table, Text, Title } from "@mantine/core";
import { useLoad } from "../components/api";

interface AuditRow {
  id: number;
  actorUsername?: string | null;
  eventType: string;
  receivedReceiptId?: number | null;
  fromState: string | null;
  toState: string | null;
  details?: unknown;
  createdAt: string;
}

/** /inventory/receiving/audit-log — every receipt transition and line decision, newest first. */
export default function AuditLogPage() {
  const log = useLoad<AuditRow[]>("/audit-log?limit=200");

  return (
    <>
      <Anchor component={Link} href="/inventory/receiving" size="sm">← Receiving</Anchor>
      <Title order={3} my="md">Receiving audit log</Title>
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
                <Table.Th>State</Table.Th>
                <Table.Th>Details</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {log.data.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td>{new Date(e.createdAt).toLocaleString()}</Table.Td>
                  <Table.Td>{e.actorUsername ?? "system"}</Table.Td>
                  <Table.Td>{e.eventType}</Table.Td>
                  <Table.Td>
                    {e.receivedReceiptId
                      ? <Anchor component={Link} href={`/inventory/receiving/${e.receivedReceiptId}`}>#{e.receivedReceiptId}</Anchor>
                      : "—"}
                  </Table.Td>
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
