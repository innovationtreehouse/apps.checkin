"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLoad } from "@/lib/api";
import { MEMBERSHIP_OPS_ADMIN_ROLES } from "@/lib/nav/sections/membershipOps";
import { PageLoader } from "@/components/ui/PageLoader";
import { formatDateOnly } from "@/lib/time";
import { isMembershipLapsed } from "@/lib/membership/lapsed";
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
};
type Household = {
  id: number;
  name?: string | null;
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

// A household detail view for the board — its members and each member's program
// enrollments in one focused screen, off the noisy households list.
export default function HouseholdDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { ready, loading: authLoading } = useRequireRole(MEMBERSHIP_OPS_ADMIN_ROLES);
  const router = useRouter();

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

  return (
    <Stack>
      <Button variant="subtle" onClick={() => router.push("/membership-ops/households")} w="fit-content">
        ← Back to Households
      </Button>

      <Group justify="space-between" align="center">
        <Title order={3}>{household.name || `Household #${household.id}`}</Title>
        {status === "DENIED" ? (
          <Badge color="red">Denied</Badge>
        ) : status === "ACTIVE" && isMembershipLapsed(validUntil) ? (
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
