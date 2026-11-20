"use client";

import { useState } from 'react';
import { Button, Group, Modal, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { PastPaymentPlanDecisions, type PaymentPlanDecisionRow } from '@/components/admin/PastPaymentPlanDecisions';
import { useRequireRole } from '@/hooks/useRequireRole';
import { PAYMENT_PLAN_ROLES } from '@/lib/nav/sections/revenueOps';
import { useOrgTime } from '@/components/TimezoneProvider';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { scholarshipRequestKindLabel } from '@/lib/scholarshipRequestKind';
import { endedPaymentPlanYearRefusal, membershipYearLabel } from '@/lib/programYear';

import { errorMessage, HttpError, LoadError, showError, showSuccess, useUrlChoice } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { PageLoader } from "@/components/ui/PageLoader";

type HouseholdLead = { id: number; name: string | null; email: string | null };

type MembershipPaymentPlanRequest = {
  id: number;
  stageEnteredAt: string | null;
  scholarshipRequestKind: string | null;
  paymentPlanYear: number | null;
  orgMembership: {
    isVolunteerFamily: boolean;
    household: {
      id: number;
      name: string;
      householdMembers?: HouseholdLead[];
    };
  };
};

type QueuePayload = {
  OrgMembershipProcess: MembershipPaymentPlanRequest[];
  BoardSettings: { orgMembershipYearBoundary: string | null } | null;
};

type PastMembershipDecision = PaymentPlanDecisionRow & { householdName: string | null };

const PAST_IDENTITY_COLUMNS: DataTableColumn<PastMembershipDecision>[] = [
  { header: 'Household', render: (row) => <Text fw={500}>{row.householdName}</Text> },
];

const VIEWS = ['pending', 'past'] as const;

const yearText = (year: number | null) => (year == null ? '—' : membershipYearLabel(year));

export default function MembershipPaymentPlansPage() {
  const { formatDateTime } = useOrgTime();
  const { user: me, ready, loading: authLoading } = useRequireRole(PAYMENT_PLAN_ROLES);

  const ownHousehold = (req: MembershipPaymentPlanRequest) =>
    sharesHousehold(me?.householdId, req.orgMembership.household.id);

  const [view, setView] = useUrlChoice('view', VIEWS, 'pending');
  const [confirmApproveOpened, { open: openConfirmApprove, close: closeConfirmApprove }] = useDisclosure(false);
  const [pendingApproval, setPendingApproval] = useState<MembershipPaymentPlanRequest | null>(null);
  const [reason, setReason] = useState("");
  const [confirmDenyOpened, { open: openConfirmDeny, close: closeConfirmDeny }] = useDisclosure(false);
  const [pendingDenial, setPendingDenial] = useState<number | null>(null);
  const [denying, setDenying] = useState(false);
  // The request whose write is in flight; its buttons stay disabled so a second click can't send again.
  const [busyId, setBusyId] = useState<number | null>(null);

  // Each read logs a finance view, so it reads once on mount and once after this page's own write, with no retry.
  const { data, error: loadError, reload } = useLoad<QueuePayload>(
    ready ? '/api/finance-ops/membership-payment-plans' : null,
    { retry: false, reconnect: false, skipWriteReload: true },
  );

  const handleApprove = (req: MembershipPaymentPlanRequest) => {
    setPendingApproval(req);
    setReason("");
    openConfirmApprove();
  };

  const doApprove = async (processId: number, reason: string) => {
    setBusyId(processId);
    try {
      await api('/api/finance-ops/membership-payment-plans', { method: 'POST', body: JSON.stringify({ processId, reason }) });
      await reload();
      notifyNavRefresh();
      showSuccess('Scholarship / payment plan approved.');
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.status === 409) await reload();
    } finally {
      setBusyId(null);
    }
  };

  const confirmApprove = async () => {
    if (pendingApproval === null || !reason.trim()) return;
    closeConfirmApprove();
    const processId = pendingApproval.id;
    const reasonToSend = reason.trim();
    setPendingApproval(null);
    await doApprove(processId, reasonToSend);
  };

  const handleDeny = (processId: number) => {
    setPendingDenial(processId);
    openConfirmDeny();
  };

  const doDeny = async (processId: number) => {
    setDenying(true);
    setBusyId(processId);
    try {
      await api('/api/finance-ops/membership-payment-plans/refuse', { method: 'POST', body: JSON.stringify({ processId }) });
      await reload();
      notifyNavRefresh();
      showSuccess('Scholarship / payment plan denied.');
    } catch (e) {
      showError(errorMessage(e));
      if (e instanceof HttpError && e.status === 409) await reload();
    } finally {
      setDenying(false);
      setBusyId(null);
    }
  };

  const confirmDeny = async () => {
    if (pendingDenial === null) return;
    const processId = pendingDenial;
    await doDeny(processId);
    setPendingDenial(null);
    closeConfirmDeny();
  };

  const requests = data?.OrgMembershipProcess;
  const boundary = data?.BoardSettings?.orgMembershipYearBoundary;
  // The server refuses approval for an ended year with 409; this only greys the button out first.
  const yearEnded = (req: MembershipPaymentPlanRequest) =>
    endedPaymentPlanYearRefusal(req.paymentPlanYear, boundary ? new Date(boundary) : null, new Date());

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) return null;

  const leadEmails = (req: MembershipPaymentPlanRequest): string[] =>
    (req.orgMembership.household.householdMembers ?? [])
      .map(l => l.email)
      .filter((e): e is string => !!e);

  const columns: DataTableColumn<MembershipPaymentPlanRequest>[] = [
    {
      header: 'Household',
      sortBy: (req) => req.orgMembership.household.name.toLowerCase(),
      render: (req) => (
        <>
          <Text fw={500}>{req.orgMembership.household.name}</Text>
          <Text size="sm" c="dimmed">{req.orgMembership.isVolunteerFamily ? 'Volunteer household' : 'Standard household'}</Text>
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
      header: 'Membership Year',
      sortBy: (req) => req.paymentPlanYear ?? 0,
      render: (req) => <Text size="sm">{yearText(req.paymentPlanYear)}</Text>,
    },
    {
      header: 'Requested On',
      sortBy: (req) => req.stageEnteredAt ?? '', // ISO string sorts chronologically
      render: (req) => <Text size="sm" c="dimmed">{req.stageEnteredAt ? formatDateTime(req.stageEnteredAt) : '—'}</Text>,
    },
    ...(!me?.isBoardMember ? [] : [{
      header: 'Actions',
      align: 'right' as const,
      render: (req: MembershipPaymentPlanRequest) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          <Button size="xs" fz={15} color="red" variant="light" disabled={ownHousehold(req) || busyId === req.id} title={ownHousehold(req) ? "You can't deny your own household's plan — someone outside your household must." : undefined} onClick={() => handleDeny(req.id)}>
            Deny
          </Button>
          <Button size="xs" fz={15} variant="light" disabled={ownHousehold(req) || !!yearEnded(req) || busyId === req.id} title={ownHousehold(req) ? "You can't approve your own household's plan — someone outside your household must." : yearEnded(req) ?? undefined} onClick={() => handleApprove(req)}>
            Approve &amp; Activate
          </Button>
        </Group>
      ),
    }]),
  ];

  return (
    <Stack>
      <Text c="dimmed">
        Review households that have requested a scholarship or payment plan for their membership
        fee. Approving a request activates the membership without a Shopify payment (it still holds
        for background clearance if that isn&apos;t done yet).
      </Text>

      <SegmentedControl
        value={view}
        onChange={setView}
        data={[{ label: 'Pending', value: 'pending' }, { label: 'Past', value: 'past' }]}
        style={{ alignSelf: 'flex-start' }}
      />

      {view === 'past' ? (
        <PastPaymentPlanDecisions<PastMembershipDecision> endpoint="/api/finance-ops/membership-payment-plans/past" identityColumns={PAST_IDENTITY_COLUMNS} />
      ) : loadError ? (
        <LoadError what="membership payment plan requests" message={loadError} onRetry={reload} />
      ) : !requests ? (
        <PageLoader />
      ) : (
        <DataTable
          columns={columns}
          rows={requests}
          getRowKey={(req) => `${req.id}`}
          emptyMessage="No pending membership scholarship or payment plan requests."
        />
      )}

      <Modal
        opened={confirmApproveOpened}
        onClose={closeConfirmApprove}
        title={<Text span fw={700} fz="lg">Approve Scholarship / Payment Plan</Text>}
        centered
      >
        <Text mb="sm" fw={500}>Membership year: {yearText(pendingApproval?.paymentPlanYear ?? null)}</Text>
        <Text mb="sm">
          Approve this scholarship or payment plan for that year? This activates the household&apos;s membership without a
          Shopify payment (holding for background clearance if it isn&apos;t done yet).
        </Text>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          label="Reason"
          placeholder="Why is this being certified?"
          autosize
          minRows={3}
          mb="lg"
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmApprove}>Cancel</Button>
          <Button onClick={confirmApprove} disabled={!reason.trim()}>Approve &amp; Activate</Button>
        </Group>
      </Modal>

      <Modal
        opened={confirmDenyOpened}
        onClose={closeConfirmDeny}
        title={<Text span fw={700} fz="lg">Deny Scholarship / Payment Plan</Text>}
        centered
      >
        <Text mb="lg">
          Deny this request? The household stays awaiting payment and can still pay their membership fee
          normally to activate, or re-request later. No automatic email is sent — contact the
          household to let them know.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmDeny} disabled={denying}>Cancel</Button>
          <Button color="red" onClick={confirmDeny} disabled={denying} loading={denying}>Deny</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
