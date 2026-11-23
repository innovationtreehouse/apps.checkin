"use client";

import { useState, useEffect, useCallback } from 'react';
import { Badge, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { errorMessage, HttpError, showError, showSuccess } from '@checkin/component-ui';
import { api } from '@/lib/api';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useRequireRole } from '@/hooks/useRequireRole';
import { FINANCE_TOOL_ROLES } from '@/lib/nav/sections/revenueOps';
import { relTime } from '@/lib/time';
import { useOrgTime } from '@/components/TimezoneProvider';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { formatCents } from '@checkin/money';
import { PageLoader } from "@/components/ui/PageLoader";
import { MatchAuditPanel } from "@/components/admin/MatchAuditPanel";

// Mirrors the flat shape returned by GET /api/finance-ops/payments.
type PaymentException = {
  id: number;
  kind: string;
  severity: 'WARN' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  shopifyOrderId: string | null;
  processId: number | null;
  programId: number | null;
  personId: number | null;
  detectedAt: string;
  familyName: string | null;
  familyEmail: string | null;
  programName: string | null;
  detail: string | null;
  live: {
    financialStatus: string | null;
    totalCents: number;
    totalRefundedCents: number;
    cancelledAt: string | null;
  } | null;
};

// Mirrors GET /api/finance-ops/s-read/sync. `status` is s-read's enum, read verbatim
// — treat anything outside the known set as "no longer running" (see isTerminal).
type SyncRun = {
  status: string;
  kind: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

// The outcome of one status read. `ok: false` means the read itself failed (the mirror
// is unwired or unreadable); `{ ok: true, run: null }` means it succeeded and the mirror
// simply has no runs. Keeping them apart is the whole point — see fetchSyncRun.
type SyncFetch = { ok: true; run: SyncRun | null } | { ok: false };

// Polling budget after a manual sync: 20 × 6s ≈ 2 minutes. Bounded on purpose —
// every poll queries the mirror and keeps the scale-to-zero Aurora cluster awake,
// which is the cost that makes the automatic sync daily rather than continuous.
// A sync still running at the cap is not lost, just no longer watched;
// the status line picks it up on the next page load.
const POLL_INTERVAL_MS = 6_000;
const POLL_MAX_ATTEMPTS = 20;

// RUNNING is the only non-terminal state. COMPLETED / FAILED / ABANDONED all mean
// "stop watching" — ABANDONED being s-read's reaper relabelling a run whose process
// was killed, which is exactly why polling must not treat "not COMPLETED" as "keep
// waiting". An unrecognised status also stops: s-read owns this enum, and a value we
// do not know is not grounds to poll forever.
const isTerminal = (status: string) => status !== 'RUNNING';

/** "12 min ago · completed", or "· running" while in flight. */
function describeSync(run: SyncRun): string {
  const when = isTerminal(run.status) && run.finishedAt ? run.finishedAt : run.startedAt;
  return `${relTime(when)} · ${run.status.toLowerCase()}`;
}

export default function PaymentProblemsPage() {
  const { formatDateTime } = useOrgTime();
  const { ready, loading: authLoading } = useRequireRole(FINANCE_TOOL_ROLES);

  const [rows, setRows] = useState<PaymentException[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [resolveOpened, { open: openResolve, close: closeResolve }] = useDisclosure(false);
  const [pendingResolve, setPendingResolve] = useState<PaymentException | null>(null);
  const [note, setNote] = useState("");
  const [syncing, setSyncing] = useState(false);
  // The problem whose write is in flight; its buttons stay disabled so a second click can't send again.
  const [busyId, setBusyId] = useState<number | null>(null);
  // null = the mirror has never synced, or we can't read it — either way there is
  // nothing to say, so the status line just doesn't render.
  const [syncRun, setSyncRun] = useState<SyncRun | null>(null);

  // Read the status, keeping "couldn't read it" distinct from "read it; no runs yet".
  // Collapsing those into a bare null is what let the poll below report a failed read
  // as "still running" — a claim it had no basis for.
  const fetchSyncRun = useCallback((): Promise<SyncFetch> => fetch('/api/finance-ops/s-read/sync')
    .then(async (res): Promise<SyncFetch> => {
      // 503 (mirror not wired here) or 500 (mirror unreadable — e.g. the SELECT grant
      // isn't in place yet). Both mean: no status, and don't pretend otherwise.
      if (!res.ok) return { ok: false };
      const run: SyncRun | null = (await res.json()).run;
      setSyncRun(run);
      return { ok: true, run };
    })
    .catch((): SyncFetch => {
      // Freshness is decoration on this page; a failed status read must never
      // surface as an error over the queue itself.
      return { ok: false };
    }),
  []);

  const fetchRows = useCallback(() => fetch('/api/finance-ops/payments')
    .then(async (res) => {
      if (res.ok) {
        setRows(await res.json());
      } else {
        setMessage("Failed to load payment problems. You may not have access.");
      }
    })
    .catch(() => {
      showError("Network error loading payment problems.");
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (ready) {
      fetchRows();
      fetchSyncRun();
    }
  }, [ready, fetchRows, fetchSyncRun]);

  const patch = async (id: number, action: 'acknowledge' | 'resolve', noteText?: string) => {
    setBusyId(id);
    try {
      await api(`/api/finance-ops/payments/${id}`, { method: 'PATCH', body: JSON.stringify({ action, note: noteText }) });
      await fetchRows();
      notifyNavRefresh();
      showSuccess(action === 'resolve' ? 'Payment problem resolved.' : 'Payment problem acknowledged.');
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.status === 409) fetchRows();
    } finally {
      setBusyId(null);
    }
  };

  // Force an s-read incremental sync. The mirror behind "Live payment" refreshes once
  // a day, so a problem fixed in Shopify this morning still reads stale here until
  // tomorrow. The POST only STARTS the sync, so we then poll for the run it started and
  // refetch the table once it lands — "Live payment" reads straight from the mirror,
  // so those amounts can differ the moment the sync finishes.
  //
  // Note the queue ROWS themselves are the reconciler's output, not the sync's, and
  // the reconciler runs on its own daily tick — so a finished sync refreshes the live
  // amounts, but a problem it resolves stays listed until the next reconcile.
  const triggerSync = async () => {
    setSyncing(true);
    try {
      // The run in the mirror before the click. Only a run that started after it is
      // this click's; both timestamps come from s-read, so clock skew between the
      // browser, the app and the reader cannot misplace it. A run still RUNNING at the
      // click holds s-read's lock and the new request is skipped, so that run is the
      // one to follow.
      const before = await fetchSyncRun();
      await api('/api/finance-ops/s-read/sync', { method: 'POST' });
      showSuccess('Shopify sync started…');

      // The read failed — the mirror is unwired or unreadable. The sync itself was
      // started regardless (s-read is off doing it), so say exactly that: we cannot
      // watch it. Reporting "still running" here would be inventing a status, and it
      // would hide the actual fault behind a plausible sentence.
      const statusUnreadable = () => showError("Shopify sync started, but its status can't be read in this environment. Run diagnostics on the System Status page to see why.");
      if (!before.ok) {
        statusUnreadable();
        return;
      }
      const baseline = before.run;
      const alreadyRunning = baseline !== null && !isTerminal(baseline.status);
      const isBaseline = (run: SyncRun) =>
        baseline !== null && Date.parse(run.startedAt) === Date.parse(baseline.startedAt);
      const isFollowed = (run: SyncRun) =>
        !baseline || Date.parse(run.startedAt) > Date.parse(baseline.startedAt) || (alreadyRunning && isBaseline(run));
      let sawFollowedRun = alreadyRunning;

      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const res = await fetchSyncRun();
        if (!res.ok) {
          statusUnreadable();
          return;
        }

        // No followed run yet: s-read stamps a row when it starts, so keep waiting
        // rather than reporting an earlier run's result.
        if (!res.run || !isFollowed(res.run)) continue;
        sawFollowedRun = true;
        if (!isTerminal(res.run.status)) continue;

        const { status } = res.run;
        const subject = isBaseline(res.run) ? 'A sync was already running; it' : 'Shopify sync';
        await fetchRows();
        if (status === 'COMPLETED') {
          showSuccess(`${subject} finished. Live payment amounts are up to date.`);
        } else {
          showError(`${subject} ${status.toLowerCase()}. Live payment amounts may still be stale.`);
        }
        return;
      }
      if (!sawFollowedRun) {
        showError("The sync was requested but hasn't started yet. Check back in a few minutes.");
        return;
      }
      // The run is still going and nothing has failed, so this is a success message.
      showSuccess('Shopify sync is still running. Reload the page in a few minutes to see the result.');
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleResolve = (row: PaymentException) => {
    setPendingResolve(row);
    setNote("");
    openResolve();
  };

  const confirmResolve = async () => {
    if (!pendingResolve) return;
    closeResolve();
    const { id } = pendingResolve;
    setPendingResolve(null);
    await patch(id, 'resolve', note);
  };

  if (authLoading || loading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  const columns: DataTableColumn<PaymentException>[] = [
    {
      header: 'Severity',
      sortBy: (row) => row.severity,
      render: (row) => (
        <Badge color={row.severity === 'CRITICAL' ? 'red' : 'yellow'} variant="light">
          {row.severity}
        </Badge>
      ),
    },
    {
      header: 'Problem',
      sortBy: (row) => row.kind,
      render: (row) => (
        <>
          <Text fw={500}>{row.kind.replace(/_/g, ' ')}</Text>
          {row.programName && <Text size="sm" c="dimmed">{row.programName}</Text>}
          {row.detail && <Text size="sm" c="dimmed">{row.detail}</Text>}
        </>
      ),
    },
    {
      header: 'Family',
      sortBy: (row) => row.familyName?.toLowerCase() ?? row.familyEmail?.toLowerCase() ?? '',
      render: (row) => (
        <>
          <Text fw={500}>{row.familyName ?? '—'}</Text>
          {row.familyEmail && <Text size="sm" c="dimmed">{row.familyEmail}</Text>}
        </>
      ),
    },
    {
      header: 'Live payment',
      render: (row) =>
        row.live ? (
          <>
            <Text size="sm">{row.live.financialStatus ?? 'unknown'}</Text>
            <Text size="sm" c="dimmed">
              {formatCents(row.live.totalCents)}
              {row.live.totalRefundedCents > 0 && ` (−${formatCents(row.live.totalRefundedCents)} refunded)`}
              {row.live.cancelledAt && ' · cancelled'}
            </Text>
          </>
        ) : (
          <Text size="sm" c="dimmed">{row.shopifyOrderId ? `Order ${row.shopifyOrderId}` : 'No order'}</Text>
        ),
    },
    {
      header: 'Detected',
      sortBy: (row) => row.detectedAt,
      render: (row) => <Text size="sm" c="dimmed">{formatDateTime(row.detectedAt)}</Text>,
    },
    {
      header: 'Actions',
      align: 'right',
      render: (row) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          {row.status === 'OPEN' && (
            <Button size="xs" fz={15} variant="light" disabled={busyId === row.id} onClick={() => patch(row.id, 'acknowledge')}>
              Acknowledge
            </Button>
          )}
          <Button size="xs" fz={15} variant="light" disabled={busyId === row.id} onClick={() => handleResolve(row)}>
            Resolve
          </Button>
        </Group>
      ),
    },
  ];

  return (
    <Stack>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text c="dimmed">
          Reconciler-detected Shopify payment problems awaiting board review. Nothing here is changed
          automatically — acknowledge to mark a problem as seen, or resolve once you&apos;ve handled it
          (e.g. in Shopify or on the membership record).
        </Text>
        <Button
          variant="light"
          onClick={triggerSync}
          loading={syncing}
          style={{ flexShrink: 0 }}
        >
          Sync Shopify now
        </Button>
      </Group>

      <Text size="sm" c="dimmed">
        Shopify data syncs automatically once a day. If you&apos;ve just changed something in Shopify
        and want it reflected here sooner, sync now.
        {syncRun && ` Last Shopify sync: ${describeSync(syncRun)}.`}
      </Text>

      <AlertBanner message={message} tone="error" />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        emptyMessage="No open payment problems."
      />

      <MatchAuditPanel />

      <Modal
        opened={resolveOpened}
        onClose={closeResolve}
        title={<Text span fw={700} fz="lg">Resolve Payment Problem</Text>}
        centered
      >
        <Text mb="sm">
          Mark this {pendingResolve?.kind.replace(/_/g, ' ').toLowerCase()} problem as resolved. Add a note
          describing what was done.
        </Text>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          placeholder="What did you do to resolve this? (optional)"
          autosize
          minRows={3}
          mb="lg"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeResolve}>Cancel</Button>
          <Button onClick={confirmResolve}>Resolve</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
