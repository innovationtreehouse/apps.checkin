"use client";

import { useState } from "react";
import { Badge, Button, Card, Group, List, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { errorMessage, showError, showSuccess } from "@checkin/component-ui";
import { api } from "@/lib/api";

interface StockResult { name: string; ok: boolean }
interface SwitchReply {
  programStore?: { zeroed?: StockResult[]; unhidden?: string[]; recounted?: StockResult[] };
}

/**
 * Board-only: closes or reopens the store to program seats (the claim-first trial).
 * Closed, seats are claimed in the app only and every public program item is hidden.
 */
export function ProgramStoreCard({ initialClosedAt }: { initialClosedAt: string | null }) {
  const [closedAt, setClosedAt] = useState(initialClosedAt);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[]>([]);

  const send = async (programStore: "close" | "open") => {
    setBusy(true);
    try {
      const data = await api<SwitchReply>("/api/settings/membership", {
        method: "PUT",
        body: JSON.stringify({ programStore }),
      });
      if (!data?.programStore) {
        showError("The store switch failed");
        return;
      }
      const { zeroed = [], unhidden = [], recounted = [] } = data.programStore;
      const failed = [...zeroed, ...recounted].filter((r) => !r.ok).map((r) => `Stock not confirmed in Shopify: ${r.name}`);
      setReport([...failed, ...unhidden.map((name) => `Hide not confirmed yet (the daily run retries): ${name}`)]);
      setClosedAt(programStore === "close" ? new Date().toISOString() : null);
      showSuccess(programStore === "close" ? "Store closed to program seats." : "Store reopened. Re-list each program's item in Shopify by hand.");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = (programStore: "close" | "open") => modals.openConfirmModal({
    title: programStore === "close" ? "Close the store to program seats?" : "Reopen the store to program seats?",
    children: (
      <Text size="sm">
        {programStore === "close"
          ? "Every public program item goes to draft in Shopify with its stock at 0. Families claim in the app and pay on the reserved-seat item."
          : "Each open program's stock is re-counted to capacity minus seats taken. Re-list each public item in Shopify by hand afterwards."}
      </Text>
    ),
    labels: { confirm: programStore === "close" ? "Close the store" : "Reopen the store", cancel: "Cancel" },
    confirmProps: { color: "orange" },
    onConfirm: () => send(programStore),
  });

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={3} mb="xs">Program seats in the store</Title>
      <Group gap="sm" mb="sm">
        {closedAt
          ? <Badge color="orange" variant="light">Closed since {new Date(closedAt).toLocaleDateString()}</Badge>
          : <Badge color="green" variant="light">Store sells seats</Badge>}
      </Group>
      {report.length > 0 && (
        <List size="sm" mb="sm">{report.map((line) => <List.Item key={line}>{line}</List.Item>)}</List>
      )}
      <Button variant="light" color="orange" loading={busy} onClick={() => confirm(closedAt ? "open" : "close")} style={{ alignSelf: "flex-start" }}>
        {closedAt ? "Reopen the store" : "Close the store"}
      </Button>
    </Card>
  );
}
