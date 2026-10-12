"use client";
import { useState } from "react";
import { Badge, Button, Group, Modal, Table, Text, Title } from "@mantine/core";
import { act, api, cents, useCanWrite, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";

interface EventRow { id: number; disbursementId: string; payload: string; createdAt: string; qbMatchState: string; qbTxnId: string | null }
interface Candidate { id: string; type: string; date: string; amountCents: number; memo: string | null }

/** The booking batch's line count (one per non-zero donation, match and summed fee). */
function summary(payload: string): string {
  try {
    return `${((JSON.parse(payload) as { items?: unknown[] }).items ?? []).length} lines`;
  } catch {
    return "—";
  }
}

/** /donations/events — completed disbursements (booking batches) and their QuickBooks match state. */
export default function EventsPage() {
  const canWrite = useCanWrite();
  const events = useLoad<EventRow[]>("/disbursement-events");
  const [open, setOpen] = useState<string | null>(null);
  const candidates = useLoad<Candidate[]>(open ? `/disbursement-events/${encodeURIComponent(open)}/qb-candidates` : null);

  return (
    <>
      <Title order={3} mb="md">Booking batches</Title>
      {events.error && <LoadError what="booking batches" message={events.error} onRetry={events.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr><Table.Th>Completed</Table.Th><Table.Th>Disbursement</Table.Th><Table.Th>Batch</Table.Th><Table.Th>QuickBooks</Table.Th><Table.Th /></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(events.data ?? []).map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{when(e.createdAt)}</Table.Td>
              <Table.Td>{e.disbursementId}</Table.Td>
              <Table.Td>{summary(e.payload)}</Table.Td>
              <Table.Td><Badge variant="light">{e.qbMatchState}</Badge>{e.qbTxnId && <Text size="xs">{e.qbTxnId}</Text>}</Table.Td>
              <Table.Td><Button size="xs" variant="light" onClick={() => setOpen(e.disbursementId)}>QuickBooks</Button></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Modal opened={open !== null} onClose={() => setOpen(null)} title={`QuickBooks match — ${open ?? ""}`}>
        {candidates.error && <LoadError what="candidates" message={candidates.error} onRetry={candidates.reload} />}
        {candidates.data?.length === 0 && <Text size="sm" c="dimmed" mb="sm">No QuickBooks candidates.</Text>}
        {(candidates.data ?? []).map((c) => (
          <Text key={c.id} size="sm">{c.date} · {c.type} · {cents(c.amountCents)} · {c.memo ?? ""}</Text>
        ))}
        {canWrite && open && (
          <Group mt="md">
            <Button size="xs" onClick={() => act(
              () => api(`/disbursement-events/${encodeURIComponent(open)}/qb-resolve`, { method: "POST", body: JSON.stringify({ action: "retry" }) }),
              "Resolved", events.reload,
            )}>Retry match</Button>
          </Group>
        )}
      </Modal>
    </>
  );
}
