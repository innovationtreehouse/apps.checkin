"use client";
import { useEffect } from "react";
import Link from "next/link";
import { notifications } from "@mantine/notifications";
import { Anchor, Badge, Table, Text } from "@mantine/core";
import { formatCents } from "@checkin/money";
import { useLoad, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";
import { NOT_PUSHED, queueListPath, reviewDetailHref } from "../components/reviewQueue";

const DUPLICATE_QUEUE_PATH = "/duplicate-queue";

export { NOT_PUSHED, OTHER_QUEUES, QUEUES, isOtherQueue, isReceiptQueue, reviewHref } from "../components/reviewQueue";
export { QueueCount, queueBadge, useQueueCounts, type QueueBadge, type QueueCounts } from "../components/queueCounts";

/** A chip that stays while the queue at `path` can't be read, naming the route and the cause. */
function useLoadErrorChip(error: string | null, path: string, id: string, route: string) {
  useEffect(() => {
    if (!error) return;
    const server = /^(Internal Server Error|HTTP 5\d\d)$/.test(error);
    notifications.show({
      id,
      title: "Couldn't load these receipts",
      message: server ? `GET ${route} failed on the server (HTTP 500); the server log names the cause under that route.` : `GET ${route} answered: ${error}`,
      color: "red",
      autoClose: false,
    });
  }, [error, path, id, route]);
}

interface DuplicateQueueRow {
  id: string;
  retailer: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
  memberCount: number;
  includesRejected: boolean;
  oldestHeldAt: string | null;
}

function waited(since: string | null): string {
  if (!since) return "—";
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000);
  return days < 1 ? "Today" : days === 1 ? "1 day" : `${days} days`;
}

/** The Duplicates tab: one row per group of matching receipts, opening its oldest held member. */
function DuplicateQueueList() {
  const list = useLoad<DuplicateQueueRow[]>(DUPLICATE_QUEUE_PATH);
  useLoadErrorChip(list.error, DUPLICATE_QUEUE_PATH, "receipt-queue-duplicate_flagged", `/api/receipts${DUPLICATE_QUEUE_PATH}`);
  if (!list.data) return null;
  if (list.data.length === 0) return <Text c="dimmed">No receipts.</Text>;
  return (
    <Table.ScrollContainer minWidth={560}>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Vendor</Table.Th>
            <Table.Th>Date</Table.Th>
            <Table.Th>Total</Table.Th>
            <Table.Th>Receipts</Table.Th>
            <Table.Th>Waiting</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {list.data.map((g) => (
            <Table.Tr key={g.id}>
              <Table.Td>
                <Anchor component={Link} href={reviewDetailHref(g.id, "duplicate_flagged")}>{g.retailer ?? "Receipt"}</Anchor>
              </Table.Td>
              <Table.Td>{g.receiptDate ?? "—"}</Table.Td>
              <Table.Td>{formatCents(g.receiptTotalCents)}</Table.Td>
              <Table.Td>
                {g.memberCount}
                {g.includesRejected && <Badge ml="xs" size="xs" color="red">Includes a rejected receipt</Badge>}
              </Table.Td>
              <Table.Td>{waited(g.oldestHeldAt)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** One non-duplicate receipt tab: the org's receipts in `queue` ("" is every state). */
function PlainQueueList({ queue }: { queue: string }) {
  const path = queueListPath(queue);
  const list = useLoad<ReceiptListRow[]>(path);
  useLoadErrorChip(list.error, path, `receipt-queue-${queue || "all"}`, `/api/receipts${path}`);
  return list.data ? <ReceiptTable rows={list.data} delivery={queue === NOT_PUSHED} detailHref={(id) => reviewDetailHref(id, queue)} /> : null;
}

/**
 * One receipt tab of the host's finance queue. FINANCE works them; BOARD reads them. A receipt
 * opens at /receipts/[id] carrying the queue.
 */
export function ReceiptQueueList({ queue }: { queue: string }) {
  return queue === "duplicate_flagged" ? <DuplicateQueueList /> : <PlainQueueList queue={queue} />;
}
