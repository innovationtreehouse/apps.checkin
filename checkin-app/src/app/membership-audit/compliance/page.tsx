"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Alert, Anchor, Badge, Button, Card, Group, Paper, SegmentedControl, Stack, Text, TextInput, Title } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";
import { formatPhone } from "@/lib/phone";
import { APP_TIMEZONE, formatDate, formatDateOnly } from "@/lib/time";
import { membershipYearLabel } from "@/lib/programYear";
import type { PositionCheckStanding, PositionHolderRow } from "@/lib/membership/positionHolders";
import { PageLoader } from "@/components/ui/PageLoader";
import { AgreementYearModal } from "@/components/membership/AgreementYearModal";

// The board's cutoff for blanket-stamped background checks: a round date chosen to sit
// safely before the first affected clearance, not a boundary anything depends on. Shown
// as a hint rather than applied, so the list opens on everything.
const BLANKET_STAMP_CUTOFF = "2026-07-01";

type Lead = { id: number; name: string | null; phone: string | null; email: string | null };
type Household = {
  id: number;
  name: string | null;
  reasons: string[];
  lastBackgroundCheck: string | null;
  leads: Lead[];
};
type PersonRow = {
  personId: number;
  name: string;
  householdId: number;
  programId: number | null;
  programName: string | null;
  reason: string;
  lastVisitAt?: string;
  // The membership year of the person's open individual agreement.
  agreementYear?: number | null;
};
type BlanketStampedRow = {
  processId: number;
  householdId: number;
  householdName: string;
  bgClearedAt: string;
  consentRecorded: boolean;
  leads: { personId: number; name: string; email: string | null; likelySubject: boolean }[];
};
type MergeInheritedRow = {
  personId: number;
  name: string;
  householdId: number;
  lastBackgroundCheck: string;
  fromName: string;
};
type ComplianceAnswer = {
  households?: Household[];
  peopleNeedingBgCheck?: PersonRow[];
  peopleMissingDob?: PersonRow[];
  peopleWithDisputedCheck?: PersonRow[];
  positionHolders?: PositionHolderRow[];
  blanketStamped?: BlanketStampedRow[];
  mergeInheritedBgChecks?: MergeInheritedRow[];
  peopleAwaitingAgreement?: PersonRow[];
  peopleFreeTimeWithoutAgreement?: PersonRow[];
};

// Reason tag -> human label + badge color. Keys mirror the endpoint's tags.
const REASON: Record<string, { label: string; color: string }> = {
  STALE_BG: { label: "Background check expired", color: "orange" },
  REVOKED: { label: "Revoked", color: "red" },
  DENIED: { label: "Denied", color: "red" },
  STUCK_BG_CLEARANCE: { label: "Stuck at BG clearance", color: "yellow" },
};

const STANDING: Record<PositionCheckStanding, { label: string; color: string }> = {
  CURRENT: { label: "Current", color: "green" },
  NOT_CURRENT: { label: "Not current", color: "orange" },
  NO_CHECK: { label: "No check", color: "red" },
};

/** Everyone holding a position that needs a current check, filterable by whether it is current. */
function PositionHoldersSection({ rows }: { rows: PositionHolderRow[] }) {
  const [show, setShow] = useState("attention");
  if (rows.length === 0) return null;
  const shown = rows.filter((r) => show === "all" || (show === "current") === (r.standing === "CURRENT"));
  return (
    <Stack gap="sm">
      <Title order={4}>Positions that need a current background check</Title>
      <Text c="dimmed" size="sm">
        Volunteers, program leaders, bucket owners and treasurers, and everyone with a role. A check
        is current when it is valid at the start of the membership year the person serves in.
        Warn-only — nothing is blocked.
      </Text>
      <SegmentedControl
        value={show}
        onChange={setShow}
        data={[
          { value: "attention", label: "Not current or no check" },
          { value: "current", label: "Current" },
          { value: "all", label: "All" },
        ]}
        maw={480}
      />
      {shown.length === 0 && <Text c="dimmed" size="sm">Nobody in this view.</Text>}
      {shown.map((r) => (
        <Card key={r.personId} withBorder radius="md" padding="lg">
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600} fz="lg">{r.name}</Text>
              <Text size="sm" c="dimmed">{r.positions.map((p) => p.label).join(" · ")}</Text>
              <Text size="sm" c="dimmed">
                Judged for {membershipYearLabel(r.year)} · Last check:{" "}
                {r.lastBackgroundCheck ? formatDateOnly(r.lastBackgroundCheck) : "Never"} · Household #{r.householdId}
              </Text>
            </div>
            <Badge color={STANDING[r.standing].color} variant="light">{STANDING[r.standing].label}</Badge>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

/** Person-scoped section (bg-needed / DOB-missing). Program people may not be in a
 *  member household, so these render on their own, keyed on the person. */
function PersonSection({
  title,
  description,
  color,
  people,
  renderAction,
}: {
  title: string;
  description: string;
  color: string;
  people: PersonRow[];
  renderAction?: (p: PersonRow) => ReactNode;
}) {
  if (people.length === 0) return null;
  return (
    <Stack gap="sm">
      <Title order={4}>{title}</Title>
      <Text c="dimmed" size="sm">{description}</Text>
      {people.map((p) => (
        <Card key={p.personId} withBorder radius="md" padding="lg">
          <Group justify="space-between" wrap="wrap">
            <div>
              <Text fw={600} fz="lg">{p.name}</Text>
              <Text size="sm" c="dimmed">
                {p.programName && `Program: ${p.programName} · `}{p.agreementYear != null && `Agreement for ${membershipYearLabel(p.agreementYear)} · `}{p.lastVisitAt && `Last free-time visit: ${formatDate(p.lastVisitAt, { timeZone: APP_TIMEZONE, dateStyle: "medium" })} · `}Household #{p.householdId}
              </Text>
            </div>
            <Group gap="sm">
              <Badge color={color} variant="light">{title}</Badge>
              {renderAction?.(p)}
            </Group>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

/**
 * Membership Audit view: households out of compliance that the system did NOT
 * auto-terminate. The board follows up manually — nothing here acts on its own.
 */
export default function CompliancePage() {
  const [clearedSince, setClearedSince] = useState("");
  // Keyed by the date, so a slower answer for an earlier date never replaces the current one,
  // and the previous rows stay up (with the filter) while the next date loads.
  const { data, error, loading, retrying, reload } = useLoad<ComplianceAnswer>(
    `/api/membership-audit/compliance${clearedSince ? `?bgClearedSince=${encodeURIComponent(clearedSince)}` : ""}`,
    { keepPrevious: true },
  );
  const [requestedIds, setRequestedIds] = useState<Set<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [submittedIds, setSubmittedIds] = useState<Set<number>>(new Set());

  // Record that an external background check exists for a program person and submit
  // it for two-reviewer approval. Board/lead-initiated — the subject may have no login.
  const submitBg = async (personId: number) => {
    setBusyId(personId);
    try {
      await api("/api/membership-audit/person-bg", { method: "POST", body: JSON.stringify({ personId }) });
      setSubmittedIds((s) => new Set(s).add(personId));
      showSuccess("Submitted for background-check review.");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  // Open an individual membership agreement for one adult non-lead, for the year the Board picks.
  const [agreementFor, setAgreementFor] = useState<number | null>(null);
  const requestAgreement = async (personId: number, year: number) => {
    setBusyId(personId);
    try {
      await api("/api/membership-audit/person-agreement", { method: "POST", body: JSON.stringify({ personId, year }) });
      setRequestedIds((s) => new Set(s).add(personId));
      showSuccess("Individual agreement requested.");
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const failure = error && <LoadError what="compliance data" message={error} onRetry={reload} />;
  if (!data) return failure || <PageLoader />;

  const stale = loading || retrying;
  const households = data.households ?? [];
  const peopleNeedingBgCheck = data.peopleNeedingBgCheck ?? [];
  const peopleMissingDob = data.peopleMissingDob ?? [];
  const peopleWithDisputedCheck = data.peopleWithDisputedCheck ?? [];
  const positionHolders = data.positionHolders ?? [];
  const blanketStamped = data.blanketStamped ?? [];
  const mergeInherited = data.mergeInheritedBgChecks ?? [];
  const peopleAwaitingAgreement = data.peopleAwaitingAgreement ?? [];
  const peopleFreeTime = data.peopleFreeTimeWithoutAgreement ?? [];
  const agreementRows = peopleAwaitingAgreement.length + peopleFreeTime.length;
  const requestAction = (p: PersonRow) =>
    requestedIds.has(p.personId) ? (
      <Badge variant="light">Agreement requested</Badge>
    ) : (
      <Button size="xs" variant="light" loading={busyId === p.personId} disabled={busyId === p.personId} onClick={() => setAgreementFor(p.personId)}>
        Request individual agreement
      </Button>
    );

  return (
    <Stack>
      <AgreementYearModal
        opened={agreementFor !== null}
        onClose={() => setAgreementFor(null)}
        onConfirm={(year) => { const personId = agreementFor; setAgreementFor(null); if (personId !== null) void requestAgreement(personId, year); }}
      />
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          Households out of compliance that the system did not auto-terminate. This is
          a standing list for manual board follow-up — no emails or actions are sent
          from here.
        </Text>
      </Card>

      {households.length === 0 && peopleNeedingBgCheck.length === 0 && peopleMissingDob.length === 0 && peopleWithDisputedCheck.length === 0
        && positionHolders.length === 0 && blanketStamped.length === 0 && mergeInherited.length === 0
        && agreementRows === 0 && (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">Everyone is in compliance. 🎉</Text>
        </Card>
      )}

      {households.length > 0 && (
        <Stack gap="sm">
          {households.map((h) => (
            <Card key={h.id} withBorder radius="md" padding="lg">
              <Group justify="space-between" wrap="wrap" mb="xs">
                <Text fw={600} fz="lg">{h.name || `Household #${h.id}`}</Text>
                <Group gap="xs">
                  {h.reasons.map((r) => {
                    const meta = REASON[r] ?? { label: r, color: "gray" };
                    return (
                      <Badge key={r} color={meta.color} variant="light">{meta.label}</Badge>
                    );
                  })}
                </Group>
              </Group>
              {h.reasons.includes("STALE_BG") && (
                <Text size="sm" c="dimmed" mb="xs">
                  Last background check:{" "}
                  {h.lastBackgroundCheck ? formatDateOnly(h.lastBackgroundCheck) : "Never"}
                </Text>
              )}
              <Text size="sm" c="dimmed" mb="xs">Household Leads:</Text>
              {h.leads.length > 0 ? (
                <Stack gap="xs">
                  {h.leads.map((l) => (
                    <Paper key={l.id} withBorder radius="sm" p="xs">
                      <Text fw={500}>{l.name || l.email || `Member #${l.id}`}</Text>
                      <Text size="sm" c="dimmed">Phone: {l.phone ? formatPhone(l.phone) : "Not provided"}</Text>
                      {l.email && <Text size="sm" c="dimmed">Email: {l.email}</Text>}
                    </Paper>
                  ))}
                </Stack>
              ) : (
                <Text size="sm" c="red">No designated leads found.</Text>
              )}
            </Card>
          ))}
        </Stack>
      )}

      <PersonSection
        title="Background check needed"
        description="People 18 or older in a program or holding a position whose check is not valid for the year they serve. Household checks are shown above. Warn-only — nothing is blocked. Once an external check exists, submit it below for two-reviewer approval."
        color="orange"
        people={peopleNeedingBgCheck}
        renderAction={(p) =>
          submittedIds.has(p.personId) ? (
            <Badge variant="light">Submitted for review</Badge>
          ) : (
            <Button size="xs" variant="light" loading={busyId === p.personId} disabled={busyId === p.personId} onClick={() => submitBg(p.personId)}>
              Record external check &amp; submit
            </Button>
          )
        }
      />

      <PositionHoldersSection rows={positionHolders} />

      {/* Households cleared before a check recorded WHOSE it was, where every lead got
          stamped. Only a person holding the reports can say which one is real, so the
          list labels the evidence; correcting a date is done by hand in the database. */}
      <Stack gap="sm">
        <Title order={4}>Background-check dates to confirm</Title>
        <Text c="dimmed" size="sm">
          These households had one check approved, but every lead was marked checked. Background-check
          dates cannot be changed in the app; a wrong one is corrected by hand in the database.
        </Text>
        <TextInput
          type="date"
          label="Cleared since"
          description={`Showing every clearance. Narrow to ${BLANKET_STAMP_CUTOFF} to hide anything predating the per-adult re-import.`}
          value={clearedSince}
          onChange={(e) => setClearedSince(e.currentTarget.value)}
          maw={260}
        />
        {failure}
        <Stack gap="sm" aria-busy={stale} style={{ opacity: stale ? 0.5 : 1 }}>
          {blanketStamped.length === 0 ? (
            <Text c="dimmed" size="sm">Nothing to confirm in this range.</Text>
          ) : (
            blanketStamped.map((row) => (
              <Card key={row.processId} withBorder radius="md" padding="lg">
                <Text fw={600} fz="lg">{row.householdName}</Text>
                <Text size="sm" c="dimmed" mb="xs">
                  Cleared {new Date(row.bgClearedAt).toLocaleDateString()}
                  {row.leads.some((l) => l.likelySubject)
                    ? ""
                    : row.consentRecorded
                      ? " · consent recorded by someone outside this household"
                      : " · no consent recorded"}
                </Text>
                <Stack gap="xs">
                  {row.leads.map((lead) => (
                    <Paper key={lead.personId} withBorder radius="sm" p="xs">
                      <Group justify="space-between" wrap="wrap">
                        <div>
                          <Text fw={500}>{lead.name}</Text>
                          <Text size="sm" c="dimmed">
                            {lead.likelySubject
                              ? "Submitted their own consent — likely the one who was checked"
                              : "No evidence either way — check the report"}
                          </Text>
                        </div>
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              </Card>
            ))
          )}
        </Stack>
      </Stack>

      {/* Standing, unlike the list above: every merge can add a row, and this is how the
          board spots a merge of two different people. */}
      {mergeInherited.length > 0 && (
        <Stack gap="sm">
          <Title order={4}>Background-check dates inherited from a merge</Title>
          <Text c="dimmed" size="sm">
            These people took their background-check date from a record merged into theirs, and
            each row names that record. A merge of two different people would leave someone
            holding another person&apos;s check, so confirm the two records are the same person.
          </Text>
          {mergeInherited.map((p) => (
            <Card key={p.personId} withBorder radius="md" padding="lg">
              <Group justify="space-between" wrap="wrap">
                <div>
                  <Text fw={600} fz="lg">{p.name}</Text>
                  <Text size="sm" c="dimmed">
                    Checked {new Date(p.lastBackgroundCheck).toLocaleDateString()} · from {p.fromName}
                    {" · "}Household #{p.householdId}
                  </Text>
                </div>
                <Badge color="yellow" variant="light">Unverified provenance</Badge>
              </Group>
            </Card>
          ))}
        </Stack>
      )}

      <PersonSection
        title="Background check disputed"
        description="People whose own background check was rejected, or whose rejection the Board reset or the reviewer changed and two new approvals have not yet cleared. Any household application they are in is held until it settles."
        color="red"
        people={peopleWithDisputedCheck}
      />

      <PersonSection
        title="Missing date of birth"
        description="Program-attached people and position holders with no recorded age. Confirm their date of birth before a background check can be assessed."
        color="grape"
        people={peopleMissingDob}
      />

      {agreementRows > 0 && (
        <Alert color="blue" variant="light" title="Why this list differs from the 18+ roster">
          <Text size="sm">
            The agreement lists below judge age <b>as of today</b>, because only someone who
            is already an adult can sign their own agreement — a minor cannot be bound by it.{" "}
            <Anchor component={Link} href="/membership-audit/turning-18">The 18+ roster</Anchor>{" "}
            judges age <b>as of the start of the member year</b>, because that is the cohort the
            board plans the year around. Both are right for their own purpose, so the two lists
            will not match: anyone with a birthday between today and the next member-year start
            appears here but not there.
          </Text>
        </Alert>
      )}

      <PersonSection
        title="Individual agreement outstanding"
        description="Adults who aren't a household lead and have an individual membership agreement open and unsigned, whether it opened on its own or the Board opened it. Warn-only — nothing is blocked. They sign it themselves from their membership page."
        color="blue"
        people={peopleAwaitingAgreement}
      />

      <PersonSection
        title="Free-time check-in, no agreement"
        description="Adults in member households who aren't a lead, checked in outside any program this membership year, and have no individual agreement signed for their household's latest paid year or waiting for their signature. Nothing opens at the door and entry is never blocked; request an agreement here if one is owed."
        color="orange"
        people={peopleFreeTime}
        renderAction={requestAction}
      />
    </Stack>
  );
}
