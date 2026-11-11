"use client";

import { useState } from 'react';
import { Stack, TextInput } from '@mantine/core';
import { LoadError } from '@checkin/component-ui';
import { useRequireRole } from '@/hooks/useRequireRole';
import { useLoad } from '@/lib/api';
import { FACILITY_RECORD_ROLES } from '@/lib/nav/sections/facilityOps';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useOrgTime } from '@/components/TimezoneProvider';

import { PageLoader } from "@/components/ui/PageLoader";
type BadgeEvent = {
  id: number;
  timestamp: string;
  person?: { name?: string; email?: string };
  location?: string;
};

export default function AdminBadgesPage() {
  const { ready, loading: authLoading } = useRequireRole(FACILITY_RECORD_ROLES);
  const { formatDateTime } = useOrgTime();

  // Built here, not at module scope: the time column needs the org zone from context.
  const COLUMNS: DataTableColumn<BadgeEvent>[] = [
    { header: 'ID', render: (b) => b.id, sortBy: (b) => b.id },
    { header: 'Time', render: (b) => formatDateTime(b.timestamp), sortBy: (b) => b.timestamp },
    { header: 'Participant', render: (b) => b.person?.name || 'Unknown', sortBy: (b) => b.person?.name },
    { header: 'Email', render: (b) => b.person?.email, sortBy: (b) => b.person?.email },
    { header: 'Location', render: (b) => b.location || 'Front Door', sortBy: (b) => b.location },
  ];

  const { data, error, reload } = useLoad<{ badges: BadgeEvent[] }>(ready ? '/api/facility/badges' : null);
  const [searchTerm, setSearchTerm] = useState('');

  if (authLoading) return <PageLoader />;
  if (!ready) return null;
  if (error) return <LoadError what="badge events" message={error} onRetry={reload} />;
  if (!data) return <PageLoader />;

  const { badges } = data;
  const multiLocation = new Set(badges.map((b) => b.location).filter(Boolean)).size > 1;
  const term = searchTerm.trim().toLowerCase();
  const visible = term
    ? badges.filter((b) =>
        [b.id, b.person?.name, b.person?.email, multiLocation ? b.location : null].some((v) =>
          String(v ?? '').toLowerCase().includes(term),
        ),
      )
    : badges;

  return (
    <Stack>
      <TextInput
        placeholder={multiLocation ? "Filter by name, email, location, or ID..." : "Filter by name, email, or ID..."}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.currentTarget.value)}
      />

      <DataTable columns={COLUMNS} rows={visible} getRowKey={(b) => b.id} emptyMessage="No badge events." />
    </Stack>
  );
}
