"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { usePolling, POLL_IDLE_STOP_MS } from "@/hooks/usePolling";
import { notifications } from "@mantine/notifications";
import { IconHeartHandshake, IconKey, IconSchool, type Icon } from "@tabler/icons-react";
import {
  Alert, Anchor, Badge, Box, Button, Card, Center, Group, Loader, Modal, Paper,
  SimpleGrid, Stack, Text, Title,
} from "@mantine/core";
import { isYouth } from "@/lib/time";
import { useOrgTime } from '@/components/TimezoneProvider';
import { PageContainer } from "@/components/ui/PageContainer";
import { formatPhone } from "@/lib/phone";
import { getKioskDisplayNames } from "@/lib/kiosk-names";
import { AttendanceTabs } from "../AttendanceTabs";

import { PageLoader } from "@/components/ui/PageLoader";
import { CountBadge } from "@/components/ui/CountBadge";
import { BuildingUnconfirmedAlert } from "@/components/BuildingUnconfirmedAlert";
import type { BuildingLink } from "@/lib/kioskSeen";

type Person = {
  id: number;
  email: string;
  name?: string | null;
  nickname?: string | null;
  isKeyholder: boolean;
  isSysadmin: boolean;
  // Server-computed youth classification. The kiosk payload carries this INSTEAD of
  // dateOfBirth (personal tier); privileged payloads carry both.
  isYouth?: boolean;
  dateOfBirth?: string | null;
  householdId?: number | null;
  phone?: string | null;
  household?: { emergencyContacts: { id: number; name: string; phone: string; relationship: string | null }[] } | null;
};

type Visit = {
  id: number;
  arrivedAt: string;
  // Checked in with no keyholder in the building (server-derived).
  noKeyholder?: boolean;
  participant: Person;
  event?: { program?: { id: number; name: string } };
};

type Counts = { keyholders: number; volunteers: number; youth: number; total: number; needReview?: number };
type SafetyFlags = { facilityOpen: boolean; isLastKeyholder: boolean; isTwoDeepViolation: boolean };
// kioskAsOf: the kiosk proxy served its own view (server unreachable)
// from the roster it received at this time; null when it never had one.
type FullResponse = { access: "full"; attendance: Visit[]; counts: Counts; safety?: SafetyFlags; building?: BuildingLink; kioskAsOf?: string | null };
type LimitedResponse = { access: "limited"; counts: Counts; safety?: SafetyFlags; building?: BuildingLink; self: Visit | null; household: Visit[] };
type AttendanceResponse = FullResponse | LimitedResponse;

function KioskDisplayInner() {
  const { formatTime } = useOrgTime();
  const searchParams = useSearchParams();
  const [isKioskMode, setIsKioskMode] = useState(searchParams.get("mode") === "kiosk");
  const { data: session } = useSession();
  const [data, setData] = useState<AttendanceResponse | null>(null);
  // When `data` was current: the kiosk's roster time, else when it was loaded.
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The kiosk proxy answers 204 while the building is known empty.
  const [kioskResting, setKioskResting] = useState(false);
  // Whether the roster in `data` already carries kiosk labels. The signed kiosk payload and the
  // roster the proxy pushes do; labelling those again would shorten an already-shortened name.
  // A `mode=kiosk` preview opened by a privileged session carries full names, so it is labelled
  // here instead.
  const [namesAreKioskLabels, setNamesAreKioskLabels] = useState(false);
  const [selectedParticipant, setSelectedParticipant] = useState<Person | null>(null);

  const currentUserIsSysadmin = session?.user?.isSysadmin || false;
  const currentUserIsKeyholder = session?.user?.isKeyholder || false;
  const currentUserIsBoardMember = session?.user?.isBoardMember || false;

  const isFull = data?.access === "full";
  // Absent attendance is UNKNOWN, never "empty and compliant": every count and
  // safety flag below is only meaningful while `data` is non-null, so each one is
  // rendered behind that check.
  const counts = data?.counts || { keyholders: 0, volunteers: 0, youth: 0, total: 0 };
  // Missing OR malformed `safety` is UNKNOWN, never all-clear (see
  // docs/rules/attendance-checkin.md, kiosk resilience). Both flags must be
  // actual booleans — a partial object like `{}` must not read as compliant.
  const rawSafety = data?.safety;
  const safety =
    typeof rawSafety?.isTwoDeepViolation === "boolean" && typeof rawSafety?.isLastKeyholder === "boolean"
      && typeof rawSafety?.facilityOpen === "boolean"
      ? rawSafety
      : null;
  // Off the kiosk, building state is stated as fact only while the server can
  // reach the kiosk; a missing link reads as unreachable.
  const unconfirmed = !isKioskMode && data !== null && data.building?.reachable !== true;

  // Prefer the server-computed flag (the only youth signal the kiosk payload carries),
  // fall back to the birth date the privileged payload still ships. This feeds the
  // supervision columns, so an unknown birth date fails closed as youth.
  const visitIsYouth = (v: Visit) => v.participant.isYouth ?? isYouth(v.participant.dateOfBirth, { unknownIs: "youth" });

  const fullAttendance = isFull ? (data as FullResponse).attendance : [];
  const keyholderList = fullAttendance.filter(v => v.participant.isKeyholder);
  const volunteerList = fullAttendance.filter(v => !v.participant.isKeyholder && !visitIsYouth(v));
  const youthList = fullAttendance.filter(v => visitIsYouth(v));

  const limitedHousehold = !isFull && data ? (data as LimitedResponse).household : [];
  const householdKeyholders = limitedHousehold.filter(v => v.participant.isKeyholder);
  const householdVolunteers = limitedHousehold.filter(v => !v.participant.isKeyholder && !visitIsYouth(v));
  const householdYouth = limitedHousehold.filter(v => visitIsYouth(v));

  // Unattended kiosk displays must not idle-stop. The gate includes mode=kiosk
  // because the Pi proxy loads that URL without sig/ts/nonce on it.
  const isSignedKiosk = !!(searchParams.get("sig") && searchParams.get("ts") && searchParams.get("nonce"));
  const isKioskDisplay = searchParams.get("mode") === "kiosk" || isSignedKiosk;

  const fetchAttendance = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      const sigParamsUrl = searchParams.get("sig");
      const tsParamsUrl = searchParams.get("ts");
      const nonceParamsUrl = searchParams.get("nonce");
      if (sigParamsUrl && tsParamsUrl && nonceParamsUrl) {
        headers["x-kiosk-signature"] = sigParamsUrl;
        headers["x-kiosk-timestamp"] = tsParamsUrl;
        headers["x-kiosk-nonce"] = nonceParamsUrl;
      }

      const res = await fetch("/api/attendance", { headers });
      setKioskResting(res.status === 204);
      if (res.status === 204) {
        setError(null);
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (res.ok && (json.access === "full" || json.access === "limited")) {
        setData(json);
        setAsOf(json.kioskAsOf !== undefined ? json.kioskAsOf : new Date().toISOString());
        setError(null);
        setNamesAreKioskLabels(json.signedRequest === true);
        if (json.signedRequest === true) setIsKioskMode(true);
      } else if (!res.ok) {
        setError(json.error || "Failed to load attendance");
      }
    } catch (error) {
      console.error("Failed to fetch attendance:", error);
      setError("Network error occurred.");
      if (!isKioskDisplay) notifications.show({ color: "red", message: "Network error", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, [searchParams, isKioskDisplay]);

  // The door screen never blanks, and never passes a kept or kiosk-served roster off as fresh.
  const kioskStale = isKioskDisplay && data !== null && (error !== null || (isFull && (data as FullResponse).kioskAsOf !== undefined));
  usePolling(fetchAttendance, 60000, { idleStopMs: isKioskDisplay ? undefined : POLL_IDLE_STOP_MS });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only the kiosk wrapper that frames this page, served from the same Pi proxy origin, may push a roster.
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      if (typeof event.data === "object" && event.data?.type === "refresh-attendance" && event.data.attendance) {
        setData({ access: "full", attendance: event.data.attendance, counts: event.data.counts, safety: event.data.safety });
        setAsOf(new Date().toISOString());
        setNamesAreKioskLabels(true);
        setLoading(false);
      } else if (event.data === "refresh-attendance") {
        fetchAttendance();
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchAttendance]);



  const kioskDisplayNames = useMemo(() => {
    if (!isKioskMode || namesAreKioskLabels) return new Map<number, string>();
    const allVisits = [...keyholderList, ...volunteerList, ...youthList];
    return getKioskDisplayNames(allVisits.map(v => ({ id: v.participant.id, name: v.participant.name || null, nickname: v.participant.nickname, email: v.participant.email })));
  }, [isKioskMode, namesAreKioskLabels, keyholderList, volunteerList, youthList]);

  const canSeeNames = !isKioskMode && (currentUserIsKeyholder || currentUserIsSysadmin || currentUserIsBoardMember);

  const renderPersonCard = (visit: Visit) => {
    const hue = visit.event?.program?.name
      ? visit.event.program.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360
      : 0;
    return (
      <Paper key={visit.id} withBorder radius="sm" p="xs">
        <Group justify="space-between" wrap="nowrap">
          <Box style={{ overflow: "hidden" }}>
            <Text
              fw={500} size="sm" truncate
              style={{ cursor: canSeeNames ? 'pointer' : 'default' }}
              onClick={() => { if (canSeeNames) setSelectedParticipant(visit.participant); }}
            >
              {isKioskMode ? (kioskDisplayNames.get(visit.participant.id) || visit.participant.name || visit.participant.email.split("@")[0]) : (visit.participant.name || visit.participant.email.split("@")[0])}
            </Text>
            <Group gap={6} align="center">
              <Text c="dimmed" size="xs">{formatTime(visit.arrivedAt)}</Text>
              {visit.noKeyholder && (
                <Badge size="xs" color="orange" variant="light" title="Checked in with no keyholder in the building">
                  No keyholder
                </Badge>
              )}
              {visit.event?.program?.name && (
                <Badge size="xs" variant="light" style={{ background: `hsl(${hue}, 60%, 20%)`, color: `hsl(${hue}, 80%, 80%)` }} title={visit.event.program.name}>
                  {visit.event.program.name}
                </Badge>
              )}
            </Group>
            {!isKioskMode && (currentUserIsKeyholder || currentUserIsSysadmin) && visit.participant.phone && (
              <Text size="xs" c="blue">📞 {formatPhone(visit.participant.phone)}</Text>
            )}
          </Box>
        </Group>
      </Paper>
    );
  };

  const renderColumn = (ColumnIcon: Icon, count: number, label: string, color: string, list: Visit[]) => (
    <div>
      <Group gap={8} mb="sm" pb="xs" style={{ borderBottom: `2px solid var(--mantine-color-${color}-5)` }}>
        <ColumnIcon size={28} stroke={1.75} color={`var(--mantine-color-${color}-6)`} aria-hidden />
        <div>
          <Text fz="xl" fw={800} c={color} lh={1}>{count}</Text>
          <Text size="xs" tt="uppercase" c="dimmed">{label}</Text>
        </div>
      </Group>
      <SimpleGrid cols={list.length > 10 ? 2 : 1} spacing="xs">
        {list.map(v => renderPersonCard(v))}
      </SimpleGrid>
    </div>
  );

  const pageBody = (
    <>
      {!isKioskMode && <AttendanceTabs />}
      <Card withBorder radius="md" padding="lg" style={{ width: "100%", maxWidth: 1200, margin: "0 auto" }}>
        {/* Header */}
        <Group justify="space-between" align="center" wrap="wrap" mb="lg">
          <Title order={1}>Current Attendance</Title>
          <Group align="center" gap="md" wrap="wrap">
            {kioskStale && <Text size="sm" c="dimmed">Not up to date{asOf ? ` — as of ${formatTime(asOf)}` : ""}</Text>}
            <CountBadge intent="info" size="lg">
              {unconfirmed ? "Checked in (unconfirmed)" : "People Present"}: {data ? counts.total : "—"}
            </CountBadge>
            {/* A number only — no names, no reasons, no link that invites a
                login on the kiosk. The panel is the copy of record. */}
            {isKioskDisplay && (counts.needReview ?? 0) > 0 && (
              <CountBadge intent="alert" size="lg">⚠ {counts.needReview} need review</CountBadge>
            )}
          </Group>
        </Group>

        {/* Safety warnings — a missing roster reads as unknown, not as all-clear */}
        {unconfirmed && <BuildingUnconfirmedAlert lastSeenAt={data?.building?.lastSeenAt} mb="lg" />}
        {!loading && !unconfirmed && !safety && (
          <Alert color="orange" icon="⚠️" title="Supervision status unknown" mb="lg">
            {data
              ? "Attendance loaded without safety flags, so Two-Deep Compliance and keyholder coverage cannot be checked. Verify supervision in the building."
              : "Attendance could not be loaded, so Two-Deep Compliance and keyholder coverage cannot be checked. Verify supervision in the building."}
          </Alert>
        )}
        {data && !unconfirmed && safety?.isTwoDeepViolation && (
          <Alert color="red" icon="🚨" title="Critical Warning" mb="lg">
            Two-Deep Compliance is failing! An unaccompanied youth is present without sufficient
            adult supervision.
          </Alert>
        )}
        {data && !unconfirmed && safety && !safety.facilityOpen && counts.total > 0 && (
          <Alert color="orange" icon="🔒" title="Facility closed — no keyholder present" mb="lg">
            The people below checked in without a keyholder in the building. The facility is not
            open until a keyholder checks in.
          </Alert>
        )}
        {data && !unconfirmed && safety && !safety.isTwoDeepViolation && safety.isLastKeyholder && (
          <Alert color="yellow" icon="⚠️" title="Warning" mb="lg">
            Only one isKeyholder is currently in the building.
          </Alert>
        )}

        {/* Main content */}
        {loading ? (
          <Center py="xl"><Loader /></Center>
        ) : error && !kioskStale ? (
          <Alert color="red">{error === "Unauthorized" ? "Access Denied: Please sign in to view attendance." : error}</Alert>
        ) : !data && kioskResting ? (
          <Center py="xl"><Text c="dimmed">Kiosk resting — zzz. Badge in to wake it.</Text></Center>
        ) : !data ? (
          <Alert color="red">Attendance is unavailable — the roster could not be loaded.</Alert>
        ) : counts.total === 0 ? (
          <Center py="xl"><Text c="dimmed">{unconfirmed ? "No open visits recorded." : "The facility is currently empty."}</Text></Center>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
            {renderColumn(IconKey, counts.keyholders, "Keyholders", "blue", isFull ? keyholderList : householdKeyholders)}
            {renderColumn(IconHeartHandshake, counts.volunteers, "Volunteers/Adults", "teal", isFull ? volunteerList : householdVolunteers)}
            {renderColumn(IconSchool, counts.youth, "Students", "grape", isFull ? youthList : householdYouth)}
          </SimpleGrid>
        )}

        {/* Privacy notice for limited access */}
        {!isFull && counts.total > 0 && (
          <Paper withBorder radius="md" p="sm" mt="lg" ta="center">
            <Text size="sm" c="dimmed">
              🔒 Individual names are only visible to administrators and on the facility kiosk.
              {limitedHousehold.length > 0 && " Your household members are shown above."}
            </Text>
          </Paper>
        )}
      </Card>

      {/* Emergency Contact Modal */}
      <Modal
        opened={!!selectedParticipant}
        onClose={() => setSelectedParticipant(null)}
        title={<Text span fw={700} fz="lg" c="yellow">🆘 Emergency Contact Info</Text>}
        centered
      >
        {selectedParticipant && (
          <>
            <Stack align="center" gap={4} mb="lg">
              <Text fz="xl" fw={700}>{selectedParticipant.name || selectedParticipant.email.split('@')[0]}</Text>
              {selectedParticipant.phone && (
                <Text c="dimmed">User Phone: <Anchor href={`tel:${selectedParticipant.phone.replace(/\D/g, '')}`} c="teal">{formatPhone(selectedParticipant.phone)}</Anchor></Text>
              )}
            </Stack>
            <Alert color="red" variant="light" ta="center">
              {selectedParticipant.household?.emergencyContacts && selectedParticipant.household.emergencyContacts.length > 0 ? (
                <Stack gap="md">
                  <Text size="sm" c="dimmed" tt="uppercase">Emergency Contact{selectedParticipant.household.emergencyContacts.length > 1 ? "s" : ""}</Text>
                  {selectedParticipant.household.emergencyContacts.map((c) => (
                    <div key={c.id}>
                      <Text fz="lg" fw={700} mb="xs">
                        {c.name}{c.relationship ? <Text component="span" c="dimmed" fz="sm"> ({c.relationship})</Text> : null}
                      </Text>
                      <Anchor href={`tel:${c.phone.replace(/\D/g, '')}`} c="red" fz="xl">
                        📞 {formatPhone(c.phone)}
                      </Anchor>
                    </div>
                  ))}
                </Stack>
              ) : (
                <>
                  <Text fw={700} mb={4}>No Emergency Contact on File</Text>
                  <Text size="sm" c="dimmed">This user&apos;s household has not registered an emergency contact.</Text>
                </>
              )}
            </Alert>
            <Group justify="flex-end" mt="lg">
              <Button variant="default" onClick={() => setSelectedParticipant(null)}>Close</Button>
            </Group>
          </>
        )}
      </Modal>

    </>
  );

  // Kiosk mode is a fullscreen board surface with its own chrome (cursor
  // hidden, content pulled up under the header); the member-facing page rides
  // the canonical PageContainer like every other page. A plain conditional
  // (not a per-render wrapper component) so the subtree never remounts when
  // state changes.
  return isKioskMode ? (
    <Box style={{ cursor: "none", marginTop: -25, paddingLeft: 8, display: "flow-root" }}>{pageBody}</Box>
  ) : (
    <PageContainer>{pageBody}</PageContainer>
  );
}

export default function KioskDisplay() {
  return (
    <Suspense fallback={<PageLoader minHeight="100vh" />}>
      <KioskDisplayInner />
    </Suspense>
  );
}
