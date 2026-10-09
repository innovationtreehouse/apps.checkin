"use client";

import { useState, useEffect, useCallback } from 'react';
import { Badge, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useRequireRole } from '@/hooks/useRequireRole';
import { useOrgTime } from '@/components/TimezoneProvider';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { formatCents } from '@inventory/money';
import { landsNextYear } from '@/lib/programYear';
import { scholarshipRequestKindLabel } from '@/lib/scholarshipRequestKind';

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

export default function PendingParticipantsPage() {
  const { formatDateTime } = useOrgTime();
  const { user: me, ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember']);
  // Conflict of interest: no actor may approve their OWN household member's plan
  // (mirrors the server guard). UX only — server enforces.
  const ownHousehold = (req: PaymentPlanRequest) =>
    sharesHousehold(me?.householdId, req.person.householdId);

  const [requests, setRequests] = useState<PaymentPlanRequest[]>([]);
  const [cutoff, setCutoff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [confirmApproveOpened, { open: openConfirmApprove, close: closeConfirmApprove }] = useDisclosure(false);
  const [pendingApproval, setPendingApproval] = useState<{ programId: number; participantId: number } | null>(null);
  const [confirmRefuseOpened, { open: openConfirmRefuse, close: closeConfirmRefuse }] = useDisclosure(false);
  const [pendingRefusal, setPendingRefusal] = useState<{ programId: number; participantId: number } | null>(null);

  const fetchRequests = useCallback(async () => {
    try {
      const res = await fetch('/api/finance-ops/payment-plans');
      if (res.ok) {
        const data = await res.json();
        setRequests(data.ProgramParticipant ?? []);
        setCutoff(data.BoardSettings?.orgMembershipYearBoundary ?? null);
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

  const handleApprove = (programId: number, participantId: number) => {
    setPendingApproval({ programId, participantId });
    openConfirmApprove();
  };

  const doApprove = async (programId: number, participantId: number) => {
    try {
      const res = await fetch('/api/finance-ops/payment-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId, participantId })
      });

      if (res.ok) {
        setRequests(prev => prev.filter(r => !(r.programId === programId && r.personId === participantId)));
        notifyNavRefresh();
        notifications.show({ message: 'Scholarship / payment plan approved.' });
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
    try {
      const res = await fetch('/api/finance-ops/payment-plans/refuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId, participantId })
      });

      if (res.ok) {
        setRequests(prev => prev.filter(r => !(r.programId === programId && r.personId === participantId)));
        notifyNavRefresh();
        notifications.show({ message: 'Scholarship / payment plan refused.' });
      } else {
        const data = await res.json();
        if (data.error === "No pending payment-plan request") {
          notifications.show({ color: 'red', message: data.error, autoClose: 4000 });
          fetchRequests();
        } else {
          notifications.show({ color: 'red', message: data.error || "Failed to refuse.", autoClose: false });
        }
      }
    } catch {
      notifications.show({ color: 'red', message: "Network error processing refusal.", autoClose: false });
    }
  };

  const confirmRefuse = async () => {
    if (!pendingRefusal) return;
    closeConfirmRefuse();
    const { programId, participantId } = pendingRefusal;
    setPendingRefusal(null);
    await doRefuse(programId, participantId);
  };

  if (authLoading || loading) {
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
    {
      header: 'Actions',
      align: 'right',
      render: (req) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          <Button
            size="xs" fz={15} color="red" variant="light"
            disabled={ownHousehold(req)}
            title={ownHousehold(req) ? "You can't refuse your own household's plan — someone outside your household must." : undefined}
            onClick={() => handleRefuse(req.programId, req.personId)}
          >
            Refuse
          </Button>
          <Button
            size="xs" fz={15} variant="light"
            disabled={ownHousehold(req)}
            title={ownHousehold(req) ? "You can't approve your own household's plan — someone outside your household must." : undefined}
            onClick={() => handleApprove(req.programId, req.personId)}
          >
            Approve &amp; Mark Active
          </Button>
        </Group>
      ),
    },
  ];

  return (
    <Stack>
      <Text c="dimmed">
        Review pending participants who have requested a scholarship or payment plan.
        Approving a request marks the user as ACTIVE and exempts them from the 7-day automated
        removal cron job.
      </Text>

      <AlertBanner message={message} tone="error" />

      <DataTable
        columns={columns}
        rows={requests}
        getRowKey={(req) => `${req.programId}-${req.personId}`}
        emptyMessage="No pending scholarship or payment plan requests."
      />

      <Modal
        opened={confirmApproveOpened}
        onClose={closeConfirmApprove}
        title={<Text span fw={700} fz="lg">Approve Scholarship / Payment Plan</Text>}
        centered
      >
        <Text mb="lg">
          Approve this scholarship or payment plan? This sets the participant&apos;s status to ACTIVE and stops
          automated unpaid warning emails.
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
