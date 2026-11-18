"use client";

import { useState } from "react";
import { Button, Card, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";
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
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ arrivedAt?: string; departedAt?: string }>({});
  // A household lead records for any member of their household — the only way a
  // minor's visit gets entered at all. Everyone else records for themselves.
  const [personId, setPersonId] = useState<string | null>(null);

  const isLead = !!user?.householdLead;

  const household = useLoad<{ household?: { householdMembers?: HouseholdMember[] } | null }>(ready && isLead ? "/api/household" : null);
  const members = household.data?.household?.householdMembers ?? [];

  const validateTimes = () => {
    const now = Date.now();
    const fe: { arrivedAt?: string; departedAt?: string } = {};
    const arr = new Date(arrivedAt);
    if (!arrivedAt) fe.arrivedAt = "Arrival time is required";
    else if (isNaN(arr.getTime())) fe.arrivedAt = "Invalid arrival time";
    else if (arr.getTime() > now + 5 * 60 * 1000) fe.arrivedAt = "Arrival time cannot be in the future.";
    if (!departedAt) fe.departedAt = "Departure time is required";
    else {
      const dep = new Date(departedAt);
      if (isNaN(dep.getTime())) fe.departedAt = "Invalid departure time";
      else if (dep.getTime() <= arr.getTime()) fe.departedAt = "Departure time must be after arrival time";
      else if (dep.getTime() - arr.getTime() > MAX_VISIT_MS) fe.departedAt = "A visit cannot be longer than 24 hours.";
    }
    return fe;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    const fe = validateTimes();
    if (fe.arrivedAt || fe.departedAt) {
      setFieldErrors(fe);
      return;
    }

    setLoading(true);

    try {
      await api("/api/attendance/manual", {
        method: "POST",
        // datetime-local gives a naive "YYYY-MM-DDTHH:mm" (no offset). Send a real
        // instant so the server doesn't reparse it in ITS timezone (UTC in prod).
        body: JSON.stringify({
          arrivedAt: new Date(arrivedAt).toISOString(),
          departedAt: new Date(departedAt).toISOString(),
          // Omitted = self. The server re-checks household scope regardless.
          ...(personId ? { personId: Number(personId) } : {}),
        }),
      });
      showSuccess("Visit recorded successfully.");
      setArrived("");
      setDeparted("");
      // Building occupancy badges (attendance nav) count this new visit — refresh them.
      notifyNavRefresh();
    } catch (err) {
      showError(errorMessage(err));
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
          in the building now, badge at the kiosk instead.
          {members.length > 1 && " As a household lead you can also record a visit for another member of your household."}
        </Text>

        {household.error && <LoadError what="your household" message={household.error} onRetry={household.reload} />}

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
              label="Departure Time (Required)"
              value={departedAt}
              onChange={(e) => {
                setDeparted(e.currentTarget.value);
                setFieldErrors((f) => ({ ...f, departedAt: undefined }));
              }}
              error={fieldErrors.departedAt}
              required
            />
            <Button type="submit" disabled={loading || !arrivedAt || !departedAt} loading={loading} mt="sm">
              Record Time Entry
            </Button>
          </Stack>
        </form>
      </Card>
    </PageContainer>
  );
}
