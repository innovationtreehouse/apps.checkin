"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { MEMBERSHIP_OPS_ADMIN_ROLES } from '@/lib/nav/sections/membershipOps';
import { Badge, Button, Group, List, Modal, Stack, Table, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { clearError, errorMessage, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';
import { AdminEditHouseholdModal } from '@/components/admin/AdminEditHouseholdModal';
import { sharesHousehold } from '@/lib/conflictOfInterest';
import { formatDateOnly } from '@/lib/time';
import { membershipYearLabel } from '@/lib/programYear';
import { YearMismatchWarning, yearMismatchUnacknowledged } from '@/app/membership-ops/applications/CertifyDialog';
import { useOrgTime } from '@/components/TimezoneProvider';
import { isMembershipLapsed } from '@/lib/membership/lapsed';

import { PageLoader } from "@/components/ui/PageLoader";
import { householdQueryMatcher, personQueryMatcher } from "@/lib/searchId";

type GrantYear = { year: number; label: string };

// What a click on the year's control does: map a payment to the application
// awaiting it, or open a renewal or joining application for the family to complete.
type GrantEffect = "grant" | "openRenewal" | "openApplication";
// `appliedFor` is the year the application a grant pays was opened for.
type PendingGrant = { effect: GrantEffect; year: GrantYear; appliedFor?: number | null };

const EFFECT_VERB: Record<GrantEffect, string> = {
  grant: "Grant",
  openRenewal: "Open renewal",
  openApplication: "Open application",
};

const effectFor = (awaitingPayment: boolean, status?: string): GrantEffect =>
  awaitingPayment ? "grant" : status === "ACTIVE" ? "openRenewal" : "openApplication";

const fallbackSuccess = ({ effect, year }: PendingGrant) =>
  effect === "grant" ? `Granted ${year.label}.` : effect === "openRenewal" ? "Renewal opened." : "Application opened.";

const modalBody = ({ effect, year }: PendingGrant) =>
  effect === "grant"
    ? `Mark this household's application as paid for ${year.label} without a Shopify payment. The membership becomes active once its background check clears.`
    : `Open ${effect === "openRenewal" ? "a renewal" : "a joining application"} for the family to complete. No payment is recorded; grant ${year.label} once it reaches payment.`;

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
  awaitingPaymentYear?: number | null;
  bgValidUntil?: string | null;
  // The household has said it won't renew into `year`, on `since`.
  notRenewing?: { year: number; since: string } | null;
};

// Every date this renders (memberSince, validUntil, bgValidUntil) is a calendar
// date at UTC midnight, so it must be read UTC-pinned or it shows the day before.
const fmtDate = (s?: string | null) =>
  s ? formatDateOnly(s, { year: "numeric", month: "short", day: "numeric" }) : "—";

export default function AdminHouseholdsPage() {
  const { user: me, ready, loading: authLoading } = useRequireRole(MEMBERSHIP_OPS_ADMIN_ROLES);
  // Certifying a payment is Board-only (the server 403s a sysadmin), so a Grant is
  // hidden from anyone else. Opening a renewal or an application stays.
  const isBoard = me?.isBoardMember === true;
  const { formatDate, today: orgToday } = useOrgTime();
  const today = orgToday();
  const router = useRouter();

  const { data, error, reload } = useLoad<{ households: Household[]; grantYears?: GrantYear[] }>(ready ? '/api/membership-ops/households' : null);
  const households = data?.households ?? [];
  // The year in progress and, inside the renewal window, the coming year.
  const [yearInProgress, comingYear] = data?.grantYears ?? [];
  const [editHouseholdId, setEditHouseholdId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmDenyOpened, { open: openConfirmDeny, close: closeConfirmDeny }] = useDisclosure(false);
  const [pendingDenyHouseholdId, setPendingDenyHouseholdId] = useState<number | null>(null);
  const [grantOpened, { open: openGrantModal, close: closeGrantModal }] = useDisclosure(false);
  const [pendingGrantHouseholdId, setPendingGrantHouseholdId] = useState<number | null>(null);
  const [grantReason, setGrantReason] = useState("");
  // The effect and year the reason modal confirms.
  const [pendingGrant, setPendingGrant] = useState<PendingGrant | null>(null);
  const [grantAcknowledged, setGrantAcknowledged] = useState(false);
  const grantAppliedFor = pendingGrant?.effect === "grant" ? pendingGrant.appliedFor ?? null : null;

  const revokeMembership = async (householdId: number) => {
    clearError('revoke-membership');
    try {
      await api('/api/membership-ops/households', {
        method: 'POST',
        body: JSON.stringify({ householdId, active: false })
      });
      showSuccess('Membership revoked.');
    } catch (e) {
      showError(errorMessage(e), { key: 'revoke-membership' });
    }
  };

  // The server picks the effect at click time and its message names the one it took.
  const grant = async (householdId: number, reason: string, pending: PendingGrant, acknowledgeYearMismatch: boolean) => {
    clearError('grant-membership');
    try {
      const data = await api<{ message?: string }>('/api/membership-ops/households', {
        method: 'POST',
        body: JSON.stringify({ householdId, year: pending.year.year, reason, acknowledgeYearMismatch })
      });
      showSuccess(data?.message || fallbackSuccess(pending));
    } catch (e) {
      showError(errorMessage(e), { key: 'grant-membership' });
    }
  };

  const openGrant = (householdId: number, pending: PendingGrant) => {
    setPendingGrant(pending);
    setPendingGrantHouseholdId(householdId);
    setGrantReason("");
    setGrantAcknowledged(false);
    openGrantModal();
  };

  const confirmGrant = async () => {
    if (pendingGrantHouseholdId === null || pendingGrant === null || !grantReason.trim()) return;
    if (yearMismatchUnacknowledged(grantAppliedFor, pendingGrant.year.year, grantAcknowledged)) return;
    closeGrantModal();
    const householdId = pendingGrantHouseholdId;
    const reason = grantReason.trim();
    setPendingGrantHouseholdId(null);
    await grant(householdId, reason, pendingGrant, grantAcknowledged);
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
    clearError('deny-membership');
    try {
      await api('/api/membership-ops/households', {
        method: 'POST',
        body: JSON.stringify({ householdId, deny })
      });
      showSuccess(deny ? 'Membership denied — members can no longer log in.' : 'Membership restored.');
    } catch (e) {
      showError(errorMessage(e), { key: 'deny-membership' });
    }
  };

  const confirmDeny = async () => {
    if (pendingDenyHouseholdId === null) return;
    closeConfirmDeny();
    const householdId = pendingDenyHouseholdId;
    setPendingDenyHouseholdId(null);
    await doSetDenied(householdId, true);
  };

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  if (!data && !error) {
    return <PageLoader />;
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

      {error && <LoadError what="the households" message={error} onRetry={reload} />}

      <TextInput
        placeholder="Filter by household or participant name, email, or ID"
        value={filter}
        onChange={(e) => setFilter(e.currentTarget.value)}
        maw={400}
      />

      {data && <Table.ScrollContainer minWidth={600}>
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
                (!hasActiveMembership || (!isStaffHousehold && (awaitingPayment || isMembershipLapsed(household.validUntil, today))));
              const inProgressEffect = effectFor(awaitingPayment, status);

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
                      {household.notRenewing && (
                        <Badge color="gray" variant="light" size="sm">
                          Not renewing {membershipYearLabel(household.notRenewing.year)} · said {formatDate(household.notRenewing.since)}
                        </Badge>
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
                    ) : hasActiveMembership && isMembershipLapsed(household.validUntil, today) ? (
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
                    <Text c={isMembershipLapsed(household.validUntil, today) ? "red" : undefined} fw={isMembershipLapsed(household.validUntil, today) ? 700 : undefined}>
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
                            onClick={() => openGrant(household.id, { effect: inProgressEffect, year: yearInProgress, appliedFor: household.awaitingPaymentYear })}
                          >
                            {EFFECT_VERB[inProgressEffect]} {yearInProgress.label}
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
                        onClick={() => openGrant(household.id, { effect: "grant", year: comingYear, appliedFor: household.awaitingPaymentYear })}
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
      </Table.ScrollContainer>}

      <AdminEditHouseholdModal
        householdId={editHouseholdId}
        opened={editHouseholdId !== null}
        onClose={() => setEditHouseholdId(null)}
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
        title={pendingGrant && <Text span fw={700} fz="lg">{EFFECT_VERB[pendingGrant.effect]} {pendingGrant.year.label}</Text>}
        centered
      >
        {pendingGrant && <Text mb="sm">{modalBody(pendingGrant)}</Text>}
        <YearMismatchWarning appliedFor={grantAppliedFor} paidFor={pendingGrant?.year.year ?? null} acknowledged={grantAcknowledged} onAcknowledge={setGrantAcknowledged} />
        <Textarea
          value={grantReason}
          onChange={(e) => setGrantReason(e.currentTarget.value)}
          label="Reason"
          placeholder={pendingGrant?.effect === "grant" ? "Why is this being granted?" : "Why is this being opened?"}
          autosize
          minRows={3}
          mb="lg"
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={closeGrantModal}>Cancel</Button>
          <Button onClick={confirmGrant} disabled={!grantReason.trim() || yearMismatchUnacknowledged(grantAppliedFor, pendingGrant?.year.year ?? null, grantAcknowledged)}>{pendingGrant ? EFFECT_VERB[pendingGrant.effect] : "Grant"}</Button>
        </Group>
      </Modal>
    </Stack>
  );
}
