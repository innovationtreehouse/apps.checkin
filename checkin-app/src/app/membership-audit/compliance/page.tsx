"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import Link from "next/link";
import { Alert, Anchor, Badge, Button, Card, Center, Group, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { formatPhone } from "@/lib/phone";
import { formatDateOnly } from "@/lib/time";
import { PageLoader } from "@/components/ui/PageLoader";

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

// Reason tag -> human label + badge color. Keys mirror the endpoint's tags.
const REASON: Record<string, { label: string; color: string }> = {
  STALE_BG: { label: "Background check expired", color: "orange" },
  REVOKED: { label: "Revoked", color: "red" },
  DENIED: { label: "Denied", color: "red" },
  STUCK_BG_CLEARANCE: { label: "Stuck at BG clearance", color: "yellow" },
};

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
                {p.programName && `Program: ${p.programName} · `}Household #{p.householdId}
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
  const [households, setHouseholds] = useState<Household[]>([]);
  const [peopleNeedingBgCheck, setPeopleNeedingBgCheck] = useState<PersonRow[]>([]);
  const [peopleMissingDob, setPeopleMissingDob] = useState<PersonRow[]>([]);
  const [blanketStamped, setBlanketStamped] = useState<BlanketStampedRow[]>([]);
  const [mergeInherited, setMergeInherited] = useState<MergeInheritedRow[]>([]);
  const [clearedSince, setClearedSince] = useState("");
  const [peopleAwaitingAgreement, setPeopleAwaitingAgreement] = useState<PersonRow[]>([]);
  const [peopleNeedingAgreement, setPeopleNeedingAgreement] = useState<PersonRow[]>([]);
  const [requestedIds, setRequestedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [submittedIds, setSubmittedIds] = useState<Set<number>>(new Set());
  const [clearedStampIds, setClearedStampIds] = useState<Set<number>>(new Set());

  // Record that an external background check exists for a program person and submit
  // it for two-reviewer approval. Board/lead-initiated — the subject may have no login.
  const submitBg = async (personId: number) => {
    setBusyId(personId);
    try {
      const res = await fetch("/api/membership-audit/person-bg", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      if (res.ok) {
        setSubmittedIds((s) => new Set(s).add(personId));
        notifications.show({ message: "Submitted for background-check review." });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: "red", message: data.error || "Could not submit for review." });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  // Open an individual membership agreement for one adult child. For people the
  // nightly rule skips because they're over its age ceiling — the board judges adult
  // child vs. unmarked spouse, which no field records.
  const requestAgreement = async (personId: number) => {
    setBusyId(personId);
    try {
      const res = await fetch("/api/membership-audit/person-agreement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId }),
      });
      if (res.ok) {
        setRequestedIds((s) => new Set(s).add(personId));
        notifications.show({ message: "Individual agreement requested." });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: "red", message: data.error || "Could not request an agreement." });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  // Remove one person's background-check date. Not a new capability: the same
  // board-gated PUT the participants edit modal already uses, one person at a time,
  // audited with the acting board member as the actor. It never touches a process or
  // its bgClearedAt, and it can never cost a household its membership — one checked
  // adult is all membership requires, so the worst case is a redundant re-check.
  const removeStamp = async (personId: number) => {
    setBusyId(personId);
    try {
      const res = await fetch(`/api/membership-ops/participants/${personId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastBackgroundCheck: null }),
      });
      if (res.ok) {
        setClearedStampIds((s) => new Set(s).add(personId));
        notifications.show({ message: "Date removed — they will show up as needing a check." });
      } else {
        const data = await res.json().catch(() => ({}));
        notifications.show({ color: "red", message: data.error || "Could not remove the date." });
      }
    } catch {
      notifications.show({ color: "red", message: "Network error." });
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemoveStamp = (row: BlanketStampedRow, lead: BlanketStampedRow["leads"][number]) =>
    modals.openConfirmModal({
      title: "Remove this background-check date?",
      children: (
        <Text size="sm">
          This removes <strong>{lead.name}</strong>&apos;s background-check date, so they will be
          asked to complete one. It does not affect{" "}
          <strong>{row.householdName}</strong>&apos;s membership — that only ever needed one checked
          adult. Do this when their report is not the one that was reviewed.
        </Text>
      ),
      labels: { confirm: "Remove the date", cancel: "Cancel" },
      confirmProps: { color: "orange" },
      onConfirm: () => removeStamp(lead.personId),
    });

  const load = useCallback((since: string) => fetch(
    `/api/membership-audit/compliance${since ? `?bgClearedSince=${encodeURIComponent(since)}` : ""}`,
  )
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setHouseholds(data.households ?? []);
        setPeopleNeedingBgCheck(data.peopleNeedingBgCheck ?? []);
        setPeopleMissingDob(data.peopleMissingDob ?? []);
        setBlanketStamped(data.blanketStamped ?? []);
        setMergeInherited(data.mergeInheritedBgChecks ?? []);
        setPeopleAwaitingAgreement(data.peopleAwaitingAgreement ?? []);
        setPeopleNeedingAgreement(data.peopleNeedingAgreement ?? []);
      } else {
        setError("Failed to load compliance data. Ensure you have the proper authorizations.");
      }
    })
    .catch((e) => {
      console.error("Failed to load compliance data:", e);
      setError("Network error loading compliance data.");
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => { load(clearedSince); }, [load, clearedSince]);

  if (loading) return <PageLoader />;

  if (error) {
    return (
      <Center mih="60vh">
        <Title order={3} c="red">{error}</Title>
      </Center>
    );
  }

  return (
    <Stack>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          Households out of compliance that the system did not auto-terminate. This is
          a standing list for manual board follow-up — no emails or actions are sent
          from here.
        </Text>
      </Card>

      {households.length === 0 && peopleNeedingBgCheck.length === 0 && peopleMissingDob.length === 0
        && blanketStamped.length === 0 && mergeInherited.length === 0
        && peopleAwaitingAgreement.length === 0 && peopleNeedingAgreement.length === 0 && (
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
        description="People 18 or older with no current background check: anyone attached to a program, plus the signing adults on an active member household. Warn-only — nothing is blocked. Once an external check exists, submit it below for two-reviewer approval."
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

      {/* One-time cleanup (#1260): households cleared before a check recorded WHOSE it
          was, where every lead got stamped. Only a person holding the reports can say
          which one is real, so the list labels the evidence and a board member decides
          — nothing is pre-selected and nothing is bulk. */}
      <Stack gap="sm">
        <Title order={4}>Background-check dates to confirm</Title>
        <Text c="dimmed" size="sm">
          These households had one check approved, but every lead was marked checked. Confirm who
          actually had the check and remove the others. Removing the wrong one costs a redundant
          re-check, never a membership.
        </Text>
        <TextInput
          type="date"
          label="Cleared since"
          description={`Showing every clearance. Narrow to ${BLANKET_STAMP_CUTOFF} to hide anything predating the per-adult re-import.`}
          value={clearedSince}
          onChange={(e) => { setLoading(true); setClearedSince(e.currentTarget.value); }}
          maw={260}
        />
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
                      {clearedStampIds.has(lead.personId) ? (
                        <Badge variant="light">Date cleared</Badge>
                      ) : (
                        <Button
                          size="xs"
                          variant="light"
                          color="orange"
                          loading={busyId === lead.personId}
                          disabled={busyId === lead.personId}
                          onClick={() => confirmRemoveStamp(row, lead)}
                        >
                          Remove this date
                        </Button>
                      )}
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </Card>
          ))
        )}
      </Stack>

      {/* Permanent, unlike the list above: a merge takes the later of the two dates with
          no record of whose check it was, so every future merge can mint another. Stays
          until #1396 closes that hole. */}
      {mergeInherited.length > 0 && (
        <Stack gap="sm">
          <Title order={4}>Background-check dates inherited from a merge</Title>
          <Text c="dimmed" size="sm">
            These people took their background-check date from a record merged into theirs. The
            merge keeps the later date without recording whose check it was.
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
        title="Missing date of birth"
        description="Program-attached people and member-household signing adults with no recorded age. Confirm their date of birth before a background check can be assessed."
        color="grape"
        people={peopleMissingDob}
      />

      {(peopleAwaitingAgreement.length > 0 || peopleNeedingAgreement.length > 0) && (
        <Alert color="blue" variant="light" title="Why this list differs from the 18+ roster">
          <Text size="sm">
            The agreement lists below judge age <b>as of today</b>, because an agreement is
            opened the day someone turns 18 — a minor cannot be bound by their own signature.{" "}
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
        description="Adults 18 or older who sign their own membership agreement rather than being covered by their household's, and haven't signed it yet. Warn-only — nothing is blocked. They sign it themselves from their membership page."
        color="blue"
        people={peopleAwaitingAgreement}
      />

      <PersonSection
        title="Individual agreement — over 25, not requested"
        description="Non-lead adults over 25 in member households. They are skipped automatically because an adult over 25 who isn't a household lead is usually a spouse who should be marked as a lead. Request an agreement only if this person is an adult child."
        color="cyan"
        people={peopleNeedingAgreement}
        renderAction={(p) =>
          requestedIds.has(p.personId) ? (
            <Badge variant="light">Agreement requested</Badge>
          ) : (
            <Button size="xs" variant="light" loading={busyId === p.personId} disabled={busyId === p.personId} onClick={() => requestAgreement(p.personId)}>
              Request individual agreement
            </Button>
          )
        }
      />
    </Stack>
  );
}
