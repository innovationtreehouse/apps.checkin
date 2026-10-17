"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Card, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { PageContainer } from "@/components/ui/PageContainer";
import { useRequireRole } from "@/hooks/useRequireRole";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { MAX_VISIT_MS } from "@/lib/visitTimes";
import { AttendanceTabs } from "../AttendanceTabs";

import { PageLoader } from "@/components/ui/PageLoader";
type HouseholdMember = { id: number; name: string | null; email: string };

export default function ManualAttendance() {
  const { ready, loading: authLoading, user } = useRequireRole([]);
  const [arrivedAt, setArrived] = useState("");
  const [departedAt, setDeparted] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ arrivedAt?: string; departedAt?: string }>({});
  // A household lead records for any member of their household — the only way a
  // minor's visit gets entered at all. Everyone else records for themselves.
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [personId, setPersonId] = useState<string | null>(null);

  const isLead = !!user?.householdLead;

  useEffect(() => {
    if (!ready || !isLead) return;
    let active = true;
    (async () => {
      const res = await fetch("/api/household");
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (active) setMembers(data.household?.householdMembers ?? []);
    })();
    return () => { active = false; };
  }, [ready, isLead]);

  const validateTimes = () => {
    const now = Date.now();
    const fe: { arrivedAt?: string; departedAt?: string } = {};
    const arr = new Date(arrivedAt);
    if (!arrivedAt) fe.arrivedAt = "Arrival time is required";
    else if (isNaN(arr.getTime())) fe.arrivedAt = "Invalid arrival time";
    else if (arr.getTime() > now + 5 * 60 * 1000) fe.arrivedAt = "Arrival time cannot be in the future.";
    if (departedAt) {
      const dep = new Date(departedAt);
      if (isNaN(dep.getTime())) fe.departedAt = "Invalid departure time";
      else if (dep.getTime() <= arr.getTime()) fe.departedAt = "Departure time must be after arrival time";
      else if (dep.getTime() - arr.getTime() > MAX_VISIT_MS) fe.departedAt = "A visit cannot be longer than 24 hours.";
    } else if (arrivedAt && !fe.arrivedAt) {
      const withinSixHours = now - arr.getTime() <= 6 * 60 * 60 * 1000;
      const sameDay = arr.toDateString() === new Date(now).toDateString();
      if (!withinSixHours && !sameDay) fe.departedAt = "Departure time is required for past arrivals.";
    }
    return fe;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setFieldErrors({});

    const fe = validateTimes();
    if (fe.arrivedAt || fe.departedAt) {
      setFieldErrors(fe);
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/attendance/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // datetime-local gives a naive "YYYY-MM-DDTHH:mm" (no offset). Send a real
        // instant so the server doesn't reparse it in ITS timezone (UTC in prod).
        body: JSON.stringify({
          arrivedAt: new Date(arrivedAt).toISOString(),
          departedAt: departedAt ? new Date(departedAt).toISOString() : "",
          // Omitted = self. The server re-checks household scope regardless.
          ...(personId ? { personId: Number(personId) } : {}),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to record manual visit.");
      } else {
        notifications.show({ message: "Visit recorded successfully." });
        setArrived("");
        setDeparted("");
        // Building occupancy badges (attendance nav) count this new visit — refresh them.
        notifyNavRefresh();
      }
    } catch {
      notifications.show({ color: "red", message: "Network error occurred.", autoClose: false });
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) return <PageLoader />;
  if (!ready) return null;

  return (
    <PageContainer>
      <AttendanceTabs />
      <Card withBorder radius="md" padding="lg">
        <Title order={1} mb="md">Manual Time Entry</Title>

        <Text c="dimmed" mb="lg">
          Forgot to scan your badge? You can self-correct your time record here. If you are
          currently in the building, leave the departure time blank.
          {members.length > 1 && " As a household lead you can also record a visit for another member of your household."}
        </Text>

        {error && <Alert color="red" mb="md">{error}</Alert>}

        <form onSubmit={handleSubmit}>
          <Stack>
            {members.length > 1 && (
              <Select
                label="Who is this visit for?"
                data={members.map((m) => ({ value: String(m.id), label: m.name || m.email }))}
                value={personId ?? String(user?.id ?? "")}
                onChange={setPersonId}
                allowDeselect={false}
              />
            )}
            <TextInput
              type="datetime-local"
              label="Arrival Time (Required)"
              value={arrivedAt}
              onChange={(e) => {
                setArrived(e.currentTarget.value);
                setFieldErrors((f) => ({ ...f, arrivedAt: undefined }));
              }}
              error={fieldErrors.arrivedAt}
              required
            />
            <TextInput
              type="datetime-local"
              label="Departure Time (Optional)"
              value={departedAt}
              onChange={(e) => {
                setDeparted(e.currentTarget.value);
                setFieldErrors((f) => ({ ...f, departedAt: undefined }));
              }}
              error={fieldErrors.departedAt}
            />
            <Button type="submit" disabled={loading || !arrivedAt} loading={loading} mt="sm">
              Record Time Entry
            </Button>
          </Stack>
        </form>
      </Card>
    </PageContainer>
  );
}
