"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useRequireRole } from "@/hooks/useRequireRole";
import { MEMBERSHIP_OPS_ADMIN_ROLES } from "@/lib/nav/sections/membershipOps";
import { PageLoader } from "@/components/ui/PageLoader";
import { api, useLoad } from "@/lib/api";
import { errorMessage, HttpError, LoadError, showError } from "@checkin/component-ui";
import { activityScore, CONFLICT_FIELDS, hasIdentity, type ConflictField, type MergeAnalysis, type ParticipantMergeView } from "./mergeView";
import { PersonPicker, usePeopleSearch } from "./PersonPicker";
import { ParticipantStatsCard } from "./ParticipantStatsCard";
import { ConflictResolver } from "./ConflictResolver";
import { MergeBlockAlerts } from "./MergeBlockAlerts";
import { MergePreview } from "./MergePreview";
import { MergeSuccess } from "./MergeSuccess";

export default function MergeParticipants() {
  const { ready, loading: authLoading } = useRequireRole(MEMBERSHIP_OPS_ADMIN_ROLES);
  const router = useRouter();
  const [searchA, setSearchA] = useState("");
  const [searchB, setSearchB] = useState("");

  const [pA, setPA] = useState<ParticipantMergeView | null>(null);
  const [pB, setPB] = useState<ParticipantMergeView | null>(null);

  const searchResultsA = usePeopleSearch("Participant 1", searchA, !!pA);
  const searchResultsB = usePeopleSearch("Participant 2", searchB, !!pB);

  // Keyed on the selected pair, so only that pair's answer shows, and a merge
  // deletes the record the operator was shown.
  const aId = pA?.id;
  const bId = pB?.id;
  const analysis = useLoad<MergeAnalysis>(
    aId !== undefined && bId !== undefined ? `/api/membership-ops/participants/merge/analyze?a=${aId}&b=${bId}` : null,
    { retry: false },
  );
  const [analyzedA, analyzedB] = analysis.data?.participants ?? [null, null];
  const membershipBlock = analysis.data?.membershipBlock ?? null;
  const bgNotices = analysis.data?.bgNotice ?? null;
  const collisions = analysis.data?.collisions ?? [];

  // Swap Kept/Merged overrides the recommended keeper until either side is re-picked.
  const [keepOverride, setKeepOverride] = useState<number | null>(null);
  const recommendedKeepId = analyzedA && analyzedB
    ? (activityScore(analyzedA) >= activityScore(analyzedB) ? analyzedA.id : analyzedB.id)
    : null;
  const keepId = keepOverride ?? recommendedKeepId;

  const [merging, setMerging] = useState(false);
  const [success, setSuccess] = useState(false);

  const [previewMode, setPreviewMode] = useState(false);

  // One choice per true conflict field ('keep' | 'merge'); default 'keep' (the
  // keeper's value). Reset below whenever the keeper flips (Swap Kept/Merged) or
  // analysis lands.
  const [fieldChoices, setFieldChoices] = useState<Record<string, "keep" | "merge">>({});
  const [emailChangeReason, setEmailChangeReason] = useState("");

  const mergeParticipant = keepId === analyzedA?.id ? analyzedB : analyzedA;
  const keepParticipant = keepId === analyzedA?.id ? analyzedA : analyzedB;

  // The membership rule turns on which record is merged away, so the block
  // follows the current keeper — and Swap Kept/Merged can clear it outright.
  const keeperIsA = keepId === analyzedA?.id;
  const membershipBlockReason = (keeperIsA ? membershipBlock?.aAsKeeper : membershipBlock?.bAsKeeper) ?? null;
  const swapDirectionBlock = (keeperIsA ? membershipBlock?.bAsKeeper : membershipBlock?.aAsKeeper) ?? null;
  const swapClearsMembershipBlock = !!membershipBlockReason && !swapDirectionBlock;

  // The background-check date the survivor would adopt.
  const bgNotice = (keeperIsA ? bgNotices?.aAsKeeper : bgNotices?.bAsKeeper) ?? null;

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

  // Reset defaults only when the keeper flips (or analysis first lands) — not on
  // every keystroke the picker itself causes.
  const choicesFor = `${keepId}:${analyzedA?.id}:${analyzedB?.id}`;
  const [choicesSetFor, setChoicesSetFor] = useState(choicesFor);
  if (choicesSetFor !== choicesFor) {
    setChoicesSetFor(choicesFor);
    if (keepParticipant && mergeParticipant) {
      const defaults: Record<string, "keep" | "merge"> = {};
      for (const f of conflicts) defaults[f] = "keep";
      if (identityConflict) defaults.identity = "keep";
      setFieldChoices(defaults);
    }
  }

  const pick = (a: ParticipantMergeView | null, b: ParticipantMergeView | null) => {
    setPA(a);
    setPB(b);
    setKeepOverride(null);
    setPreviewMode(false);
  };

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  const handleMerge = async () => {
    setMerging(true);
    try {
      await api("/api/membership-ops/participants/merge", {
        method: "POST",
        body: JSON.stringify({
          keepId: keepParticipant?.id,
          mergeId: mergeParticipant?.id,
          fieldChoices,
          ...(emailChangeReason.trim() && { emailChangeReason }),
        })
      });
      setSuccess(true);
    } catch (e) {
      showError(errorMessage(e));
      // Clear the stale analyzed selection so the user re-picks against current household state.
      if (e instanceof HttpError && e.message.includes("lead of a household with other members")) pick(null, null);
    } finally {
      setMerging(false);
    }
  };

  if (success) {
    return (
      <MergeSuccess
        onMergeMore={() => {
          setSuccess(false);
          pick(null, null);
          setSearchA(""); setSearchB("");
        }}
        onBack={() => router.push('/membership-ops/participants')}
      />
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
          will be moved to the kept record. The merged record will be deleted, and an archive of it names the kept record.
        </Text>
      </div>

      {!previewMode ? (
        <>
          {/* overflow: visible overrides Mantine's Card default (overflow: hidden), which
              otherwise clips the search results dropdown below to a sliver — see PersonPicker. */}
          <Card withBorder radius="md" padding="lg" style={{ overflow: "visible" }}>
            <Group align="flex-start" gap="xl" grow>
              <PersonPicker label="Participant 1" value={searchA} setValue={setSearchA} search={searchResultsA} selected={pA} setSelected={(p) => pick(p, pB)} />
              <PersonPicker label="Participant 2" value={searchB} setValue={setSearchB} search={searchResultsB} selected={pB} setSelected={(p) => pick(pA, p)} />
            </Group>
          </Card>

          {analysis.loading && <Text>Analyzing participants...</Text>}
          {analysis.error && <LoadError what="the merge analysis" message={analysis.error} onRetry={analysis.reload} />}

          {analyzedA && analyzedB && (
            <Stack>
              <Group justify="center">
                <Button variant="default" onClick={() => setKeepOverride(keepId === analyzedA.id ? analyzedB.id : analyzedA.id)}>
                  Swap Kept / Merged
                </Button>
              </Group>

              <MergeBlockAlerts membershipBlockReason={membershipBlockReason} swapClearsMembershipBlock={swapClearsMembershipBlock} collisions={collisions} />

              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <ParticipantStatsCard p={analyzedA} isKept={keepId === analyzedA.id} isLeadWithOthers={analyzedA.id !== keepId ? isLeadWithOthers : false} />
                <ParticipantStatsCard p={analyzedB} isKept={keepId === analyzedB.id} isLeadWithOthers={analyzedB.id !== keepId ? isLeadWithOthers : false} />
              </SimpleGrid>

              {(conflicts.length > 0 || identityConflict) && keepParticipant && mergeParticipant && (
                <ConflictResolver
                  keepParticipant={keepParticipant}
                  mergeParticipant={mergeParticipant}
                  conflicts={conflicts}
                  identityConflict={identityConflict}
                  fieldChoices={fieldChoices}
                  setFieldChoices={setFieldChoices}
                />
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
        <MergePreview
          mergeParticipant={mergeParticipant}
          keepParticipant={keepParticipant}
          bgNotice={bgNotice}
          emailChangeReason={emailChangeReason}
          setEmailChangeReason={setEmailChangeReason}
          merging={merging}
          onCancel={() => setPreviewMode(false)}
          onConfirm={handleMerge}
        />
      ) : null}
    </Stack>
  );
}
