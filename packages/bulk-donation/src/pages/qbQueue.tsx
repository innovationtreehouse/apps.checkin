"use client";
import { Alert, Anchor, Title } from "@mantine/core";

/** /donations/qb-queue — income now matches and books every Benevity deposit; this points finance there. */
export default function QbQueuePage() {
  return (
    <>
      <Title order={3} mb="md">QuickBooks queue</Title>
      <Alert color="blue">
        Income now matches and books every Benevity disbursement&apos;s deposit. Resolve them in{" "}
        <Anchor href="/income/reconciliation">income&apos;s reconciliation queue</Anchor>, where each shows Benevity as its source.
      </Alert>
    </>
  );
}
