"use client";
import { useState } from "react";
import { Alert, Checkbox, Group, Title } from "@mantine/core";
import { useLoad, type ReceiptListRow } from "../components/api";
import ReceiptTable from "../components/ReceiptTable";

/**
 * /receipts — the caller's own receipts, each with its state and, when owed, whether
 * QuickBooks shows it paid. "Hide completed" starts unchecked and is not remembered.
 */
export default function MyReceiptsPage() {
  const [hideCompleted, setHideCompleted] = useState(false);
  const mine = useLoad<ReceiptListRow[]>(`/mine${hideCompleted ? "?hideCompleted=1" : ""}`);
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={3}>My receipts</Title>
        <Checkbox label="Hide completed" checked={hideCompleted} onChange={(e) => setHideCompleted(e.currentTarget.checked)} />
      </Group>
      {mine.error && <Alert color="red" mb="md">{mine.error}</Alert>}
      {mine.data && <ReceiptTable rows={mine.data} paid />}
    </>
  );
}
