"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Alert, Anchor, Box, Button, Card, Group, List, Paper, Radio, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import Link from "next/link";
import { notifications } from "@mantine/notifications";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { MergedBadge } from "@/components/ui/MergedBadge";
import { useRequireRole } from "@/hooks/useRequireRole";
import { PageLoader } from "@/components/ui/PageLoader";
import { formatPhone } from "@/lib/phone";
import { formatDateOnly } from "@/lib/time";
import { searchId } from "@/lib/searchId";

interface ParticipantMergeView {
  id: number;
  email?: string;
  name?: string;
  phone?: string;
  googleId?: string;
  emailVerified?: string | null;
  dateOfBirth?: string | null;
  mergedIntoId?: number | null;
  _count: { visits: number, rawBadgeLogs: number, programParticipants: number, programVolunteers: number };
  household?: { id: number, name: string, _count?: { householdMembers: number }, householdMembers: Record<string, unknown>[] } | null;
  [key: string]: unknown;
}

// Per-field conflict radios — mirrors the server's CONFLICT_FIELDS (route.ts).
// email/googleId/emailVerified are NOT here: they're the login identity, minted
// together at sign-in and resolved as ONE unit under the `identity` key (never
// split field-by-field). image/lastBackgroundCheck/lastWaiverSign auto-resolve.
const CONFLICT_FIELDS = ["name", "phone", "dateOfBirth"] as const;
type ConflictField = typeof CONFLICT_FIELDS[number];
const FIELD_LABELS: Record<ConflictField, string> = {
  name: "Name", phone: "Phone", dateOfBirth: "Date of Birth",
};

// A login identity is present iff email OR googleId is set.
function hasIdentity(p: { email?: string; googleId?: string }): boolean {
  return !!p.email || !!p.googleId;
}

// googleId has no human-readable value of its own — a raw "Connected" label reads
// identically for both sides of a conflict. Show the identity behind it instead: the
// person's own email (the account you'd recognize), falling back to the tail of
// the googleId itself when there's no email to show.
function googleIdIdentity(person: { email?: string; googleId?: string }): string {
  if (person.email) return person.email;
  if (person.googleId) return `…${person.googleId.slice(-6)}`;
  return "—";
}

// One option in the "which login identity survives?" radio: the side's email, the
// account behind its googleId, and whether that address is verified/controlled.
function identityOptionLabel(p: { email?: string; googleId?: string; emailVerified?: string | null }): string {
  const parts = [p.email || "no email"];
  if (p.googleId) parts.push(`Google: ${googleIdIdentity(p)}`);
  parts.push(p.emailVerified ? "verified" : "unverified");
  return parts.join(" · ");
}

function formatFieldValue(field: ConflictField, value: unknown): string {
  // dateOfBirth is the only date-kind field in CONFLICT_FIELDS, so the calendar-date
  // (UTC-pinned) read is right for every value that reaches this branch.
  if (field === "dateOfBirth" && typeof value === "string") {
    const d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : formatDateOnly(d);
  }
  if (field === "phone" && typeof value === "string") return formatPhone(value);
  return String(value ?? "—");
}

// Two characters are too little to search on — except for an id, which is a whole
// query at one digit.
function isSearchable(query: string) {
  return query.trim().length > 2 || searchId(query) !== null;
}

export default function MergeParticipants() {
  const { ready, loading: authLoading } = useRequireRole(['isSysadmin', 'isBoardMember']);
  const router = useRouter();
  const [searchA, setSearchA] = useState("");
  const [searchB, setSearchB] = useState("");

  const [resultsA, setResultsA] = useState<ParticipantMergeView[]>([]);
  const [resultsB, setResultsB] = useState<ParticipantMergeView[]>([]);

  const [pA, setPA] = useState<ParticipantMergeView | null>(null);
  const [pB, setPB] = useState<ParticipantMergeView | null>(null);

  const [analyzedA, setAnalyzedA] = useState<ParticipantMergeView | null>(null);
  const [analyzedB, setAnalyzedB] = useState<ParticipantMergeView | null>(null);

  const [keepId, setKeepId] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [previewMode, setPreviewMode] = useState(false);

  // Why the merge is refused on household-membership grounds, per direction —
  // the rule turns on which record is merged away (see the API's membershipGuard).
  const [membershipBlock, setMembershipBlock] = useState<{ aAsKeeper: string | null; bAsKeeper: string | null } | null>(null);

  // One choice per true conflict field ('keep' | 'merge'); default 'keep' (the
  // keeper's value). Recomputed below (derived from analyzedA/analyzedB + keepId)
  // and reset whenever the keeper flips (Swap Kept/Merged).
  const [fieldChoices, setFieldChoices] = useState<Record<string, "keep" | "merge">>({});

  const mergeParticipant = keepId === analyzedA?.id ? analyzedB : analyzedA;
  const keepParticipant = keepId === analyzedA?.id ? analyzedA : analyzedB;

  // The membership rule turns on which record is merged away, so the block
  // follows the current keeper — and Swap Kept/Merged can clear it outright.
  const keeperIsA = keepId === analyzedA?.id;
  const membershipBlockReason = (keeperIsA ? membershipBlock?.aAsKeeper : membershipBlock?.bAsKeeper) ?? null;
  const swapDirectionBlock = (keeperIsA ? membershipBlock?.bAsKeeper : membershipBlock?.aAsKeeper) ?? null;
  const swapClearsMembershipBlock = !!membershipBlockReason && !swapDirectionBlock;

  const conflicts: ConflictField[] = keepParticipant && mergeParticipant
    ? CONFLICT_FIELDS.filter((f) => {
        const kv = keepParticipant[f];
        const mv = mergeParticipant[f];
        return !!kv && !!mv && kv !== mv;
      })
    : [];

  // Both sides carry a login identity => an unavoidable conflict (unique
  // constraints guarantee they differ); the admin picks which whole identity survives.
  const identityConflict = !!(keepParticipant && mergeParticipant
    && hasIdentity(keepParticipant) && hasIdentity(mergeParticipant));

  useEffect(() => {
    if (!keepParticipant || !mergeParticipant) return;
    const defaults: Record<string, "keep" | "merge"> = {};
    for (const f of conflicts) defaults[f] = "keep";
    if (identityConflict) defaults.identity = "keep";
    setFieldChoices(defaults);
    // Reset defaults only when the keeper flips (or analysis first lands) — not on
    // every keystroke the picker itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepId, analyzedA?.id, analyzedB?.id]);

  useEffect(() => {
    if (isSearchable(searchA) && !pA) {
      fetch(`/api/people/search?q=${encodeURIComponent(searchA)}`)
        .then(r => r.json())
        .then(d => setResultsA(d.people || []));
    } else {
      setResultsA([]);
    }
  }, [searchA, pA]);

  useEffect(() => {
    if (isSearchable(searchB) && !pB) {
      fetch(`/api/people/search?q=${encodeURIComponent(searchB)}`)
        .then(r => r.json())
        .then(d => setResultsB(d.people || []));
    } else {
      setResultsB([]);
    }
  }, [searchB, pB]);

  useEffect(() => {
    if (pA && pB) {
      setLoading(true);
      fetch(`/api/membership-ops/participants/merge/analyze?a=${pA.id}&b=${pB.id}`)
        .then(r => r.json())
        .then(d => {
          if (d.participants) {
            setAnalyzedA(d.participants[0]);
            setAnalyzedB(d.participants[1]);
            setMembershipBlock(d.membershipBlock ?? null);

            // Recommend keeping the one with more activity or better data
            const score = (p: ParticipantMergeView) => {
              let s = 0;
              s += p._count.visits * 2;
              s += p._count.rawBadgeLogs;
              s += p._count.programParticipants * 5;
              s += p._count.programVolunteers * 5;
              if (p.email) s += 10;
              if (p.phone) s += 10;
              if (p.googleId) s += 20; // real account
              return s;
            };
            const sA = score(d.participants[0]);
            const sB = score(d.participants[1]);

            setKeepId(sA >= sB ? pA.id : pB.id);
          }
        })
        .catch(() => setError("Failed to analyze participants"))
        .finally(() => setLoading(false));
    } else {
      setAnalyzedA(null);
      setAnalyzedB(null);
      setKeepId(null);
      setPreviewMode(false);
      setMembershipBlock(null);
    }
  }, [pA, pB]);

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  const handleMerge = async () => {
    setMerging(true);
    setError(null);
    try {
      const res = await fetch("/api/membership-ops/participants/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepId,
          mergeId: keepId === pA?.id ? pB?.id : pA?.id,
          fieldChoices
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSuccess(true);
      } else if (typeof data.error === "string" && data.error.includes("lead of a household with other members")) {
        notifications.show({ color: "red", message: data.error, autoClose: 4000 });
        // No page-level reload here; clear the stale analyzed selection so the
        // user re-picks (and re-analyzes) against current household state.
        setPA(null);
        setPB(null);
      } else {
        setError(data.error || "Failed to merge");
      }
    } catch {
      notifications.show({ color: "red", message: "Network error", autoClose: false });
    } finally {
      setMerging(false);
    }
  };

  const renderSearch = (label: string, value: string, setValue: (v: string) => void, results: ParticipantMergeView[], selected: ParticipantMergeView | null, setSelected: (p: ParticipantMergeView | null) => void) => (
    <Box style={{ flex: 1, position: "relative" }}>
      {selected ? (
        <Card withBorder radius="md" padding="md" bg="var(--mantine-color-blue-light)">
          <Group justify="space-between">
            <div>
              <Text fw={600}>{selected.name || "Unnamed"}</Text>
              <Text size="sm" c="dimmed">{selected.email || "No email"} | ID: {selected.id}</Text>
            </div>
            <Button size="xs" fz={15} variant="default" onClick={() => setSelected(null)}>Change</Button>
          </Group>
        </Card>
      ) : (
        <>
          <TextInput
            label={label}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder="Search by name, email, or ID..."
          />
          {results.length > 0 && (
            <Paper withBorder shadow="md" radius="sm" pos="absolute" left={0} right={0} style={{ zIndex: 10, maxHeight: 320, overflowY: "auto" }}>
              {results.map((r) => (
                <Box key={r.id} p="sm" style={{ cursor: "pointer", borderBottom: "1px solid var(--mantine-color-default-border)" }} onClick={() => setSelected(r)}>
                  <Text>{r.name || "Unnamed"} <Text component="span" size="xs" c="dimmed">(ID: {r.id})</Text></Text>
                  <Text size="xs" c="dimmed">{r.email}</Text>
                </Box>
              ))}
            </Paper>
          )}
        </>
      )}
    </Box>
  );

  const renderStats = (p: ParticipantMergeView, isKept: boolean, isLeadWithOthers: boolean) => (
    <Card withBorder radius="md" padding="lg" style={{ borderColor: isKept ? "var(--mantine-color-green-6)" : "var(--mantine-color-red-6)", borderWidth: 2 }}>
      <Group gap="xs" mb="sm">
        <Title order={4} c={isKept ? "green" : "red"}>
          {isKept ? "Keep and augment" : "Merge and tombstone"}
        </Title>
        <MergedBadge person={p} />
      </Group>

      <Box mb="md">
        <Text fw={600}>{p.name || "Unnamed"} (ID: {p.id})</Text>
        <Text size="sm">Email: {p.email || "—"}</Text>
        <Text size="sm">Phone: {p.phone ? formatPhone(p.phone) : "—"}</Text>
        <Text size="sm">Google Auth: {p.googleId ? "Yes" : "No"}</Text>
      </Box>

      <Stack gap={2}>
        <Text size="sm" c="dimmed">Visits: {p._count.visits}</Text>
        <Text size="sm" c="dimmed">Raw Badge Events: {p._count.rawBadgeLogs}</Text>
        <Text size="sm" c="dimmed">Program Participation: {p._count.programParticipants}</Text>
        <Text size="sm" c="dimmed">Program Volunteering: {p._count.programVolunteers}</Text>

        <Text size="sm" c="dimmed" mt="md">
          Household: {p.household ? p.household.name || `Household #${p.household.id}` : "None"}
        </Text>
        {p.household && p.household.householdMembers && (
          <List size="sm">
            {(p.household.householdMembers as { id: number, name: string | null, isHouseholdLead?: boolean }[]).map((hp) => (
              <List.Item key={hp.id}>
                {hp.name} {hp.id === p.id && "(This)"} {hp.isHouseholdLead && "[Lead]"}
              </List.Item>
            ))}
          </List>
        )}
      </Stack>

      {!isKept && isLeadWithOthers && (
        <Alert color="red" variant="light" mt="md" fw={700}>
          Error: This participant is the lead of a household with other members. You cannot merge
          them away. Change the household lead first.
        </Alert>
      )}

      {!isKept && p.household && p.household.householdMembers && !isLeadWithOthers && p.household.householdMembers.length > 1 && (
        <Alert color="yellow" variant="light" mt="md" fw={700}>
          Warning: This participant is in a household with others. They will be removed from that
          household during deletion.
        </Alert>
      )}
    </Card>
  );

  if (success) {
    return (
      <Card withBorder radius="md" padding="xl" ta="center" style={{ borderColor: "var(--mantine-color-green-6)" }} maw={1000} mx="auto">
        <Title order={2} c="green" mb="md">Merge Successful!</Title>
        <Text mb="lg">The participants have been successfully merged.</Text>
        <Group justify="center">
          <Button variant="default" onClick={() => {
            setSuccess(false);
            setPA(null); setPB(null);
            setSearchA(""); setSearchB("");
          }}>Merge More</Button>
          <Button onClick={() => router.push('/membership-ops/participants')}>Back to Participants</Button>
        </Group>
      </Card>
    );
  }

  let isLeadWithOthers = false;
  if (mergeParticipant && !previewMode) {
    const isLead = (mergeParticipant.household?.householdMembers as { id: number, isHouseholdLead?: boolean }[] | undefined)?.find((m) => m.id === mergeParticipant.id)?.isHouseholdLead;
    const othersCount = (mergeParticipant.household?.householdMembers as { id: number }[] | undefined)?.filter((p) => p.id !== mergeParticipant.id).length || 0;
    isLeadWithOthers = !!isLead && othersCount > 0;
  }

  return (
    <Stack maw={1000} mx="auto">
      <div>
        <Text c="dimmed">
          Combine two participant records. The data from the merged record (visits, programs, etc)
          will be moved to the kept record. The merged record will be tombstoned.
        </Text>
        <Anchor component={Link} href="/membership-ops/participants/tombstones" size="sm">
          View tombstone census
        </Anchor>
      </div>

      {!previewMode && <AlertBanner message={error} tone="error" />}

      {!previewMode ? (
        <>
          {/* overflow: visible overrides Mantine's Card default (overflow: hidden), which
              otherwise clips the search results dropdown below to a sliver — see renderSearch. */}
          <Card withBorder radius="md" padding="lg" style={{ overflow: "visible" }}>
            <Group align="flex-start" gap="xl" grow>
              {renderSearch("Participant 1", searchA, setSearchA, resultsA, pA, setPA)}
              {renderSearch("Participant 2", searchB, setSearchB, resultsB, pB, setPB)}
            </Group>
          </Card>

          {loading && <Text>Analyzing participants...</Text>}

          {analyzedA && analyzedB && (
            <Stack>
              <Group justify="center">
                <Button variant="default" onClick={() => setKeepId(keepId === analyzedA.id ? analyzedB.id : analyzedA.id)}>
                  Swap Kept / Merged
                </Button>
              </Group>

              {membershipBlockReason && (
                <Alert color="red" variant="light" fw={700} title="Household membership blocks this merge">
                  {membershipBlockReason}
                  {swapClearsMembershipBlock && " Swapping which record is kept clears this."}
                </Alert>
              )}

              <SimpleGrid cols={{ base: 1, md: 2 }}>
                {renderStats(analyzedA, keepId === analyzedA.id, analyzedA.id !== keepId ? isLeadWithOthers : false)}
                {renderStats(analyzedB, keepId === analyzedB.id, analyzedB.id !== keepId ? isLeadWithOthers : false)}
              </SimpleGrid>

              {(conflicts.length > 0 || identityConflict) && keepParticipant && mergeParticipant && (
                <Card withBorder radius="md" padding="lg">
                  <Title order={5} mb="sm">Resolve conflicting fields</Title>
                  <Stack gap="md">
                    {identityConflict && (
                      <Radio.Group
                        label="Login identity"
                        description="Email, Google sign-in, and verified status move together as one unit — picking a side replaces the kept record's whole login, so choosing an email-only side drops the other's Google sign-in."
                        value={fieldChoices.identity ?? "keep"}
                        onChange={(v) => setFieldChoices((prev) => ({ ...prev, identity: v as "keep" | "merge" }))}
                      >
                        <Stack mt="xs" gap="xs">
                          <Radio value="keep" label={identityOptionLabel(keepParticipant)} />
                          <Radio value="merge" label={identityOptionLabel(mergeParticipant)} />
                        </Stack>
                      </Radio.Group>
                    )}
                    {conflicts.map((field) => {
                      const radioGroup = (
                        <Radio.Group
                          label={FIELD_LABELS[field]}
                          value={fieldChoices[field] ?? "keep"}
                          onChange={(v) => setFieldChoices((prev) => ({ ...prev, [field]: v as "keep" | "merge" }))}
                        >
                          <Group mt="xs">
                            <Radio value="keep" label={formatFieldValue(field, keepParticipant[field])} />
                            <Radio value="merge" label={formatFieldValue(field, mergeParticipant[field])} />
                          </Group>
                        </Radio.Group>
                      );

                      // DOB conflicts get warning treatment, not a plain radio: differing
                      // birth dates are a much stronger "these might not be the same
                      // person" signal than a differing email or phone.
                      if (field === "dateOfBirth") {
                        return (
                          <Alert key={field} color="yellow" variant="light" title="Birth date conflict">
                            Different birth dates may mean these are NOT the same person — verify before merging.
                            <Box mt="xs">{radioGroup}</Box>
                          </Alert>
                        );
                      }

                      return <Box key={field}>{radioGroup}</Box>;
                    })}
                  </Stack>
                </Card>
              )}

              <Group justify="flex-end">
                <Button size="md" disabled={isLeadWithOthers || !!membershipBlockReason} onClick={() => setPreviewMode(true)}>
                  Proceed to Preview
                </Button>
              </Group>
            </Stack>
          )}
        </>
      ) : mergeParticipant && keepParticipant ? (
        <Card withBorder radius="md" padding="lg" style={{ borderColor: "var(--mantine-color-yellow-6)" }}>
          <Title order={2} c="yellow.7">Preview &amp; Confirm Merge</Title>
          <Text my="sm"><strong>This action is extremely difficult to undo.</strong> Please review the changes below.</Text>

          <List spacing="xs" my="lg">
            <List.Item><strong>{mergeParticipant.name || mergeParticipant.email || `ID ${mergeParticipant.id}`}</strong> will be tombstoned.</List.Item>
            <List.Item>All visits, program enrollments, RSVPs, and fee payments will be transferred to <strong>{keepParticipant.name || keepParticipant.email || `ID ${keepParticipant.id}`}</strong>.</List.Item>
            <List.Item>Missing personal info on the kept participant will be filled in from the merged participant.</List.Item>
            <List.Item>Raw badge scans will remain on the tombstoned record for audit purposes.</List.Item>
          </List>

          {error && (
            <Alert color="red" variant="light" mb="md" fw={700}>
              {error}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPreviewMode(false)} disabled={merging}>Cancel</Button>
            <Button color="red" onClick={handleMerge} disabled={merging} loading={merging}>Confirm Merge &amp; Tombstone</Button>
          </Group>
        </Card>
      ) : null}
    </Stack>
  );
}
