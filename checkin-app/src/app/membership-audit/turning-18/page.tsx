"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Alert, Anchor, Badge, Card, Center, Checkbox, Group, Stack, Table, Text, Title } from "@mantine/core";
import { PageLoader } from "@/components/ui/PageLoader";
import { calculateAge, formatDateOnly } from "@/lib/time";
import { memberYearStarts } from "@/lib/programYear";

type ProgramRef = { id: number; name: string };
type PersonRow = {
  id: number;
  name: string | null;
  dateOfBirth: string | null;
  household: { id: number; name: string | null } | null;
  programParticipants: { program: ProgramRef }[];
};
type Payload = {
  BoardSettings: { orgMembershipYearBoundary: string | null } | null;
  Person: PersonRow[];
};

/**
 * Membership Audit view: non-lead household members who are 18+ as of the current
 * member-year start and as of the next one, so the board can act on both the
 * standing adults and the ones aging in. Read-only.
 *
 * The endpoint ships dateOfBirth + the year boundary; both as-of ages are derived
 * here, because the security stripper drops computed fields from a response.
 */
export default function TurningEighteenPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enrolledOnly, setEnrolledOnly] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/membership-audit/turning-18");
        if (res.ok) {
          setData(await res.json());
        } else {
          setError("Failed to load the roster. Ensure you have the proper authorizations.");
        }
      } catch (e) {
        console.error("Failed to load the 18+ roster:", e);
        setError("Network error loading the roster.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <PageLoader />;

  if (error || !data) {
    return (
      <Center mih="60vh">
        <Title order={3} c="red">{error || "No data."}</Title>
      </Center>
    );
  }

  const boundary = data.BoardSettings?.orgMembershipYearBoundary;
  if (!boundary) {
    return (
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          No membership-year start date is configured, so there is no boundary to judge
          ages against. Set it in Settings → Membership.
        </Text>
      </Card>
    );
  }

  const { current, next } = memberYearStarts(new Date(boundary));
  // A null dateOfBirth here means age unknown, not age 26+ — the endpoint only
  // sends those without the 25+ declaration. They can't be placed in the table.
  const unknownDobCount = (data.Person ?? []).filter((p) => !p.dateOfBirth).length;
  const dated = (data.Person ?? []).filter((p) => p.dateOfBirth);
  const rows = dated
    .filter((p) => !enrolledOnly || p.programParticipants.length > 0)
    .map((p) => ({
      ...p,
      ageAtCurrent: calculateAge(p.dateOfBirth!, current),
      ageAtNext: calculateAge(p.dateOfBirth!, next),
    }));

  return (
    <Stack>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">
          Household members (excluding household leads) who are 18 or older as of{" "}
          <strong>{formatDateOnly(current)}</strong> — the current member year — or as of{" "}
          <strong>{formatDateOnly(next)}</strong>, the next one. Someone 18 only in the
          &ldquo;next&rdquo; column ages in on that boundary. Read-only.
        </Text>
        <Text c="dimmed" mt="xs">
          Effectively an 18&ndash;25 list: a birthdate is dropped once someone turns 26, so
          nobody older has an age to judge. Their absence is not a signal.
        </Text>
      </Card>

      {unknownDobCount > 0 && (
        <Alert color="yellow" variant="light" title="Ages we cannot judge">
          <Text size="sm">
            {unknownDobCount === 1
              ? "1 household member has no date of birth on file and is"
              : `${unknownDobCount} household members have no date of birth on file and are`}{" "}
            not marked 25 or over, so their age is unknown. They are missing from the table
            below and could be turning 18 — add a birthdate on their household to place them.
          </Text>
        </Alert>
      )}

      <Alert color="blue" variant="light" title="Why this differs from the agreement lists">
        <Text size="sm">
          This roster judges age <b>as of the member-year start</b>, because that is the cohort
          the board plans the year around. The individual-agreement lists on{" "}
          <Anchor component={Link} href="/membership-audit/compliance">Compliance</Anchor> judge
          age <b>as of today</b>, because an agreement is opened the day someone turns 18 — a
          minor cannot be bound by their own signature. Both are right for their own purpose, so
          the two will not match: anyone with a birthday between today and the next member-year
          start appears there but not here.
        </Text>
      </Alert>

      <Checkbox
        label="Hide those not in a program"
        checked={enrolledOnly}
        onChange={(e) => setEnrolledOnly(e.currentTarget.checked)}
      />

      {rows.length === 0 ? (
        <Card withBorder radius="md" padding="xl" ta="center">
          <Text c="dimmed">
            {enrolledOnly && dated.length > 0
              ? "Nobody on this list is enrolled in a program."
              : "Nobody with a birthdate on file turns 18 by the next member year."}
          </Text>
        </Card>
      ) : (
        <Table.ScrollContainer minWidth={700}>
          <Table striped highlightOnHover withTableBorder verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Household</Table.Th>
                <Table.Th>Date of birth</Table.Th>
                <Table.Th>Age {formatDateOnly(current)}</Table.Th>
                <Table.Th>Age {formatDateOnly(next)}</Table.Th>
                <Table.Th>Programs</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td fw={600}>{r.name || `Person #${r.id}`}</Table.Td>
                  <Table.Td>{r.household?.name || `Household #${r.household?.id ?? "?"}`}</Table.Td>
                  <Table.Td>{formatDateOnly(r.dateOfBirth)}</Table.Td>
                  <Table.Td>
                    {r.ageAtCurrent >= 18 ? (
                      r.ageAtCurrent
                    ) : (
                      <Text span c="dimmed">{r.ageAtCurrent}</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      {r.ageAtNext}
                      {r.ageAtCurrent < 18 && <Badge color="orange" variant="light">Turns 18</Badge>}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {r.programParticipants.length > 0 ? (
                      <Group gap={6}>
                        {r.programParticipants.map((pp) => (
                          <Badge key={pp.program.id} variant="light">{pp.program.name}</Badge>
                        ))}
                      </Group>
                    ) : (
                      <Text span c="dimmed">Not in a program</Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
