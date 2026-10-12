"use client";

import { useState, useEffect, useCallback } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { DataTable, type DataTableColumn } from '@/components/admin/DataTable';
import { useRequireRole } from '@/hooks/useRequireRole';
import { useOrgTime } from '@/components/TimezoneProvider';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { PageLoader } from "@/components/ui/PageLoader";

// The Shopify reconciliation queue: PENDING_HOLD_FAILED rows only (the apply-time
// Shopify -1 failed, so isPaymentPlanRequested=true but no seat was ever removed —
// inventoryHeldAt is null). Disjoint from the scholarship queue by construction
// (same endpoint, ?queue=holds). The safe resolution is "Confirm manual hold":
// the board member removes the seat in Shopify BY HAND, then confirms here, which
// records the hold and hands the row back to the normal approve/deny flow.
type HoldFailedRow = {
  programId: number;
  personId: number;
  pendingSince: string;
  person: { id: number; name: string | null; email: string; householdId: number | null };
  program: { id: number; name: string };
};

type Target = { programId: number; participantId: number } | null;

export default function ShopifyHoldsPage() {
  const { formatDateTime } = useOrgTime();
  const { user: me, ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember']);
  // Conflict of interest mirrors the scholarship queue: no actor may approve/deny
  // their OWN household's request (server enforces; this is UX). It does NOT gate
  // the manual-hold action — that confers no benefit.
  const ownHousehold = (row: HoldFailedRow) =>
    sharesHousehold(me?.householdId, row.person.householdId);

  const [rows, setRows] = useState<HoldFailedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [holdOpened, { open: openHold, close: closeHold }] = useDisclosure(false);
  const [approveOpened, { open: openApprove, close: closeApprove }] = useDisclosure(false);
  const [denyOpened, { open: openDeny, close: closeDeny }] = useDisclosure(false);
  const [target, setTarget] = useState<Target>(null);

  const fetchRows = useCallback(() => fetch('/api/finance-ops/payment-plans?queue=holds')
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setRows(data.ProgramParticipant ?? []);
      } else {
        setMessage("Failed to load the reconciliation queue. You may not have access.");
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error loading the reconciliation queue.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (ready) fetchRows();
  }, [ready, fetchRows]);

  const drop = (programId: number, participantId: number) =>
    setRows(prev => prev.filter(r => !(r.programId === programId && r.personId === participantId)));

  // One POST helper for all three actions — each moves the row OUT of this queue
  // (manual-hold → scholarship queue; approve → ACTIVE; deny → denied), so all
  // three drop it from the list on success.
  const post = async (url: string, successMsg: string) => {
    if (!target) return;
    const { programId, participantId } = target;
    setTarget(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId, participantId }),
      });
      if (res.ok) {
        drop(programId, participantId);
        notifyNavRefresh();
        notifications.show({ message: successMsg });
      } else {
        const data = await res.json();
        notifications.show({ color: 'red', message: data.error || "Action failed.", autoClose: 4000 });
        fetchRows();
      }
    } catch {
      notifications.show({ color: 'red', message: "Network error.", autoClose: false });
    }
  };

  const openFor = (row: HoldFailedRow, which: 'hold' | 'approve' | 'deny') => {
    setTarget({ programId: row.programId, participantId: row.personId });
    ({ hold: openHold, approve: openApprove, deny: openDeny })[which]();
  };

  if (authLoading || loading) return <PageLoader />;
  if (!ready) return null;

  const columns: DataTableColumn<HoldFailedRow>[] = [
    {
      header: 'Participant',
      sortBy: (r) => r.person.name?.toLowerCase() ?? r.person.email.toLowerCase(),
      render: (r) => (
        <>
          <Text fw={500}>{r.person.name}</Text>
          <Text size="sm" c="dimmed">{r.person.email}</Text>
        </>
      ),
    },
    {
      header: 'Program',
      sortBy: (r) => r.program.name.toLowerCase(),
      render: (r) => <Text fw={500}>{r.program.name}</Text>,
    },
    {
      header: 'Requested On',
      sortBy: (r) => r.pendingSince,
      render: (r) => <Text size="sm" c="dimmed">{formatDateTime(r.pendingSince)}</Text>,
    },
    {
      header: 'Actions',
      align: 'right',
      render: (r) => (
        <Group justify="flex-end" gap="xs" wrap="nowrap">
          <Button
            size="xs" fz={15} color="red" variant="subtle"
            disabled={ownHousehold(r)}
            title={ownHousehold(r) ? "You can't deny your own household's plan — someone outside your household must." : undefined}
            onClick={() => openFor(r, 'deny')}
          >
            Deny (override)
          </Button>
          <Button
            size="xs" fz={15} color="red" variant="subtle"
            disabled={ownHousehold(r)}
            title={ownHousehold(r) ? "You can't approve your own household's plan — someone outside your household must." : undefined}
            onClick={() => openFor(r, 'approve')}
          >
            Approve (override)
          </Button>
          <Button size="xs" fz={15} color="blue" onClick={() => openFor(r, 'hold')}>
            Confirm manual hold
          </Button>
        </Group>
      ),
    },
  ];

  return (
    <Stack>
      <Text c="dimmed">
        These scholarship / payment-plan requests were recorded, but the automatic Shopify
        seat reservation failed — <strong>no seat has been removed from Shopify yet</strong>.
        The applicant has done everything required; it is the board&apos;s job to finish placing
        the hold. Remove the seat in Shopify by hand, then use <strong>Confirm manual hold</strong>.
      </Text>

      <AlertBanner message={message} tone="error" />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => `${r.programId}-${r.personId}`}
        emptyMessage="No failed seat holds to reconcile."
      />

      {/* Confirm manual hold — the safe path. */}
      <Modal
        opened={holdOpened}
        onClose={closeHold}
        title={<Text span fw={700} fz="lg">Confirm manual seat hold</Text>}
        centered
      >
        <Text mb="md">
          Only confirm this <strong>after</strong> you have removed one seat for this program in the
          Shopify admin by hand. This records that the seat is held; it does <strong>not</strong> change
          Shopify itself.
        </Text>
        <Text mb="lg" size="sm" c="dimmed">
          Once confirmed, the request moves to the Program Payment Plan queue for the normal approve or deny.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeHold}>Cancel</Button>
          <Button color="blue" onClick={() => { closeHold(); post('/api/finance-ops/payment-plans/manual-hold', 'Manual hold recorded — request moved to the payment-plan queue.'); }}>
            I&apos;ve removed the seat — confirm
          </Button>
        </Group>
      </Modal>

      {/* Approve override — dangerous: no seat is held, so approving comps a phantom seat. */}
      <Modal
        opened={approveOpened}
        onClose={closeApprove}
        title={<Text span fw={700} fz="lg" c="red">Approve without a held seat?</Text>}
        centered
      >
        <Alert color="red" mb="md">
          No Shopify seat is held for this request. Approving now comps a seat that was never
          taken out of Shopify — the program can then oversell.
        </Alert>
        <Text mb="lg">
          The correct fix is <strong>Confirm manual hold</strong> on this Shopify Hold Reconciliation
          queue first (remove the seat in Shopify, then record it), which returns the request to the
          normal approval flow. Override only if you deliberately intend to comp this seat.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeApprove}>Go back</Button>
          <Button color="red" onClick={() => { closeApprove(); post('/api/finance-ops/payment-plans', 'Approved (override) — no seat was held.'); }}>
            Override &amp; approve anyway
          </Button>
        </Group>
      </Modal>

      {/* Deny override — same red gate; denial without a held seat is also deliberate. */}
      <Modal
        opened={denyOpened}
        onClose={closeDeny}
        title={<Text span fw={700} fz="lg" c="red">Deny without a held seat?</Text>}
        centered
      >
        <Alert color="red" mb="md">
          No Shopify seat is held for this request. This row is here because the seat reservation
          failed, not because the applicant did anything wrong.
        </Alert>
        <Text mb="lg">
          Prefer <strong>Confirm manual hold</strong> on this Shopify Hold Reconciliation queue so the
          request can be judged on the normal payment-plan queue. Override only if you intend to deny
          the request outright.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeDeny}>Go back</Button>
          <Button color="red" onClick={() => { closeDeny(); post('/api/finance-ops/payment-plans/refuse', 'Denied (override).'); }}>
            Override &amp; deny anyway
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
