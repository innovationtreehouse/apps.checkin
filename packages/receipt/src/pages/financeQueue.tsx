"use client";
import { Alert } from "@mantine/core";
import { useLoad, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";
import { NOT_PUSHED, queueListPath, reviewDetailHref } from "../components/reviewQueue";

export { NOT_PUSHED, OTHER_QUEUES, QUEUES, isOtherQueue, isReceiptQueue, reviewHref } from "../components/reviewQueue";
export { QueueCount, queueBadge, useQueueCounts, type QueueBadge, type QueueCounts } from "../components/queueCounts";

/**
 * One receipt tab of the host's finance queue: the org's receipts in `queue` ("" is every
 * state). FINANCE works them; BOARD reads them. A receipt opens at /receipts/[id] carrying the queue.
 */
export function ReceiptQueueList({ queue }: { queue: string }) {
  const list = useLoad<ReceiptListRow[]>(queueListPath(queue));
  if (list.error) return <Alert color="red" mb="md">Couldn&apos;t load these receipts: {list.error}</Alert>;
  return list.data ? <ReceiptTable rows={list.data} delivery={queue === NOT_PUSHED} detailHref={(id) => reviewDetailHref(id, queue)} /> : null;
}
