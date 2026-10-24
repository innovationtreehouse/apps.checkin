"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Group, SegmentedControl, Select, Title } from "@mantine/core";
import { useLoad, useRoles, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";
import { QueueCount, queueBadge, useQueueCounts } from "../components/queueCounts";
import { NOT_PUSHED, OTHER_QUEUES, QUEUES, isOtherQueue, parseQueue, queueListPath, reviewDetailHref, reviewHref } from "../components/reviewQueue";

/**
 * /receipts/review — the org's receipts by queue. FINANCE works them; BOARD reads them. The
 * segments are the queues FINANCE works; "Other states" reaches every remaining state.
 */
export default function ReceiptsReviewPage() {
  const router = useRouter();
  const queue = parseQueue(useSearchParams().get("queue"));
  const list = useLoad<ReceiptListRow[]>(queueListPath(queue));
  const { counts, error: countsError } = useQueueCounts();
  const { isFinance } = useRoles();
  const badge = (q: string) => queueBadge(q, counts, isFinance);
  const show = (q: string) => router.replace(reviewHref(q), { scroll: false });
  return (
    <>
      <Title order={3} mb="md">Receipts review</Title>
      <Group mb="md" align="center">
        <SegmentedControl
          value={queue}
          onChange={show}
          data={QUEUES.map((q) => ({
            value: q.value,
            label: (
              <Group gap={6} wrap="nowrap" justify="center">
                {q.label}
                <QueueCount badge={badge(q.value)} />
              </Group>
            ),
          }))}
        />
        <Select
          aria-label="Other states"
          placeholder="Other states"
          data={OTHER_QUEUES}
          value={isOtherQueue(queue) ? queue : null}
          onChange={(q) => q && show(q)}
          renderOption={({ option }) => (
            <Group gap={6} wrap="nowrap">
              {option.label}
              <QueueCount badge={badge(option.value)} />
            </Group>
          )}
          allowDeselect={false}
          w={260}
        />
        {isOtherQueue(queue) && <QueueCount badge={badge(queue)} />}
      </Group>
      {countsError && <Alert color="red" mb="md">Couldn&apos;t load the queue counts: {countsError}</Alert>}
      {list.error && <Alert color="red" mb="md">Couldn&apos;t load these receipts: {list.error}</Alert>}
      {list.data && <ReceiptTable rows={list.data} delivery={queue === NOT_PUSHED} detailHref={(id) => reviewDetailHref(id, queue)} />}
    </>
  );
}
