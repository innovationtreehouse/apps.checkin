"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge, Button, Card, Center, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { AdminEditHouseholdModal } from "@/components/admin/AdminEditHouseholdModal";
import { formatPhone } from "@/lib/phone";
import { notifications } from "@mantine/notifications";

import { PageLoader } from "@/components/ui/PageLoader";
type Lead = { id: number; name: string | null; phone: string | null; email: string | null };
type Household = { id: number; name: string | null; leads: Lead[] };

/**
 * Membership Audit view: active / in-intake households that have no valid
 * emergency contact. Each row links to the admin household editor to fix it.
 */
export default function MissingEmergencyContactsPage() {
  const [households, setHouseholds] = useState<Household[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editHouseholdId, setEditHouseholdId] = useState<number | null>(null);

  const fetchHouseholds = useCallback(() => fetch("/api/membership-audit/households-missing-contact")
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setHouseholds(data.households ?? []);
      } else {
        setError("Failed to load households. Ensure you have the proper authorizations.");
      }
    })
    .catch((e) => {
      console.error("Failed to load households missing contacts:", e);
      notifications.show({ color: "red", message: "Network error loading households.", autoClose: false });
    })
    .finally(() => {
      setLoading(false);
    }),
  []);

  useEffect(() => {
    fetchHouseholds();
  }, [fetchHouseholds]);

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
          Active or in-intake households with no valid emergency contact. A contact is
          invalid when it is blank or has become a household member. Open the household
          to add or fix one.
        </Text>
      </Card>

      {households.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">Every active household has a valid emergency contact. 🎉</Text>
        </Card>
      ) : (
        <Stack gap="sm">
          {households.map((h) => (
            <Card key={h.id} withBorder radius="md" padding="lg">
              <Group justify="space-between" wrap="wrap" mb="xs">
                <Group gap="xs">
                  <Text fw={600} fz="lg">{h.name || `Household #${h.id}`}</Text>
                  <Badge color="red" variant="light">No emergency contact</Badge>
                </Group>
                <Button size="xs" fz={15} variant="light" onClick={() => setEditHouseholdId(h.id)}>
                  Edit household
                </Button>
              </Group>
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

      <AdminEditHouseholdModal
        householdId={editHouseholdId}
        opened={editHouseholdId !== null}
        onClose={() => setEditHouseholdId(null)}
        onSaved={() => fetchHouseholds()}
      />
    </Stack>
  );
}
