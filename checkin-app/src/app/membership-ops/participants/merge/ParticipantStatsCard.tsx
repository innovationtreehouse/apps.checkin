import { Alert, Box, Card, Group, List, Stack, Text, Title } from "@mantine/core";
import { formatPhone } from "@/lib/phone";
import type { ParticipantMergeView } from "./mergeView";

export function ParticipantStatsCard({ p, isKept, isLeadWithOthers }: {
  p: ParticipantMergeView;
  isKept: boolean;
  isLeadWithOthers: boolean;
}) {
  return (
    <Card withBorder radius="md" padding="lg" style={{ borderColor: isKept ? "var(--mantine-color-green-6)" : "var(--mantine-color-red-6)", borderWidth: 2 }}>
      <Group gap="xs" mb="sm">
        <Title order={4} c={isKept ? "green" : "red"}>
          {isKept ? "Keep and augment" : "Merge and delete"}
        </Title>
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
}
