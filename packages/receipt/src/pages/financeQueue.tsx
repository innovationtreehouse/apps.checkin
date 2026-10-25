"use client";
import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
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
  const path = queueListPath(queue);
  const list = useLoad<ReceiptListRow[]>(path);
  useEffect(() => {
    if (!list.error) return;
    const server = /^(Internal Server Error|HTTP 5\d\d)$/.test(list.error);
    notifications.show({
      id: `receipt-queue-${queue || "all"}`,
      title: "Couldn't load these receipts",
      message: server ? `GET /api/receipts${path} failed on the server (HTTP 500); the server log names the cause under that route.` : `GET /api/receipts${path} answered: ${list.error}`,
      color: "red",
      autoClose: false,
    });
  }, [list.error, path, queue]);
  return list.data ? <ReceiptTable rows={list.data} delivery={queue === NOT_PUSHED} detailHref={(id) => reviewDetailHref(id, queue)} /> : null;
}
