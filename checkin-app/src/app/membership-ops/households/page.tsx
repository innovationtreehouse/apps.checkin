"use client";

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { MEMBERSHIP_OPS_ADMIN_ROLES } from '@/lib/nav/sections/membershipOps';
import { Badge, Button, Group, List, Modal, Stack, Table, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { AdminEditHouseholdModal } from '@/components/admin/AdminEditHouseholdModal';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { formatDateOnly } from '@/lib/time';
import { isMembershipLapsed } from '@/lib/membership/lapsed';

import { PageLoader } from "@/components/ui/PageLoader";
import { householdQueryMatcher, personQueryMatcher } from "@/lib/searchId";

type GrantYear = { year: number; label: string };

type Household = {
  id: number;
  name?: string | null;
  orgMembership?: { status: string; memberSince?: string | null } | null;
  // The live year is already settled: the member paid, or the Board granted it.
  settledForComingYear?: boolean;
  validUntil?: string | null;
  householdMembers?: { id: number; name?: string | null; email?: string | null; isBoardMember?: boolean; emailUndeliverableAt?: string | null }[] | null;
  // An application (joining or renewing) is at PENDING_PAYMENT: granting certifies it.
  awaitingPayment?: boolean;
  bgValidUntil?: string | null;
};

// Every date this renders (memberSince, validUntil, bgValidUntil) is a calendar
// date at UTC midnight, so it must be read UTC-pinned or it shows the day before.
const fmtDate = (s?: string | null) =>
  s ? formatDateOnly(s, { year: "numeric", month: "short", day: "numeric" }) : "—";

export default function AdminHouseholdsPage() {
  const { user: me, ready, loading: authLoading } = useRequireRole(MEMBERSHIP_OPS_ADMIN_ROLES);
  // Certifying a payment is Board-only (the server 403s a sysadmin), so a Grant that
  // would certify is hidden from anyone else. One that only opens an application stays.
  const isBoard = me?.isBoardMember === true;
  const router = useRouter();

  const [households, setHouseholds] = useState<Household[]>([]);
  // The year in progress and, inside the renewal window, the coming year.
  const [[yearInProgress, comingYear], setGrantYears] = useState<(GrantYear | undefined)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editHouseholdId, setEditHouseholdId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmDenyOpened, { open: openConfirmDeny, close: closeConfirmDeny }] = useDisclosure(false);
  const [pendingDenyHouseholdId, setPendingDenyHouseholdId] = useState<number | null>(null);
  const [grantOpened, { open: openGrantModal, close: closeGrantModal }] = useDisclosure(false);
  const [pendingGrantHouseholdId, setPendingGrantHouseholdId] = useState<number | null>(null);
  const [grantReason, setGrantReason] = useState("");
  // The year the reason modal confirms.
  const [pendingGrantYear, setPendingGrantYear] = useState<GrantYear | null>(null);

  const fetchHouseholds = useCallback(() => fetch('/api/membership-ops/households')
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setHouseholds(data.households);
        setGrantYears(data.grantYears ?? []);
      } else {
        setError("Failed to fetch households.");
      }
    })
    .catch(() => {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    if (ready) fetchHouseholds();
  }, [ready, fetchHouseholds]);

  const revokeMembership = async (householdId: number) => {
    try {
      const res = await fetch('/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId, active: false })
      });

      if (res.ok) {
        fetchHouseholds();
        notifications.show({ message: 'Membership revoked.' });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: 'red', message: data.error || 'Failed to update membership.', autoClose: false });
      }
    } catch {
      notifications.show({ color: 'red', message: 'Network error.', autoClose: false });
    }
  };

  // A grant pays an application (money only) and records the year on its button. The
  // background check still applies, and the server rejects a board member's own household.
  const grant = async (householdId: number, reason: string, grantYear: GrantYear) => {
    try {
      const res = await fetch('/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId, year: grantYear.year, reason })
      });

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        fetchHouseholds();
        notifications.show({ message: data.message || `Granted ${grantYear.label}.` });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: 'red', message: data.error || 'Failed to grant membership.', autoClose: false });
      }
    } catch {
      notifications.show({ color: 'red', message: 'Network error.', autoClose: false });
    }
  };

  const openGrant = (householdId: number, grantYear: GrantYear) => {
    setPendingGrantYear(grantYear);
    setPendingGrantHouseholdId(householdId);
    setGrantReason("");
    openGrantModal();
  };

  const confirmGrant = async () => {
    if (pendingGrantHouseholdId === null || pendingGrantYear === null || !grantReason.trim()) return;
    closeGrantModal();
    const householdId = pendingGrantHouseholdId;
    const reason = grantReason.trim();
    setPendingGrantHouseholdId(null);
    await grant(householdId, reason, pendingGrantYear);
  };

  // Deny blocks login for every member of the household; restore (deny=false) returns it
  // to NONE so they can log in again with no privileges. Separate from grant/revoke.
  const setDenied = async (householdId: number, deny: boolean) => {
    if (deny) {
      setPendingDenyHouseholdId(householdId);
      openConfirmDeny();
      return;
    }
    await doSetDenied(householdId, false);
  };

  const doSetDenied = async (householdId: number, deny: boolean) => {
    try {
      const res = await fetch('/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId, deny })
      });

      if (res.ok) {
        fetchHouseholds();
        notifications.show({ message: deny ? 'Membership denied — members can no longer log in.' : 'Membership restored.' });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: 'red', message: data.error || 'Failed to update membership.', autoClose: false });
      }
    } catch {
      notifications.show({ color: 'red', message: 'Network error.', autoClose: false });
    }
  };

  const confirmDeny = async () => {
    if (pendingDenyHouseholdId === null) return;
    closeConfirmDeny();
    const householdId = pendingDenyHouseholdId;
    setPendingDenyHouseholdId(null);
    await doSetDenied(householdId, true);
  };

  if (authLoading || loading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  // An unnamed household is listed as "Household #id", so that is what its name
  // has to match on.
  const matchesHousehold = householdQueryMatcher(filter);
  const matchesPerson = personQueryMatcher(filter);
  const filtered = households.filter((h) =>
    matchesHousehold({ id: h.id, name: h.name || `Household #${h.id}` }) ||
    (h.householdMembers?.some(matchesPerson) ?? false)
  );

  return (
    <Stack>
      <Text c="dimmed">
        View all households and toggle their official facility Membership status. Memberships grant
        shop access and other organizational privileges. Denying membership blocks login for every
        member of the household — a household containing a board member must have that role removed first.
      </Text>

      <AlertBanner message={error} tone="error" />

      <TextInput
        placeholder="Filter by household or participant name, email, or ID"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        maw={400}
      />

      <Table.ScrollContainer minWidth={600}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Household</Table.Th>
              <Table.Th>Participants</Table.Th>
              <Table.Th>Is Member?</Table.Th>
              <Table.Th>Member since</Table.Th>
              <Table.Th>Valid until</Table.Th>
              <Table.Th>BG valid until</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filtered.map((household) => {
              const status = household.orgMembership?.status;
              const hasActiveMembership = status === "ACTIVE";
              const isDenied = status === "DENIED";
              const hasBoardMember = household.householdMembers?.some((p) => p.isBoardMember) ?? false;
              // Conflict of interest: no actor may grant, revoke, deny or restore their own
              // household. Mirrors the server guard; disabled state is UX only.
              const ownHouseholdConflict = sharesHousehold(me?.householdId, household.id);
              const ownHouseholdTitle = "You can't change your own household's membership — someone outside your household must.";
              const hasBrokenEmail = household.householdMembers?.some((p) => p.emailUndeliverableAt) ?? false;
              // Staff households (@innovationtreehouse.org) aren't program families: block
              // adding participants and granting membership. Revoke stays allowed.
              const isStaffHousehold = household.householdMembers?.some(
                (p) => p.email?.toLowerCase().endsWith('@innovationtreehouse.org')
              ) ?? false;
              const settledForComingYear = household.settledForComingYear === true;
              const awaitingPayment = household.awaitingPayment === true;
              const showGrantInProgress = !!yearInProgress && (isBoard || !awaitingPayment) &&
                (!hasActiveMembership || (!isStaffHousehold && (awaitingPayment || isMembershipLapsed(household.validUntil))));

              return (
                <Table.Tr key={household.id}>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Text
                        fw={600}
                        c="blue"
                        style={{ cursor: "pointer" }}
                        onClick={() => router.push(`/membership-ops/households/${household.id}`)}
                      >
                        {household.name || `Household #${household.id}`}
                      </Text>
                      {hasBrokenEmail && (
                        <Tooltip label="A member's email is undeliverable — update their address">
                          <Badge color="red" variant="filled" size="sm" style={{ cursor: "default" }}>
                            ✉ Broken email
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {household.householdMembers && household.householdMembers.length > 0 ? (
                      <List size="sm">
                        {household.householdMembers.map((p) => (
                          <List.Item key={p.id}>
                            {p.name || p.email}
                            {p.emailUndeliverableAt && (
                              <Tooltip label="This email bounced or was marked spam — undeliverable">
                                <Text span c="red" fw={700} ml={4}>✉ undeliverable</Text>
                              </Tooltip>
                            )}
                          </List.Item>
                        ))}
                      </List>
                    ) : (
                      <Text size="sm" c="dimmed" fs="italic">Empty</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {isDenied ? (
                      <Text c="red" fw={700}>Denied</Text>
                    ) : hasActiveMembership && isMembershipLapsed(household.validUntil) ? (
                      <Tooltip label="Active, but no membership fee for the current membership year is recorded here">
                        <Text c="orange" fw={700} style={{ cursor: "default" }}>Lapsed</Text>
                      </Tooltip>
                    ) : hasActiveMembership ? (
                      <Text c="green" fw={700}>Yes</Text>
                    ) : (
                      <Text c="dimmed">No</Text>
                    )}
                  </Table.Td>
                  <Table.Td>{fmtDate(household.orgMembership?.memberSince)}</Table.Td>
                  <Table.Td>
                    <Text c={isMembershipLapsed(household.validUntil) ? "red" : undefined} fw={isMembershipLapsed(household.validUntil) ? 700 : undefined}>
                      {fmtDate(household.validUntil)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{fmtDate(household.bgValidUntil)}</Table.Td>
                  <Table.Td>
                    <Stack gap="xs" align="flex-start">
                    <Group gap="xs" wrap="nowrap">
                      <Button
                        size="xs" fz={15}
                        variant="light"
                        onClick={() => setEditHouseholdId(household.id)}
                      >
                        Edit Info
                      </Button>
                      <Button
                        size="xs" fz={15}
                        variant="light"
                        disabled={isStaffHousehold}
                        title={isStaffHousehold ? "Staff households can't add participants." : undefined}
                        onClick={() => router.push(`/membership-ops/participants/new?householdId=${household.id}`)}
                      >
                        + Add Participant
                      </Button>
                      {isDenied ? (
                        <Button
                          size="xs" fz={15}
                          variant="light"
                          color="blue"
                          disabled={ownHouseholdConflict}
                          title={ownHouseholdConflict ? ownHouseholdTitle : undefined}
                          onClick={() => setDenied(household.id, false)}
                        >
                          Restore Access
                        </Button>
                      ) : (
                        <>
                          {hasActiveMembership && <Button
                            size="xs" fz={15}
                            variant="light"
                            color="red"
                            disabled={ownHouseholdConflict}
                            title={ownHouseholdConflict ? ownHouseholdTitle : undefined}
                            onClick={() => revokeMembership(household.id)}
                          >
                            Revoke Membership
                          </Button>}
                          {showGrantInProgress && <Button
                            size="xs" fz={15}
                            variant="light"
                            color="treehouseGreen"
                            disabled={ownHouseholdConflict || isStaffHousehold}
                            title={
                              isStaffHousehold
                                ? "Staff households can't be granted membership."
                                : ownHouseholdConflict
                                  ? ownHouseholdTitle
                                  : undefined
                            }
                            onClick={() => openGrant(household.id, yearInProgress)}
                          >
                            Grant {yearInProgress.label}
                          </Button>}
                          <Button
                            size="xs" fz={15}
                            variant="outline"
                            color="red"
                            disabled={hasBoardMember || ownHouseholdConflict}
                            title={hasBoardMember ? "Remove the board role before denying membership" : ownHouseholdConflict ? ownHouseholdTitle : undefined}
                            onClick={() => setDenied(household.id, true)}
                          >
                            Deny Membership
                          </Button>
                        </>
                      )}
                    </Group>
                    {/* Inside the renewal window only. A settled live year shows as a disabled
                        confirmation; an application awaiting payment shows it live. */}
                    {comingYear && isBoard && !isDenied && !isStaffHousehold && !ownHouseholdConflict && (awaitingPayment || settledForComingYear) && (
                      <Button
                        size="xs" fz={15}
                        variant="light"
                        disabled={settledForComingYear}
                        title={settledForComingYear ? "This household is already set for this year." : undefined}
                        onClick={() => openGrant(household.id, comingYear)}
                      >
                        {settledForComingYear ? "Granted" : "Grant"} {comingYear.label}
                      </Button>
                    )}
                    </Stack>
                  </Table.Td>
                </Table.Tr>
              );
            })}

            {filtered.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={7} ta="center">
                  <Text c="dimmed" py="md">No households found.</Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <AdminEditHouseholdModal
        householdId={editHouseholdId}
        opened={editHouseholdId !== null}
        onClose={() => setEditHouseholdId(null)}
        onSaved={() => fetchHouseholds()}
      />

      <Modal
        opened={confirmDenyOpened}
        onClose={closeConfirmDeny}
        title={<Text span fw={700} fz="lg">Deny Membership</Text>}
        centered
      >
        <Text mb="lg">Deny membership for this household? Every member will be unable to log in.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmDeny}>Cancel</Button>
          <Button color="red" onClick={confirmDeny}>Deny Membership</Button>
        </Group>
      </Modal>

      <Modal
        opened={grantOpened}
        onClose={closeGrantModal}
        title={<Text span fw={700} fz="lg">Grant {pendingGrantYear?.label}</Text>}
        centered
      >
        <Text mb="sm">
          Mark this household&apos;s application as paid for {pendingGrantYear?.label} without a Shopify payment. The membership becomes active once its background check clears; if there is no application yet, one is opened for the family to complete.
        </Text>
        <Textarea
          value={grantReason}
          onChange={(e) => setGrantReason(e.currentTarget.value)}
          label="Reason"
          placeholder="Why is this being granted?"
          autosize
          minRows={3}
          mb="lg"
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeGrantModal}>Cancel</Button>
          <Button onClick={confirmGrant} disabled={!grantReason.trim()}>Grant</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
