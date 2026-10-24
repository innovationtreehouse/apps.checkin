"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { PageLoader } from "@/components/ui/PageLoader";
import { useOrgTime } from "@/components/TimezoneProvider";
import { useRequireRole } from "@/hooks/useRequireRole";
import type { ReceiptFlowStatus, StateCount } from "@/lib/receiptFlow/status";
import { RECEIPT_FLOW_ROLES } from "@/lib/nav/sections/finance";

const UNREACHABLE = "Couldn't load the counts. Check your connection and try again.";

function Tile({ label, count }: { label: string; count: number }) {
  return (
    <Card withBorder padding="sm">
      <Text size="sm" c="dimmed">{label}</Text>
      <Text size="xl" fw={700}>{count}</Text>
    </Card>
  );
}

function Section({ title, section, extra }: { title: string; section: { states: StateCount[] } | null; extra?: StateCount }) {
  return (
    <Stack gap="xs" component="section" aria-label={title}>
      <Title order={3}>{title}</Title>
      {section ? (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }}>
          {section.states.map((s) => <Tile key={s.state} label={s.label} count={s.count} />)}
          {extra && <Tile label={extra.label} count={extra.count} />}
        </SimpleGrid>
      ) : (
        <Text c="dimmed">Not set up here.</Text>
      )}
    </Stack>
  );
}

/** How many receipts, receiving records and expenses sit in each state. Counts only. */
export default function ReceiptFlowStatusPage() {
  const { loading, ready } = useRequireRole(RECEIPT_FLOW_ROLES);
  const { formatDateTime } = useOrgTime();
  const [data, setData] = useState<ReceiptFlowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => fetch("/api/receipt-flow/status")
    .then(async (res) => {
      if (!res.ok) {
        setError(`Couldn't load the counts (error ${res.status}).`);
        return;
      }
      setData((await res.json()) as ReceiptFlowStatus);
      setError(null);
    })
    .catch(() => setError(UNREACHABLE)), []);

  useEffect(() => { if (ready) void load(); }, [ready, load]);

  if (loading) return <PageLoader />;
  if (!ready) return null;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Receipt flow status</Title>
          {data && <Text size="sm" c="dimmed">As of {formatDateTime(data.asOf)}</Text>}
        </div>
        <Button variant="default" onClick={() => void load()}>Refresh</Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {!data && !error && <PageLoader minHeight="20vh" />}
      {data && (
        <>
          {data.receipt !== undefined && (
            <Section
              title="Receipts"
              section={data.receipt}
              extra={data.receipt ? { state: "not_delivered", label: "Done, not yet sent to receiving", count: data.receipt.notDelivered } : undefined}
            />
          )}
          <Section title="Receiving" section={data.receiving} />
          {data.expense !== undefined && <Section title="Expenses" section={data.expense} />}
        </>
      )}
    </Stack>
  );
}
