"use client";

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { Badge, Button, Group, List, Modal, Stack, Table, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertBanner } from '@/components/admin/AlertBanner';
import { AdminEditHouseholdModal } from '@/components/admin/AdminEditHouseholdModal';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { formatDateOnly, orgCalendarDay } from '@/lib/time';

import { PageLoader } from "@/components/ui/PageLoader";
import { householdQueryMatcher, personQueryMatcher } from "@/lib/searchId";

type Household = {
  id: number;
  name?: string | null;
  orgMembership?: { status: string; memberSince?: string | null } | null;
  // Renewal season only: the coming cycle is already settled — the member finished
  // renewal, or an admin already used the override.
  settledForComingYear?: boolean;
  validUntil?: string | null;
  householdMembers?: { id: number; name?: string | null; email?: string | null; isBoardMember?: boolean; emailUndeliverableAt?: string | null }[] | null;
  renewalGrantable?: boolean;
  bgValidUntil?: string | null;
};

// Every date this renders (memberSince, validUntil, bgValidUntil) is a calendar
// date at UTC midnight, so it must be read UTC-pinned or it shows the day before.
const fmtDate = (s?: string | null) =>
  s ? formatDateOnly(s, { year: "numeric", month: "short", day: "numeric" }) : "—";
// An ACTIVE membership whose derived valid-until day is already behind today's org
// calendar day: dues for the live year were never settled. Status is untouched —
// revoking is a person's call.
const isLapsed = (validUntil?: string | null) => !!validUntil && new Date(validUntil).getTime() < orgCalendarDay().getTime();

export default function AdminHouseholdsPage() {
  const { user: me, ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember']);
  const router = useRouter();

  const [households, setHouseholds] = useState<Household[]>([]);
  const [renewalSeason, setRenewalSeason] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editHouseholdId, setEditHouseholdId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmDenyOpened, { open: openConfirmDeny, close: closeConfirmDeny }] = useDisclosure(false);
  const [pendingDenyHouseholdId, setPendingDenyHouseholdId] = useState<number | null>(null);
  const [grantComingYearOpened, { open: openGrantComingYear, close: closeGrantComingYear }] = useDisclosure(false);
  const [pendingGrantHouseholdId, setPendingGrantHouseholdId] = useState<number | null>(null);
  const [grantReason, setGrantReason] = useState("");

  const fetchHouseholds = useCallback(async () => {
    try {
      const res = await fetch('/api/membership-ops/households');
      if (res.ok) {
        const data = await res.json();
        setHouseholds(data.households);
        setRenewalSeason(data.renewalSeason ?? false);
      } else {
        setError("Failed to fetch households.");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready) fetchHouseholds();
  }, [ready, fetchHouseholds]);

  const toggleMembership = async (householdId: number, currentActive: boolean) => {
    try {
      const res = await fetch('/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId, active: !currentActive })
      });

      if (res.ok) {
        fetchHouseholds();
        notifications.show({ message: currentActive ? 'Membership revoked.' : 'Membership granted.' });
      } else {
        notifications.show({ color: 'red', message: 'Failed to update membership.', autoClose: false });
      }
    } catch {
      notifications.show({ color: 'red', message: 'Network error.', autoClose: false });
    }
  };

  // Renewal-season only: admin override that grants the household for the coming year
  // in one click (server creates a completed RENEWAL/INITIAL process). Same COI rules
  // as Grant Membership — the server rejects a board member's own household.
  const grantForComingYear = async (householdId: number, reason: string) => {
    try {
      const res = await fetch('/api/membership-ops/households', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId, comingYear: true, reason })
      });

      if (res.ok) {
        fetchHouseholds();
        notifications.show({ message: 'Granted for the coming year.' });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: 'red', message: data.error || 'Failed to grant for the coming year.', autoClose: false });
      }
    } catch {
      notifications.show({ color: 'red', message: 'Network error.', autoClose: false });
    }
  };

  const handleGrantForComingYear = (householdId: number) => {
    setPendingGrantHouseholdId(householdId);
    setGrantReason("");
    openGrantComingYear();
  };

  const confirmGrantForComingYear = async () => {
    if (pendingGrantHouseholdId === null || !grantReason.trim()) return;
    closeGrantComingYear();
    const householdId = pendingGrantHouseholdId;
    const reason = grantReason.trim();
    setPendingGrantHouseholdId(null);
    await grantForComingYear(householdId, reason);
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
              // Conflict of interest: no actor may GRANT their own household membership
              // (bypasses payment + background check). Mirrors the server guard; disabled
              // state is UX only. Revoke stays allowed.
              // Grant Membership only offers on non-members; the coming-year override applies
              // to existing members too, so it needs the conflict regardless of current status.
              const ownHouseholdConflict = sharesHousehold(me?.householdId, household.id);
              const ownGrantBlocked = !hasActiveMembership && ownHouseholdConflict;
              const hasBrokenEmail = household.householdMembers?.some((p) => p.emailUndeliverableAt) ?? false;
              // Staff households (@innovationtreehouse.org) aren't program families: block
              // adding participants and granting membership. Revoke stays allowed.
              const isStaffHousehold = household.householdMembers?.some(
                (p) => p.email?.toLowerCase().endsWith('@innovationtreehouse.org')
              ) ?? false;
              const settledForComingYear = household.settledForComingYear === true;

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
                    ) : hasActiveMembership && isLapsed(household.validUntil) ? (
                      <Tooltip label="Active, but no dues for the current membership year are recorded here">
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
                    <Text c={isLapsed(household.validUntil) ? "red" : undefined} fw={isLapsed(household.validUntil) ? 700 : undefined}>
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
                          onClick={() => setDenied(household.id, false)}
                        >
                          Restore Access
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="xs" fz={15}
                            variant="light"
                            color={hasActiveMembership ? 'red' : 'treehouseGreen'}
                            disabled={ownGrantBlocked || (!hasActiveMembership && isStaffHousehold)}
                            title={
                              !hasActiveMembership && isStaffHousehold
                                ? "Staff households can't be granted membership."
                                : ownGrantBlocked
                                  ? "You can't grant your own household's membership — someone outside your household must."
                                  : undefined
                            }
                            onClick={() => toggleMembership(household.id, hasActiveMembership)}
                          >
                            {hasActiveMembership ? "Revoke Membership" : "Grant Membership"}
                          </Button>
                          <Button
                            size="xs" fz={15}
                            variant="outline"
                            color="red"
                            disabled={hasBoardMember}
                            title={hasBoardMember ? "Remove the board role before denying membership" : undefined}
                            onClick={() => setDenied(household.id, true)}
                          >
                            Deny Membership
                          </Button>
                        </>
                      )}
                    </Group>
                    {/* Three states: hidden unless actionable-or-settled (not started, mid-flow,
                        stale BG, staff, COI, out of season all hide); a settled cycle shows a
                        disabled "Granted for coming year" as positive confirmation (#1047); a
                        grantable renewal (PENDING_PAYMENT + cleared, fresh BG) shows it live. */}
                    {renewalSeason && !isDenied && !isStaffHousehold && !ownHouseholdConflict && (household.renewalGrantable || settledForComingYear) && (
                      <Button
                        size="xs" fz={15}
                        variant="light"
                        disabled={settledForComingYear}
                        title={settledForComingYear ? "This household is already set for the coming year." : undefined}
                        onClick={() => handleGrantForComingYear(household.id)}
                      >
                        {settledForComingYear ? "Granted for coming year" : "Grant for coming year"}
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
        opened={grantComingYearOpened}
        onClose={closeGrantComingYear}
        title={<Text span fw={700} fz="lg">Grant for Coming Year</Text>}
        centered
      >
        <Text mb="sm">
          Grant this household&apos;s membership for the coming year, completing its payment gate
          without a Shopify payment.
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
          <Button variant="default" onClick={closeGrantComingYear}>Cancel</Button>
          <Button onClick={confirmGrantForComingYear} disabled={!grantReason.trim()}>Grant</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
