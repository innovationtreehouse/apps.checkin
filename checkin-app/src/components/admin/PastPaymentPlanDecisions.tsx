"use client";

import { Button, Checkbox, Group, Stack, Text } from '@mantine/core';
import { LoadError, useUrlFilter, useUrlPage } from '@checkin/component-ui';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useOrgTime } from '@/components/TimezoneProvider';
import { PageLoader } from '@/components/ui/PageLoader';
import { useLoad } from '@/lib/api';
import { PAST_PAGE_SIZE } from '@/lib/finance/paymentPlanHistoryPage';

export type PaymentPlanDecisionRow = {
  id: string;
  outcome: 'APPROVED' | 'REFUSED';
  decidedAt: string | null;
  decidedByName: string | null;
};

/**
 * One page of decided payment-plan requests, newest first, from a `/past` endpoint. Decisions for
 * archived households are hidden unless the viewer ticks "Show archived families".
 */
export function PastPaymentPlanDecisions<T extends PaymentPlanDecisionRow>({ endpoint, identityColumns }: {
  endpoint: string;
  identityColumns: DataTableColumn<T>[];
}) {
  const { formatDateTime } = useOrgTime();
  const [page, setPage] = useUrlPage();
  const [archived, setArchived] = useUrlFilter('archived');
  const query = `page=${page - 1}${archived === '1' ? '&archived=1' : ''}`;
  // Each read logs a finance view, so it reads once per page shown, with no retry.
  const { data: rows, error, reload } = useLoad<T[]>(
    `${endpoint}?${query}`,
    { retry: false, reconnect: false, skipWriteReload: true },
  );

  const showArchived = (
    <Checkbox
      label="Show archived families"
      checked={archived === '1'}
      onChange={(e) => setArchived(e.currentTarget.checked ? '1' : '')}
    />
  );
  if (error) return <Stack>{showArchived}<LoadError what="past requests" message={error} onRetry={reload} /></Stack>;
  if (!rows) return <Stack>{showArchived}<PageLoader /></Stack>;

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
      {showArchived}
      <DataTable columns={columns} rows={rows} getRowKey={(row) => row.id} emptyMessage="No decided requests." />
      <Group justify="flex-end">
        <Button variant="default" size="xs" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</Button>
        <Button variant="default" size="xs" disabled={rows.length < PAST_PAGE_SIZE} onClick={() => setPage(page + 1)}>Older</Button>
      </Group>
    </Stack>
  );
}
