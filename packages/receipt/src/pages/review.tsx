"use client";
import { useState } from "react";
import { Alert, SegmentedControl, Title } from "@mantine/core";
import { useLoad, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";

const QUEUES = [
  { value: "financial_review", label: "Finance review" },
  { value: "duplicate_flagged", label: "Duplicates" },
  { value: "validation_failed", label: "Totals off" },
  { value: "ocr_failed", label: "Unreadable" },
  { value: "flow_error", label: "Errors" },
  { value: "", label: "All" },
];

/** /receipts/review — the org's receipts by queue. FINANCE works them; BOARD reads them. */
export default function ReceiptsReviewPage() {
  const [queue, setQueue] = useState("financial_review");
  const list = useLoad<ReceiptListRow[]>(queue ? `?state=${queue}` : "");
  return (
    <>
      <Title order={3} mb="md">Receipts review</Title>
      <SegmentedControl mb="md" value={queue} onChange={setQueue} data={QUEUES} />
      {list.error && <Alert color="red" mb="md">{list.error}</Alert>}
      {list.data && <ReceiptTable rows={list.data} />}
    </>
  );
}
