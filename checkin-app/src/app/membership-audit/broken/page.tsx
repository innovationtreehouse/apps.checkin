"use client";

import { useState } from "react";
import { Badge, Box, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { formatDateOnly, isYouth } from "@/lib/time";
import { api, useLoad } from "@/lib/api";
import { notifyNavRefresh } from "@/lib/nav-refresh";

type Member = { id: number; name: string | null; dateOfBirth: string | null };
type BrokenHousehold = { id: number; name: string; members: Member[] };

export default function BrokenHouseholdsPage() {
  const { data, error, reload } = useLoad<{ households?: BrokenHousehold[] }>("/api/admin/broken-households");
  const households = data?.households ?? [];
  const [promoting, setPromoting] = useState<number | null>(null);

  const makeLead = async (householdName: string, participantId: number) => {
    setPromoting(participantId);
    try {
      await api("/api/household/lead", { method: "POST", body: JSON.stringify({ participantId }) });
      showSuccess("Lead assigned.");
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e), { title: householdName });
    } finally {
      setPromoting(null);
    }
  };

  if (!data && !error) {
    return <Loader />;
  }

  return (
    <Stack maw={1000} mx="auto">
      <Text c="dimmed">
        Households with no lead. A family can&apos;t be claimed until someone is the lead — assign one here.
      </Text>

      <Box>
        {error ? (
          <LoadError what="broken households" message={error} onRetry={reload} />
        ) : households.length > 0 ? (
          <Stack gap="sm">
            {households.map((h) => (
              <Card key={h.id} withBorder radius="md" padding="md">
                <Text fw={600} mb="xs">{h.name}</Text>
                {h.members.length > 0 ? (
                  <Stack gap={6}>
                    {h.members.map((m) => (
                      <Group key={m.id} justify="space-between" wrap="nowrap">
                        <Text size="sm">
                          {m.name || "Unnamed"}
                          {m.dateOfBirth ? ` • ${formatDateOnly(m.dateOfBirth)}` : " • no birthdate"}
                          {isYouth(m.dateOfBirth) && (
                            <Badge ml="xs" size="xs" color="gray" variant="light">youth</Badge>
                          )}
                        </Text>
                        {!isYouth(m.dateOfBirth) && (
                          <Button
                            size="compact-xs"
                            variant="light"
                            loading={promoting === m.id}
                            onClick={() => makeLead(h.name, m.id)}
                          >
                            Make Lead
                          </Button>
                        )}
                      </Group>
                    ))}
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed">No members to promote.</Text>
                )}
              </Card>
            ))}
          </Stack>
        ) : (
          <Text ta="center" c="dimmed">No broken households.</Text>
        )}
      </Box>
    </Stack>
  );
}
