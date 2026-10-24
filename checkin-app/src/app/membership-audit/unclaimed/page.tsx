"use client";

import { useState, useEffect, useCallback } from "react";
import { Alert, Box, Button, Card, Stack, Text } from "@mantine/core";

type UnclaimedHousehold = {
  id: number;
  name: string;
  members: { id: number; name: string | null; email: string | null }[];
};

export default function UnclaimedHouseholdsIndex() {
  const [households, setHouseholds] = useState<UnclaimedHousehold[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchHouseholds = useCallback(() => fetch('/api/membership-audit/unclaimed-households')
    .then(async (res) => {
      const data = await res.json();
      if (data.households) setHouseholds(data.households);
    })
    .catch((err) => {
      console.error("Failed to load unclaimed households:", err);
      setError(true);
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  const load = () => {
    setLoading(true);
    setError(false);
    return fetchHouseholds();
  };

  useEffect(() => {
    fetchHouseholds();
  }, [fetchHouseholds]);

  return (
    <Stack>
      <div>
        <Text c="dimmed">Households nobody has claimed via Google sign-in yet — including households with no lead at all.</Text>
      </div>

      <Box>
        {error ? (
          <Alert color="red" title="Couldn't load unclaimed households.">
            The list didn&apos;t load, so this isn&apos;t an all-clear.
            <Button mt="sm" size="xs" variant="white" color="red" onClick={load}>
              Retry
            </Button>
          </Alert>
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
        ) : !loading ? (
          <Text ta="center" c="dimmed">No unclaimed accounts.</Text>
        ) : null}
      </Box>
    </Stack>
  );
}
