"use client";

import { useState, useEffect, useCallback } from 'react';
import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useRequireRole } from '@/hooks/useRequireRole';
import { FINANCE_SECTION_ROLES } from '@/lib/financeNav';
import { useOrgTime } from '@/components/TimezoneProvider';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { scholarshipRequestKindLabel } from '@/lib/scholarshipRequestKind';

import { PageLoader } from "@/components/ui/PageLoader";

type HouseholdLead = { id: number; name: string | null; email: string | null };

type MembershipPaymentPlanRequest = {
  id: number;
  stageEnteredAt: string | null;
  scholarshipRequestKind: string | null;
  orgMembership: {
    isVolunteer: boolean;
    household: {
      id: number;
      name: string;
      householdMembers?: HouseholdLead[];
    };
  };
};

export default function MembershipPaymentPlansPage() {
  const { formatDateTime } = useOrgTime();
  const { user: me, ready, loading: authLoading } = useRequireRole(FINANCE_SECTION_ROLES);

  const ownHousehold = (req: MembershipPaymentPlanRequest) =>
    sharesHousehold(me?.householdId, req.orgMembership.household.id);

  const [requests, setRequests] = useState<MembershipPaymentPlanRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [confirmApproveOpened, { open: openConfirmApprove, close: closeConfirmApprove }] = useDisclosure(false);
  const [pendingApproval, setPendingApproval] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [confirmDenyOpened, { open: openConfirmDeny, close: closeConfirmDeny }] = useDisclosure(false);
  const [pendingDenial, setPendingDenial] = useState<number | null>(null);
  const [denying, setDenying] = useState(false);

  const fetchRequests = useCallback(async () => {
    try {
      const res = await fetch('/api/finance-ops/membership-payment-plans');
      if (res.ok) {
        const data = await res.json();
        setRequests(data);
      } else {
        setMessage("Failed to load requests. You may not have access.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error loading requests.", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) fetchRequests();
  }, [ready, fetchRequests]);

  const handleApprove = (processId: number) => {
    setPendingApproval(processId);
    setReason("");
    openConfirmApprove();
  };

  const doApprove = async (processId: number, reason: string) => {
    try {
      const res = await fetch('/api/finance-ops/membership-payment-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processId, reason })
      });

      if (res.ok) {
        setRequests(prev => prev.filter(r => r.id !== processId));
        notifyNavRefresh();
      } else {
        const data = await res.json();
        if (data.error === "No pending payment-plan request") {
          notifications.show({ color: 'red', message: data.error, autoClose: 4000 });
          fetchRequests();
        } else {
          notifications.show({ color: 'red', message: data.error || "Failed to approve.", autoClose: false });
        }
      }
    } catch {
      notifications.show({ color: 'red', message: "Network error processing approval.", autoClose: false });
    }
  };

  const confirmApprove = async () => {
    if (pendingApproval === null || !reason.trim()) return;
    closeConfirmApprove();
    const processId = pendingApproval;
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
    try {
      const res = await fetch('/api/finance-ops/membership-payment-plans/refuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processId })
      });

      if (res.ok) {
        setRequests(prev => prev.filter(r => r.id !== processId));
        notifyNavRefresh();
        notifications.show({ message: 'Scholarship / payment plan denied.' });
      } else {
        const data = await res.json();
        if (res.status === 409) {
          notifications.show({ color: 'red', message: data.error, autoClose: 4000 });
          fetchRequests();
        } else {
          notifications.show({ color: 'red', message: data.error || "Failed to deny.", autoClose: false });
        }
      }
    } catch {
      notifications.show({ color: 'red', message: "Network error processing denial.", autoClose: false });
    } finally {
      setDenying(false);
    }
  };

  const confirmDeny = async () => {
    if (pendingDenial === null) return;
    const processId = pendingDenial;
    await doDeny(processId);
    setPendingDenial(null);
    closeConfirmDeny();
  };

  if (authLoading || loading) {
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
          <Text size="sm" c="dimmed">{req.orgMembership.isVolunteer ? 'Volunteer household' : 'Standard household'}</Text>
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
      header: 'Requested On',
      sortBy: (req) => req.stageEnteredAt ?? '', // ISO string sorts chronologically
      render: (req) => <Text size="sm" c="dimmed">{req.stageEnteredAt ? formatDateTime(req.stageEnteredAt) : '—'}</Text>,
    },
    {
      header: 'Actions',
      align: 'right',
      render: (req) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          <Button size="xs" fz={15} color="red" variant="light" disabled={ownHousehold(req)} title={ownHousehold(req) ? "You can't deny your own household's plan — someone outside your household must." : undefined} onClick={() => handleDeny(req.id)}>
            Deny
          </Button>
          <Button size="xs" fz={15} variant="light" disabled={ownHousehold(req)} title={ownHousehold(req) ? "You can't approve your own household's plan — someone outside your household must." : undefined} onClick={() => handleApprove(req.id)}>
            Approve &amp; Activate
          </Button>
        </Group>
      ),
    },
  ];

  return (
    <Stack>
      <Text c="dimmed">
        Review households that have requested a scholarship or payment plan for their membership
        fee. Approving a request activates the membership without a Shopify payment (it still holds
        for background clearance if that isn&apos;t done yet).
      </Text>

      <AlertBanner message={message} tone="error" />

      <DataTable
        columns={columns}
        rows={requests}
        getRowKey={(req) => `${req.id}`}
        emptyMessage="No pending membership scholarship or payment plan requests."
      />

      <Modal
        opened={confirmApproveOpened}
        onClose={closeConfirmApprove}
        title={<Text span fw={700} fz="lg">Approve Scholarship / Payment Plan</Text>}
        centered
      >
        <Text mb="sm">
          Approve this scholarship or payment plan? This activates the household&apos;s membership without a
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
