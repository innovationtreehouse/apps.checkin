"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Group, SegmentedControl, Select, Title } from "@mantine/core";
import { useLoad, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";
import { OTHER_QUEUES, QUEUES, isOtherQueue, parseQueue, queueListPath, reviewDetailHref, reviewHref } from "../components/reviewQueue";

/**
 * /receipts/review — the org's receipts by queue. FINANCE works them; BOARD reads them. The
 * segments are the queues FINANCE works; "Other states" reaches every remaining state.
 */
export default function ReceiptsReviewPage() {
  const router = useRouter();
  const queue = parseQueue(useSearchParams().get("queue"));
  const list = useLoad<ReceiptListRow[]>(queueListPath(queue));
  const show = (q: string) => router.replace(reviewHref(q), { scroll: false });
  return (
    <>
      <Title order={3} mb="md">Receipts review</Title>
      <Group mb="md" align="center">
        <SegmentedControl value={queue} onChange={show} data={QUEUES} />
        <Select
          aria-label="Other states"
          placeholder="Other states"
          data={OTHER_QUEUES}
          value={isOtherQueue(queue) ? queue : null}
          onChange={(q) => q && show(q)}
          allowDeselect={false}
          w={260}
        />
      </Group>
      {list.error && <Alert color="red" mb="md">Couldn&apos;t load these receipts: {list.error}</Alert>}
      {list.data && <ReceiptTable rows={list.data} detailHref={(id) => reviewDetailHref(id, queue)} />}
    </>
  );
}
