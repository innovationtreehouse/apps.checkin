"use client";
import { Badge, Table, Text, Title } from "@mantine/core";
import { cents, useLoad, when } from "../components/api";
import LoadError from "../components/LoadError";

interface QueueItem {
  id: number;
  receiptId: string;
  receiptTotalCents: number | null;
  receiptDate: string | null;
  moneyReceivedAt: string | null;
  donorRecordedAt: string | null;
  withdrawnAfterMoneyAt: string | null;
}

/** /donations/in-kind — in-kind receipts waiting on their donor, and withdrawals that arrived after the money. */
export default function InKindQueuePage() {
  const queue = useLoad<QueueItem[]>("/in-kind/queue");

  return (
    <>
      <Title order={3} mb="md">In-kind queue</Title>
      <Text size="sm" c="dimmed" mb="md">
        Donor needed clears itself when the donor for the receipt arrives; one that stays means the receipt side is stuck.
        Withdrawn after money is an anomaly: the in-kind mark was cleared after the money side was recorded.
      </Text>
      {queue.error && <LoadError what="the in-kind queue" message={queue.error} onRetry={queue.reload} />}
      {queue.data?.length === 0 && <Text c="dimmed">Nothing in the queue.</Text>}
      {!!queue.data?.length && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Status</Table.Th><Table.Th>Receipt</Table.Th><Table.Th>Receipt date</Table.Th>
              <Table.Th>Amount</Table.Th><Table.Th>Money received</Table.Th><Table.Th>Withdrawn</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {queue.data.map((q) => (
              <Table.Tr key={q.id}>
                <Table.Td>
                  {q.withdrawnAfterMoneyAt
                    ? <Badge color="red">Withdrawn after money</Badge>
                    : <Badge color="yellow">Donor needed</Badge>}
                </Table.Td>
                <Table.Td>{q.receiptId}</Table.Td>
                <Table.Td>{q.receiptDate ?? "—"}</Table.Td>
                <Table.Td>{q.receiptTotalCents === null ? "—" : cents(q.receiptTotalCents)}</Table.Td>
                <Table.Td>{when(q.moneyReceivedAt)}</Table.Td>
                <Table.Td>{when(q.withdrawnAfterMoneyAt)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </>
  );
}
