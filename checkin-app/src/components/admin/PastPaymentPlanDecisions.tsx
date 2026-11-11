"use client";

import { useEffect, useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useOrgTime } from '@/components/TimezoneProvider';
import { PageLoader } from '@/components/ui/PageLoader';
import { PAST_PAGE_SIZE } from '@/lib/finance/paymentPlanHistoryPage';

export type PaymentPlanDecisionRow = {
  id: string;
  outcome: 'APPROVED' | 'REFUSED';
  decidedAt: string | null;
  decidedByName: string | null;
};

/** One page of decided payment-plan requests, newest first, from a `/past` endpoint. */
export function PastPaymentPlanDecisions<T extends PaymentPlanDecisionRow>({ endpoint, identityColumns }: {
  endpoint: string;
  identityColumns: DataTableColumn<T>[];
}) {
  const { formatDateTime } = useOrgTime();
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState<{ page: number; rows: T[]; error: string } | null>(null);

  useEffect(() => {
    fetch(`${endpoint}?page=${page}`)
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const rows: T[] = await res.json();
        setLoaded({ page, rows, error: '' });
      })
      .catch(() => setLoaded({ page, rows: [], error: 'Failed to load past requests.' }));
  }, [endpoint, page]);

  if (loaded?.page !== page) return <PageLoader />;
  const { rows, error } = loaded;

  const columns: DataTableColumn<T>[] = [
    ...identityColumns,
    {
      header: 'Outcome',
      render: (row) => (
        <Text size="sm" c={row.outcome === 'APPROVED' ? 'green' : 'red'}>
          {row.outcome === 'APPROVED' ? 'Approved' : 'Refused'}
        </Text>
      ),
    },
    {
      header: 'Decided By',
      render: (row) => <Text size="sm" c={row.decidedByName ? undefined : 'dimmed'}>{row.decidedByName ?? 'Not recorded'}</Text>,
    },
    {
      header: 'Decided On',
      render: (row) => <Text size="sm" c="dimmed">{row.decidedAt ? formatDateTime(row.decidedAt) : 'Not recorded'}</Text>,
    },
  ];

  return (
    <Stack>
      <AlertBanner message={error} tone="error" />
      <DataTable columns={columns} rows={rows} getRowKey={(row) => row.id} emptyMessage="No decided requests." />
      <Group justify="flex-end">
        <Button variant="default" size="xs" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
        <Button variant="default" size="xs" disabled={rows.length < PAST_PAGE_SIZE} onClick={() => setPage(page + 1)}>Older</Button>
      </Group>
    </Stack>
  );
}
