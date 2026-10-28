"use client";
import { useState } from "react";
import { Table, Text, Title } from "@mantine/core";
import { paged, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";
import Pager from "../components/Pager";

interface EventRow { id: number; disbursementId: string; payload: string; createdAt: string }

/** The booking batch's line count (one per non-zero donation, match and summed fee). */
function summary(payload: string): string {
  try {
    return `${((JSON.parse(payload) as { items?: unknown[] }).items ?? []).length} lines`;
  } catch {
    return "—";
  }
}

/** /donations/events — completed disbursements (booking batches); income books each deposit. */
export default function EventsPage() {
  const [page, setPage] = useState(1);
  const events = useLoad<EventRow[]>(paged("/disbursement-events", page));

  return (
    <>
      <Title order={3} mb="md">Booking batches</Title>
      {events.error && <LoadError what="booking batches" message={events.error} onRetry={events.reload} />}
      <Table striped>
        <Table.Thead>
          <Table.Tr><Table.Th>Completed</Table.Th><Table.Th>Disbursement</Table.Th><Table.Th>Batch</Table.Th></Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(events.data ?? []).map((e) => (
            <Table.Tr key={e.id}>
              <Table.Td>{when(e.createdAt)}</Table.Td>
              <Table.Td>{e.disbursementId}</Table.Td>
              <Table.Td>{summary(e.payload)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" mt="md">Income matches and books each disbursement&apos;s deposit; see each one in income&apos;s reconciliation queue.</Text>
      <Pager page={page} onChange={setPage} rows={events.data} />
    </>
  );
}
