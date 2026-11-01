"use client";

import { useMemo, useState } from "react";
import { Badge, Card, Group, List, Paper, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { LoadError } from "@checkin/component-ui";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useLoad } from "@/lib/api";
import { SAFETY_ROLES } from "@/lib/nav/sections/safety";
import { formatPhone } from "@/lib/phone";

import { PageLoader } from "@/components/ui/PageLoader";
import { householdQueryMatcher, personQueryMatcher } from "@/lib/searchId";

type ParticipantInfo = {
  id: number;
  name: string | null;
  isPresent: boolean;
};

type LeadInfo = {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
};

type Household = {
  id: number;
  name: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContacts: EmergencyContactInfo[];
  isPresent: boolean;
  householdMembers: ParticipantInfo[];
  leads: LeadInfo[];
};

type EmergencyContactInfo = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  relationship: string | null;
  invalid: boolean;
};

type ContactsResponse = {
  households?: Household[];
  building?: { reachable?: boolean };
};

export default function EmergencyContactsPage() {
  const { ready, loading: authLoading } = useRequireRole(SAFETY_ROLES);

  const { data, error, reload } = useLoad<ContactsResponse>(ready ? "/api/safety/emergency-contacts" : null);
  const [searchQuery, setSearchQuery] = useState("");
  // Without a recent kiosk heartbeat an open visit is a record, not presence.
  const presenceConfirmed = data?.building?.reachable === true;

  // Households with physically present participants float to the top. Sorts a copy: `data` is the shared cached answer.
  const households = useMemo(() => [...(data?.households ?? [])].sort((a, b) => {
    if (a.isPresent && !b.isPresent) return -1;
    if (!a.isPresent && b.isPresent) return 1;
    return (a.name || "").localeCompare(b.name || "");
  }), [data]);

  // Derived state for searching. Leads match on name and id but not email — this
  // page has never searched contact addresses.
  const matchesHousehold = householdQueryMatcher(searchQuery);
  const matchesPerson = personQueryMatcher(searchQuery);
  const filteredHouseholds = households.filter((h) =>
    matchesHousehold(h)
    || h.leads.some((l) => matchesPerson({ id: l.id, name: l.name }))
    || h.householdMembers.some(matchesPerson)
  );

  if (authLoading) return <PageLoader />;
  if (!ready) return null;
  if (error) return <LoadError what="emergency contacts" message={error} onRetry={reload} />;
  if (!data) return <PageLoader />;

  return (
    <Stack>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          Directory of primary guardians and emergency contacts across all active accounts.
          Households with members physically present are pinned to the top.
        </Text>
        <TextInput
          mt="md"
          size="md"
          placeholder="Search by Household Name, Parent Name, Member Name, or ID..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </Card>

      <Stack>
        {filteredHouseholds.map((h) => (
          <Card
            key={h.id}
            withBorder
            radius="md"
            padding="lg"
            style={h.isPresent ? { borderColor: 'var(--mantine-color-cyan-5)' } : undefined}
          >
            <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
              {/* Household & Participants */}
              <div>
                <Group gap="xs" mb="xs">
                  <Text fw={600} fz="lg">{h.name || `Household #${h.id}`}</Text>
                  {h.isPresent && (presenceConfirmed
                    ? <Badge color="cyan" variant="light">Present Now</Badge>
                    : <Badge color="gray" variant="light" title="The kiosk hasn't been heard from recently, so presence can't be confirmed">Checked in (unconfirmed)</Badge>)}
                </Group>
                <Text size="sm" c="dimmed">Household members:</Text>
                {h.householdMembers.length > 0 ? (
                  <List size="sm">
                    {h.householdMembers.map((p) => (
                      <List.Item key={p.id}>
                        {p.name || `Member #${p.id}`}
                        {p.isPresent && <Text component="span" c="green" size="sm"> ● (Checked In)</Text>}
                      </List.Item>
                    ))}
                  </List>
                ) : (
                  <Text size="sm" c="dimmed" fs="italic">No household members</Text>
                )}
              </div>

              {/* Leads / Parents */}
              <div>
                <Text size="sm" c="dimmed" mb="xs">Household Leads:</Text>
                {h.leads.length > 0 ? (
                  <Stack gap="xs">
                    {h.leads.map((l) => (
                      <Paper key={l.id} withBorder radius="sm" p="xs">
                        <Text fw={500}>{l.name || l.email}</Text>
                        <Text size="sm" c="dimmed">Phone: {l.phone ? formatPhone(l.phone) : "Not Provided"}</Text>
                      </Paper>
                    ))}
                  </Stack>
                ) : (
                  <Paper withBorder radius="sm" p="xs">
                    <Text size="sm" c="red">No designated leads found.</Text>
                  </Paper>
                )}
              </div>

              {/* Emergency Contacts */}
              <div>
                <Text size="sm" c="dimmed" mb="xs">External Emergency Contacts:</Text>
                <Stack gap="xs">
                  {h.emergencyContacts.filter(c => !c.invalid).length > 0 ? (
                    h.emergencyContacts.filter(c => !c.invalid).map((c) => (
                      <Paper key={c.id} withBorder radius="sm" p="md" bg="var(--mantine-color-red-light)">
                        <Text fw={600}>{c.name}{c.relationship ? ` (${c.relationship})` : ''}</Text>
                        <Text size="sm" mt={4}>Phone: {c.phone ? formatPhone(c.phone) : "Not Provided"}</Text>
                        {c.email && <Text size="sm">Email: {c.email}</Text>}
                      </Paper>
                    ))
                  ) : (
                    <Paper withBorder radius="sm" p="md" bg="var(--mantine-color-red-light)">
                      <Text size="sm" c="red" fs="italic">Not Configured</Text>
                    </Paper>
                  )}
                  {h.emergencyContacts.some(c => c.invalid) && (
                    <Text size="xs" c="red">⚠ One or more contacts are invalid (now a household member).</Text>
                  )}
                </Stack>
              </div>
            </SimpleGrid>
          </Card>
        ))}

        {filteredHouseholds.length === 0 && (
          <Card withBorder radius="md" padding="xl" ta="center">
            <Text c="dimmed">No households found matching your search.</Text>
          </Card>
        )}
      </Stack>
    </Stack>
  );
}
