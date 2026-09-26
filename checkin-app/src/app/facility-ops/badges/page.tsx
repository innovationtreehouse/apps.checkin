"use client";

import { useState, useEffect, useCallback } from 'react';
import { Stack, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useRequireRole } from '@/hooks/useRequireRole';
import { FACILITY_RECORD_ROLES } from '@/lib/facilityNav';
import { AlertBanner, type AlertTone } from '@/components/admin/AlertBanner';
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

  const [loading, setLoading] = useState(true);
  const [badges, setBadges] = useState<BadgeEvent[]>([]);
  const [message, setMessage] = useState<{ text: string; tone: AlertTone } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchBadges = useCallback(async () => {
    try {
      const res = await fetch('/api/facility/badges');
      if (res.ok) {
        const data = await res.json();
        setBadges(data.badges);
      } else {
        setMessage({ text: "Failed to load badge events.", tone: "error" });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error loading badges.", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) fetchBadges();
  }, [ready, fetchBadges]);

  if (authLoading || loading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  const term = searchTerm.trim().toLowerCase();
  const visible = term
    ? badges.filter((b) =>
        [b.id, b.person?.name, b.person?.email, b.location || 'Front Door'].some((v) =>
          String(v ?? '').toLowerCase().includes(term),
        ),
      )
    : badges;

  return (
    <Stack>
      <AlertBanner message={message?.text} tone={message?.tone} />

      <TextInput
        placeholder="Filter by name, email, location, or ID..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.currentTarget.value)}
      />

      <DataTable columns={COLUMNS} rows={visible} getRowKey={(b) => b.id} emptyMessage="No badge events." />
    </Stack>
  );
}
