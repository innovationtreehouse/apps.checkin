"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, SegmentedControl, Title } from "@mantine/core";
import { useLoad, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";
import { QUEUES, parseQueue, reviewDetailHref, reviewHref } from "../components/reviewQueue";

/** /receipts/review — the org's receipts by queue. FINANCE works them; BOARD reads them. */
export default function ReceiptsReviewPage() {
  const router = useRouter();
  const queue = parseQueue(useSearchParams().get("queue"));
  const list = useLoad<ReceiptListRow[]>(queue ? `?state=${queue}` : "");
  return (
    <>
      <Title order={3} mb="md">Receipts review</Title>
      <SegmentedControl mb="md" value={queue} onChange={(q) => router.replace(reviewHref(q), { scroll: false })} data={QUEUES} />
      {list.error && <Alert color="red" mb="md">{list.error}</Alert>}
      {list.data && <ReceiptTable rows={list.data} detailHref={(id) => reviewDetailHref(id, queue)} />}
    </>
  );
}
