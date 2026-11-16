"use client";

import { useState } from 'react';
import { Badge, Button, Group, Modal, SegmentedControl, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { PastPaymentPlanDecisions, type PaymentPlanDecisionRow } from '@/components/admin/PastPaymentPlanDecisions';
import { useRequireRole } from '@/hooks/useRequireRole';
import { PAYMENT_PLAN_ROLES } from '@/lib/nav/sections/revenueOps';
import { useOrgTime } from '@/components/TimezoneProvider';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { formatCents } from '@checkin/money';
import { landsNextYear } from '@/lib/programYear';
import { scholarshipRequestKindLabel } from '@/lib/scholarshipRequestKind';

import { errorMessage, HttpError, LoadError, showError, showSuccess, useUrlChoice } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { PageLoader } from "@/components/ui/PageLoader";
type HouseholdLead = { id: number; name: string | null; email: string | null };

type PaymentPlanRequest = {
  programId: number;
  personId: number;
  pendingSince: string;
  scholarshipRequestKind: string | null;
  person: {
    id: number;
    name: string | null;
    email: string;
    household?: {
      orgMembership?: { status: string } | null;
      householdMembers?: HouseholdLead[];
    } | null;
    householdId: number | null;
  };
  program: {
    id: number;
    name: string;
    orgMemberPriceCents: number | null;
    nonOrgMemberPriceCents: number | null;
    startAt: string | null;
  };
};

type PastProgramDecision = PaymentPlanDecisionRow & {
  personName: string | null;
  personEmail: string | null;
  programName: string | null;
};

const PAST_IDENTITY_COLUMNS: DataTableColumn<PastProgramDecision>[] = [
  {
    header: 'Participant',
    render: (row) => (
      <>
        <Text fw={500}>{row.personName}</Text>
        <Text size="sm" c="dimmed">{row.personEmail}</Text>
      </>
    ),
  },
  { header: 'Program', render: (row) => <Text fw={500}>{row.programName}</Text> },
];

const VIEWS = ['pending', 'past'] as const;

export default function PendingParticipantsPage() {
  const { formatDateTime } = useOrgTime();
  const { user: me, ready, loading: authLoading } = useRequireRole(PAYMENT_PLAN_ROLES);
  // Conflict of interest: no actor may approve their OWN household member's plan
  // (mirrors the server guard). UX only — server enforces.
  const ownHousehold = (req: PaymentPlanRequest) =>
    sharesHousehold(me?.householdId, req.person.householdId);

  const [view, setView] = useUrlChoice('view', VIEWS, 'pending');
  const [confirmApproveOpened, { open: openConfirmApprove, close: closeConfirmApprove }] = useDisclosure(false);
  const [pendingApproval, setPendingApproval] = useState<{ programId: number; participantId: number } | null>(null);
  const [confirmRefuseOpened, { open: openConfirmRefuse, close: closeConfirmRefuse }] = useDisclosure(false);
  const [pendingRefusal, setPendingRefusal] = useState<{ programId: number; participantId: number } | null>(null);
  // The row whose write is in flight; its buttons stay disabled so a second click can't send again.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const rowKey = (programId: number, participantId: number) => `${programId}-${participantId}`;

  // Each read logs a finance view, so it reads once on mount and once after this page's own write, with no retry.
  const { data, error: loadError, reload } = useLoad<{ ProgramParticipant?: PaymentPlanRequest[]; BoardSettings?: { orgMembershipYearBoundary?: string | null } | null }>(
    ready ? '/api/finance-ops/payment-plans' : null,
    { retry: false, reconnect: false, skipWriteReload: true },
  );
  const cutoff = data?.BoardSettings?.orgMembershipYearBoundary ?? null;

  const handleApprove = (programId: number, participantId: number) => {
    setPendingApproval({ programId, participantId });
    openConfirmApprove();
  };

  const doApprove = async (programId: number, participantId: number) => {
    setBusyKey(rowKey(programId, participantId));
    try {
      await api('/api/finance-ops/payment-plans', { method: 'POST', body: JSON.stringify({ programId, participantId }) });
      await reload();
      notifyNavRefresh();
      showSuccess('Scholarship / payment plan approved.');
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.status === 409) await reload();
    } finally {
      setBusyKey(null);
    }
  };

  const confirmApprove = async () => {
    if (!pendingApproval) return;
    closeConfirmApprove();
    const { programId, participantId } = pendingApproval;
    setPendingApproval(null);
    await doApprove(programId, participantId);
  };

  const handleRefuse = (programId: number, participantId: number) => {
    setPendingRefusal({ programId, participantId });
    openConfirmRefuse();
  };

  const doRefuse = async (programId: number, participantId: number) => {
    setBusyKey(rowKey(programId, participantId));
    try {
      await api('/api/finance-ops/payment-plans/refuse', { method: 'POST', body: JSON.stringify({ programId, participantId }) });
      await reload();
      notifyNavRefresh();
      showSuccess('Scholarship / payment plan refused.');
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.status === 409) await reload();
    } finally {
      setBusyKey(null);
    }
  };

  const confirmRefuse = async () => {
    if (!pendingRefusal) return;
    closeConfirmRefuse();
    const { programId, participantId } = pendingRefusal;
    setPendingRefusal(null);
    await doRefuse(programId, participantId);
  };

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  const leadEmails = (req: PaymentPlanRequest): string[] =>
    (req.person.household?.householdMembers ?? [])
      .map(l => l.email)
      .filter((e): e is string => !!e);

  const columns: DataTableColumn<PaymentPlanRequest>[] = [
    {
      header: 'Participant',
      sortBy: (req) => req.person.name?.toLowerCase() ?? req.person.email.toLowerCase(),
      render: (req) => (
        <>
          <Text fw={500}>{req.person.name}</Text>
          <Text size="sm" c="dimmed">{req.person.email}</Text>
        </>
      ),
    },
    {
      header: 'Family Email',
      render: (req) => {
        const emails = leadEmails(req);
        return emails.length
          ? emails.map(e => <Text key={e} size="sm">{e}</Text>)
          : <Text size="sm" c="dimmed">—</Text>;
      },
    },
    {
      header: 'Asked For',
      sortBy: (req) => scholarshipRequestKindLabel(req.scholarshipRequestKind).toLowerCase(),
      render: (req) => (
        <Text size="sm" c={req.scholarshipRequestKind ? undefined : 'dimmed'}>
          {scholarshipRequestKindLabel(req.scholarshipRequestKind)}
        </Text>
      ),
    },
    {
      header: 'Program',
      sortBy: (req) => req.program.name.toLowerCase(),
      render: (req) => (
        <>
          <Group gap="xs">
            <Text fw={500}>{req.program.name}</Text>
            {landsNextYear(req.program.startAt, cutoff) && (
              <Badge size="sm" color="orange" variant="light">Next year</Badge>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            Price: M {formatCents(req.program.orgMemberPriceCents)} / NM {formatCents(req.program.nonOrgMemberPriceCents)}
          </Text>
        </>
      ),
    },
    {
      header: 'Membership',
      render: (req) => (
        <Text size="sm">{req.person.household?.orgMembership?.status === 'ACTIVE' ? 'Member' : 'Non-member'}</Text>
      ),
    },
    {
      header: 'Requested On',
      sortBy: (req) => req.pendingSince, // ISO string sorts chronologically
      render: (req) => <Text size="sm" c="dimmed">{formatDateTime(req.pendingSince)}</Text>,
    },
    ...(!me?.isBoardMember ? [] : [{
      header: 'Actions',
      align: 'right' as const,
      render: (req: PaymentPlanRequest) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          <Button
            size="xs" fz={15} color="red" variant="light"
            disabled={ownHousehold(req) || busyKey === rowKey(req.programId, req.personId)}
            title={ownHousehold(req) ? "You can't refuse your own household's plan — someone outside your household must." : undefined}
            onClick={() => handleRefuse(req.programId, req.personId)}
          >
            Refuse
          </Button>
          <Button
            size="xs" fz={15} variant="light"
            disabled={ownHousehold(req) || busyKey === rowKey(req.programId, req.personId)}
            title={ownHousehold(req) ? "You can't approve your own household's plan — someone outside your household must." : undefined}
            onClick={() => handleApprove(req.programId, req.personId)}
          >
            Approve &amp; Mark Active
          </Button>
        </Group>
      ),
    }]),
  ];

  return (
    <Stack>
      <Text c="dimmed">
        Review pending participants who have requested a scholarship or payment plan.
        Approving a request sets the participant&apos;s enrollment to ACTIVE without a payment, and
        they keep the seat they took when they asked.
      </Text>

      <SegmentedControl
        value={view}
        onChange={setView}
        data={[{ label: 'Pending', value: 'pending' }, { label: 'Past', value: 'past' }]}
        style={{ alignSelf: 'flex-start' }}
      />

      {view === 'past' ? (
        <PastPaymentPlanDecisions<PastProgramDecision> endpoint="/api/finance-ops/payment-plans/past" identityColumns={PAST_IDENTITY_COLUMNS} />
      ) : loadError ? (
        <LoadError what="payment plan requests" message={loadError} onRetry={reload} />
      ) : !data ? (
        <PageLoader />
      ) : (
        <DataTable
          columns={columns}
          rows={data.ProgramParticipant ?? []}
          getRowKey={(req) => `${req.programId}-${req.personId}`}
          emptyMessage="No pending scholarship or payment plan requests."
        />
      )}

      <Modal
        opened={confirmApproveOpened}
        onClose={closeConfirmApprove}
        title={<Text span fw={700} fz="lg">Approve Scholarship / Payment Plan</Text>}
        centered
      >
        <Text mb="lg">
          Approve this scholarship or payment plan? This sets the participant&apos;s enrollment to ACTIVE without a
          payment, and they keep the seat they took when they asked.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmApprove}>Cancel</Button>
          <Button onClick={confirmApprove}>Approve &amp; Mark Active</Button>
        </Group>
      </Modal>

      <Modal
        opened={confirmRefuseOpened}
        onClose={closeConfirmRefuse}
        title={<Text span fw={700} fz="lg">Refuse Scholarship / Payment Plan</Text>}
        centered
      >
        <Text mb="lg">
          Refuse this request? The participant stays enrolled and can pay normally, withdraw, or re-request later.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmRefuse}>Cancel</Button>
          <Button color="red" onClick={confirmRefuse}>Refuse</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
