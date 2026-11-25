"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { api, useLoad } from "@/lib/api";
import { MEMBERSHIP_OPS_ADMIN_ROLES } from "@/lib/nav/sections/membershipOps";
import { PageLoader } from "@/components/ui/PageLoader";
import { formatDateOnly } from "@/lib/time";
import { isMembershipLapsed } from "@/lib/membership/lapsed";
import { useOrgTime } from "@/components/TimezoneProvider";
import { SigningStatusCard, type Signing } from "@/components/membership/SigningStatusCard";

type Enrollment = {
  status: "PENDING" | "ACTIVE";
  program: { id: number; name: string };
};
type Member = {
  id: number;
  name?: string | null;
  email?: string | null;
  programParticipants?: Enrollment[] | null;
  bgValidUntil?: string | null;
  disputed?: boolean;
};
type Household = {
  id: number;
  name?: string | null;
  archivedAt?: string | null;
  orgMembership?: { status: string; memberSince?: string | null } | null;
  householdMembers?: Member[] | null;
  bgValidUntil?: string | null;
};

type HouseholdDetail = {
  household: Household | null;
  validUntil?: string | null;
  signing?: Signing | null;
};

// Every date this renders (memberSince, validUntil, bgValidUntil) is a calendar
// date at UTC midnight, so it must be read UTC-pinned or it shows the day before.
const fmtDate = (s?: string | null) =>
  s ? formatDateOnly(s, { year: "numeric", month: "short", day: "numeric" }) : "—";

// Board-only "Archive household" / "Unarchive", confirmed before it runs. The server
// refuses an archive while anything still ties the household to the organisation.
function ArchiveControl({ household }: { household: Household }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const archive = !household.archivedAt;

  const submit = async () => {
    setSaving(true);
    try {
      await api(`/api/membership-ops/households/${household.id}/${archive ? "archive" : "unarchive"}`, { method: "POST" });
      showSuccess(archive ? "Household archived." : "Household unarchived.");
      setConfirming(false);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!confirming) {
    return (
      <Button variant="light" color={archive ? "red" : undefined} size="xs" w="fit-content" onClick={() => setConfirming(true)}>
        {archive ? "Archive household…" : "Unarchive household…"}
      </Button>
    );
  }
  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Text size="sm">
          {archive
            ? "Archiving hides this household and its people from every list, search and check-in. Its open applications are closed. You can unarchive it later."
            : "Unarchiving returns this household to every list. Applications closed by the archive stay closed."}
        </Text>
        <Group gap="xs">
          <Button color={archive ? "red" : undefined} size="xs" loading={saving} onClick={submit}>
            {archive ? "Archive household" : "Unarchive household"}
          </Button>
          <Button variant="subtle" size="xs" disabled={saving} onClick={() => setConfirming(false)}>Cancel</Button>
        </Group>
      </Stack>
    </Card>
  );
}

// A household detail view for the board — its members and each member's program
// enrollments in one focused screen, off the noisy households list.
export default function HouseholdDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ready, loading: authLoading, user } = useRequireRole(MEMBERSHIP_OPS_ADMIN_ROLES);
  const router = useRouter();
  const today = useOrgTime().today();

  const { data, error, reload } = useLoad<HouseholdDetail>(ready ? `/api/membership-ops/households?id=${id}` : null);
  const household = data?.household ?? null;
  const validUntil = data?.validUntil ?? null;
  const signing = data?.signing ?? null;

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  if (error) {
    return (
      <Stack>
        <Button variant="subtle" onClick={() => router.push("/membership-ops/households")} w="fit-content">
          ← Back to Households
        </Button>
        <LoadError what="the household" message={error} onRetry={reload} />
      </Stack>
    );
  }

  if (!data) return <PageLoader />;

  if (!household) {
    return (
      <Stack>
        <Button variant="subtle" onClick={() => router.push("/membership-ops/households")} w="fit-content">
          ← Back to Households
        </Button>
        <Text c="dimmed">Household not found.</Text>
      </Stack>
    );
  }

  const status = household.orgMembership?.status;
  const members = household.householdMembers ?? [];
  const disputed = members.filter((m) => m.disputed);

  return (
    <Stack>
      <Button variant="subtle" onClick={() => router.push("/membership-ops/households")} w="fit-content">
        ← Back to Households
      </Button>

      <Group justify="space-between" align="center">
        <Title order={3}>{household.name || `Household #${household.id}`}</Title>
        {household.archivedAt ? (
          <Badge color="gray" variant="outline">Archived {fmtDate(household.archivedAt)}</Badge>
        ) : status === "DENIED" ? (
          <Badge color="red">Denied</Badge>
        ) : status === "ACTIVE" && isMembershipLapsed(validUntil, today) ? (
          <Badge color="orange">Member (lapsed)</Badge>
        ) : status === "ACTIVE" ? (
          <Badge>Member</Badge>
        ) : (
          <Badge color="gray">Not a member</Badge>
        )}
      </Group>

      <Group gap="lg">
        <Text size="sm" c="dimmed">Member since: {fmtDate(household.orgMembership?.memberSince)}</Text>
        <Text size="sm" c="dimmed">Valid until: {fmtDate(validUntil)}</Text>
        <Text size="sm" c="dimmed">BG valid until: {fmtDate(household.bgValidUntil)}</Text>
      </Group>

      {disputed.length > 0 && (
        <Alert color="red" variant="light" title="A background-check rejection counts against this household">
          <Text size="sm">
            {disputed.map((m) => m.name || m.email).join(", ")}: a rejection on their check review counts until two
            new reviewers approve it.{status === "ACTIVE" ? " The membership stands until renewal." : ""}
          </Text>
        </Alert>
      )}

      {user?.isBoardMember && <ArchiveControl household={household} />}

      <SigningStatusCard signing={signing} onChange={reload} />

      {members.length === 0 ? (
        <Text c="dimmed" fs="italic">No people in this household.</Text>
      ) : (
        <Stack gap="sm">
          {members.map((m) => {
            const enrollments = m.programParticipants ?? [];
            return (
              <Card key={m.id} withBorder padding="md">
                <Text fw={600}>{m.name || m.email}</Text>
                {m.bgValidUntil && (
                  <Text size="sm" c="dimmed">BG valid until: {fmtDate(m.bgValidUntil)}</Text>
                )}
                {enrollments.length === 0 ? (
                  <Text size="sm" c="dimmed" fs="italic" mt={4}>Not enrolled in any program.</Text>
                ) : (
                  <Group gap="xs" mt="xs">
                    {enrollments.map((e) => (
                      <Badge
                        key={e.program.id}
                        variant="light"
                        color={e.status === "ACTIVE" ? "treehouseGreen" : "yellow"}
                        style={{ cursor: "pointer" }}
                        onClick={() => router.push(`/program-ops/programs/${e.program.id}`)}
                      >
                        {e.program.name}{e.status === "PENDING" ? " (pending)" : ""}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Card>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
