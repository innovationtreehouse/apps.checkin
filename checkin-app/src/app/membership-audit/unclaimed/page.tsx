"use client";

import { Box, Card, Stack, Text } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useLoad } from "@/lib/api";

type UnclaimedHousehold = {
  id: number;
  name: string;
  members: { id: number; name: string | null; email: string | null }[];
};

export default function UnclaimedHouseholdsIndex() {
  const { data, error, reload } = useLoad<{ households?: UnclaimedHousehold[] }>("/api/membership-audit/unclaimed-households");
  const households = data?.households ?? [];

  return (
    <Stack>
      <div>
        <Text c="dimmed">Households nobody has claimed via Google sign-in yet — including households with no lead at all.</Text>
      </div>

      <Box>
        {error ? (
          <LoadError what="unclaimed households" message={error} onRetry={reload} />
        ) : households.length > 0 ? (
          <Stack gap="sm">
            {households.map((h) => (
              <Card key={h.id} withBorder radius="md" padding="md">
                <Text fw={600} mb="xs">{h.name}</Text>
                <Stack gap={4}>
                  {h.members.map((m) => (
                    <Text key={m.id} size="sm" c="dimmed">{m.name || 'Unnamed'} • {m.email}</Text>
                  ))}
                </Stack>
              </Card>
            ))}
          </Stack>
        ) : data ? (
          <Text ta="center" c="dimmed">No unclaimed accounts.</Text>
        ) : null}
      </Box>
    </Stack>
  );
}
