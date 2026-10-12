"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Box, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatDateOnly, isYouth } from "@/lib/time";
import { notifyNavRefresh } from "@/lib/nav-refresh";

type Member = { id: number; name: string | null; dateOfBirth: string | null };
type BrokenHousehold = { id: number; name: string; members: Member[] };

export default function BrokenHouseholdsPage() {
  const [households, setHouseholds] = useState<BrokenHousehold[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [promoting, setPromoting] = useState<number | null>(null);
  // Per-household lead-assign result, shown in a card-local Alert. A page-corner
  // toast reads as "nothing happened" for a card far down; the card also doesn't
  // reliably vanish on success. Keyed by household id, cleared on the next click.
  const [notice, setNotice] = useState<Record<number, { ok: boolean; text: string }>>({});

  const loadHouseholds = useCallback(() => fetch("/api/admin/broken-households")
    .then(async (res) => {
      const data = await res.json();
      if (data.households) setHouseholds(data.households);
    })
    .catch((err) => {
      console.error("Failed to load broken households:", err);
      setError(true);
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  const fetchHouseholds = () => {
    setError(false);
    return loadHouseholds();
  };

  useEffect(() => {
    loadHouseholds();
  }, [loadHouseholds]);

  const makeLead = async (householdId: number, participantId: number) => {
    setPromoting(participantId);
    setNotice((n) => { const next = { ...n }; delete next[householdId]; return next; });
    try {
      const res = await fetch("/api/household/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId }),
      });
      if (res.ok) {
        notifications.show({ message: "Lead assigned." });
        fetchHouseholds();
        notifyNavRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setNotice((n) => ({ ...n, [householdId]: { ok: false, text: data.error || "Failed to assign lead." } }));
      }
    } catch {
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setPromoting(null);
    }
  };

  if (loading) {
    return <Loader />;
  }

  return (
    <Stack maw={1000} mx="auto">
      <Text c="dimmed">
        Households with no lead. A family can&apos;t be claimed until someone is the lead — assign one here.
      </Text>

      <Box>
        {error ? (
          <Alert color="red" title="Couldn't load broken households.">
            The list didn&apos;t load, so this isn&apos;t an all-clear.
            <Button mt="sm" size="xs" variant="white" color="red" onClick={fetchHouseholds}>
              Retry
            </Button>
          </Alert>
        ) : households.length > 0 ? (
          <Stack gap="sm">
            {households.map((h) => (
              <Card key={h.id} withBorder radius="md" padding="md">
                <Text fw={600} mb="xs">{h.name}</Text>
                {notice[h.id] && (
                  <Alert color={notice[h.id].ok ? "treehouseGreen" : "red"} variant="light" mb="xs" withCloseButton
                    onClose={() => setNotice((n) => { const next = { ...n }; delete next[h.id]; return next; })}>
                    {notice[h.id].text}
                  </Alert>
                )}
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
                            onClick={() => makeLead(h.id, m.id)}
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
