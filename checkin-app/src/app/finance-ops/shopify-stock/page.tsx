"use client";

import { useState, useEffect, useCallback } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useRequireRole } from '@/hooks/useRequireRole';
import { FINANCE_TOOL_ROLES } from '@/lib/nav/sections/revenueOps';
import { useOrgTime } from '@/components/TimezoneProvider';
import { PageLoader } from "@/components/ui/PageLoader";

// Shopify stock writes that could not be confirmed (lib/shopify.ts parks each one
// and never re-sends it), one row per write. The board checks the program in
// Shopify and settles each one: the write landed, or it didn't and is owed again.
type Row = {
  programId: number;
  programName: string;
  unconfirmed: number;
  carry: number;
  unconfirmedSince: string | null;
  shopifyAvailable: number | null;
};
type Choice = 'landed' | 'notLanded';

const seats = (n: number) => `${n > 0 ? '+' : ''}${n} seat${Math.abs(n) === 1 ? '' : 's'}`;

export default function UnconfirmedShopifyStockPage() {
  const { formatDateTime } = useOrgTime();
  const { ready, loading: authLoading } = useRequireRole(FINANCE_TOOL_ROLES);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [target, setTarget] = useState<{ row: Row; choice: Choice } | null>(null);

  const fetchRows = useCallback(() => fetch('/api/finance-ops/shopify-stock')
    .then(async (res) => {
      if (res.ok) {
        setRows(await res.json());
        setMessage("");
      } else {
        setMessage("Failed to load unconfirmed Shopify stock. You may not have access.");
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error loading unconfirmed Shopify stock.", autoClose: false });
    })
    .finally(() => setLoading(false)),
  []);

  useEffect(() => {
    if (ready) fetchRows();
  }, [ready, fetchRows]);

  const settle = async () => {
    if (!target) return;
    const { row, choice } = target;
    setTarget(null);
    try {
      const res = await fetch(`/api/finance-ops/shopify-stock/${row.programId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice, expected: row.unconfirmed, since: row.unconfirmedSince }),
      });
      if (res.ok) {
        fetchRows();
        notifications.show({
          message: choice === 'landed'
            ? `${row.programName}: cleared — Shopify already has the change.`
            : `${row.programName}: the change is owed again and will be pushed to Shopify.`,
        });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: 'red', message: data.error || "Action failed.", autoClose: 6000 });
        fetchRows();
      }
    } catch {
      notifications.show({ color: 'red', message: "Network error.", autoClose: false });
    }
  };

  if (authLoading || loading) return <PageLoader />;
  if (!ready) return null;

  const columns: DataTableColumn<Row>[] = [
    { header: 'Program', sortBy: (r) => r.programName.toLowerCase(), render: (r) => <Text fw={500}>{r.programName}</Text> },
    { header: 'Unconfirmed change', sortBy: (r) => r.unconfirmed, render: (r) => <Text>{seats(r.unconfirmed)}</Text> },
    {
      header: 'Unconfirmed since',
      sortBy: (r) => r.unconfirmedSince ?? '',
      render: (r) => <Text size="sm" c="dimmed">{r.unconfirmedSince ? formatDateTime(r.unconfirmedSince) : 'Unknown'}</Text>,
    },
    { header: 'Shopify available now', render: (r) => <Text>{r.shopifyAvailable ?? 'Unreadable'}</Text> },
    { header: 'Still owed (carry)', render: (r) => <Text>{r.carry}</Text> },
    {
      header: 'Actions',
      align: 'right',
      render: (r) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          <Button size="xs" fz={15} variant="default" onClick={() => setTarget({ row: r, choice: 'notLanded' })}>
            Shopify doesn&apos;t have it
          </Button>
          <Button size="xs" fz={15} color="blue" onClick={() => setTarget({ row: r, choice: 'landed' })}>
            Shopify has it
          </Button>
        </Group>
      ),
    },
  ];

  return (
    <Stack>
      <Text c="dimmed">
        A stock change for these programs was sent to Shopify, but Shopify never confirmed whether it
        landed, so the app will not re-send it. Check the program&apos;s stock in the Shopify admin, then
        settle it: <strong>Shopify has it</strong> clears it with no change to Shopify;{' '}
        <strong>Shopify doesn&apos;t have it</strong> puts it back on what the app owes, and the next push sends it.
      </Text>

      <AlertBanner message={message} tone="error" />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => `${r.programId}-${r.unconfirmedSince ?? 'earlier'}-${r.unconfirmed}`}
        emptyMessage="No unconfirmed Shopify stock changes."
      />

      <Modal
        opened={target !== null}
        onClose={() => setTarget(null)}
        title={<Text span fw={700} fz="lg">{target?.choice === 'landed' ? 'Shopify has the change' : "Shopify doesn't have the change"}</Text>}
        centered
      >
        {target && (
          <Text mb="lg">
            {target.choice === 'landed'
              ? <>Clear the unconfirmed {seats(target.row.unconfirmed)} for <strong>{target.row.programName}</strong>. Shopify is not changed.</>
              : <>Owe the {seats(target.row.unconfirmed)} for <strong>{target.row.programName}</strong> again. The app pushes it to Shopify next.</>}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setTarget(null)}>Cancel</Button>
          <Button color="blue" onClick={settle}>Confirm</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
