"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { usePolling, POLL_IDLE_STOP_MS } from "@/hooks/usePolling";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  Alert, Anchor, Badge, Box, Button, Card, Center, Group, Loader, Modal, Paper,
  SimpleGrid, Stack, Text, TextInput, Title,
} from "@mantine/core";
import { isYouth } from "@/lib/time";
import { useOrgTime } from '@/components/TimezoneProvider';
import { PageContainer } from "@/components/ui/PageContainer";
import { formatPhone } from "@/lib/phone";
import { getKioskDisplayNames } from "@/lib/kiosk-names";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { AttendanceTabs } from "../AttendanceTabs";

import { PageLoader } from "@/components/ui/PageLoader";
import { CountBadge } from "@/components/ui/CountBadge";
import { personQueryMatcher } from "@/lib/searchId";

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
  participant: Person;
  event?: { program?: { id: number; name: string } };
};

type Counts = { keyholders: number; volunteers: number; youth: number; total: number; needReview?: number };
type SafetyFlags = { isLastKeyholder: boolean; isTwoDeepViolation: boolean };
type FullResponse = { access: "full"; attendance: Visit[]; counts: Counts; safety?: SafetyFlags };
type LimitedResponse = { access: "limited"; counts: Counts; safety?: SafetyFlags; self: Visit | null; household: Visit[] };
type AttendanceResponse = FullResponse | LimitedResponse;

function KioskDisplayInner() {
  const { formatTime } = useOrgTime();
  const searchParams = useSearchParams();
  const [isKioskMode, setIsKioskMode] = useState(searchParams.get("mode") === "kiosk");
  const { data: session } = useSession();
  const [data, setData] = useState<AttendanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState<number | null>(null);
  const [household, setHousehold] = useState<{ householdMembers: Person[] } | null>(null);
  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [searchSignOutQuery, setSearchSignOutQuery] = useState("");
  const [selectedParticipant, setSelectedParticipant] = useState<Person | null>(null);
  const [confirmCheckoutOpened, { open: openConfirmCheckout, close: closeConfirmCheckout }] = useDisclosure(false);
  const [pendingCheckoutVisitId, setPendingCheckoutVisitId] = useState<number | null>(null);
  const [forceCloseOpened, { open: openForceClose, close: closeForceClose }] = useDisclosure(false);
  const [forceCloseVisitId, setForceCloseVisitId] = useState<number | null>(null);
  const [forceCloseToken, setForceCloseToken] = useState<string | null>(null);
  const [forceCloseMessage, setForceCloseMessage] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Person[]>([]);
  const [checkingInId, setCheckingInId] = useState<number | null>(null);

  const currentUserIsSysadmin = session?.user?.isSysadmin || false;
  const currentUserIsKeyholder = session?.user?.isKeyholder || false;
  const currentUserIsBoardMember = session?.user?.isBoardMember || false;
  const currentUserHouseholdId = session?.user?.householdId || null;
  const canManuallyCheckInGlobal = currentUserIsSysadmin || currentUserIsKeyholder || currentUserIsBoardMember;
  const canAdminCheckout = currentUserIsSysadmin || currentUserIsKeyholder || currentUserIsBoardMember;
  const canCheckInHousehold = Boolean(currentUserHouseholdId);

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
      ? rawSafety
      : null;

  // Prefer the server-computed flag (the only youth signal the kiosk payload carries),
  // fall back to the birth date the privileged payload still ships. This feeds the
  // supervision columns, so an unknown birth date fails closed as youth.
  const visitIsYouth = (v: Visit) => v.participant.isYouth ?? isYouth(v.participant.dateOfBirth, { unknownIs: "youth" });

  const fullAttendance = isFull ? (data as FullResponse).attendance : [];
  const matchesSignOutQuery = personQueryMatcher(searchSignOutQuery);
  const keyholderList = fullAttendance.filter(v => v.participant.isKeyholder);
  const volunteerList = fullAttendance.filter(v => !v.participant.isKeyholder && !visitIsYouth(v));
  const youthList = fullAttendance.filter(v => visitIsYouth(v));

  const limitedHousehold = !isFull && data ? (data as LimitedResponse).household : [];
  const limitedSelf = !isFull && data ? (data as LimitedResponse).self : null;
  const householdKeyholders = limitedHousehold.filter(v => v.participant.isKeyholder);
  const householdVolunteers = limitedHousehold.filter(v => !v.participant.isKeyholder && !visitIsYouth(v));
  const householdYouth = limitedHousehold.filter(v => visitIsYouth(v));

  const isCheckedIn = isFull
    ? fullAttendance.some(v => v.participant.id === session?.user?.id)
    : limitedSelf !== null;

  useEffect(() => {
    const fetchHousehold = async () => {
      if (!currentUserHouseholdId) return;
      try {
        const res = await fetch("/api/household");
        if (res.ok) {
          const hData = await res.json();
          setHousehold(hData.household);
        }
      } catch (error) {
        console.error("Failed to fetch household:", error);
      }
    };
    if (canCheckInHousehold) fetchHousehold();
  }, [canCheckInHousehold, currentUserHouseholdId]);

  // Unattended kiosk displays must not idle-stop. The Pi proxy never puts
  // sig/ts/nonce on the iframe URL, so keying on those params froze the
  // door screen after 10 quiet minutes. Gate on mode=kiosk (the URL the
  // proxy actually loads) or the signedRequest response flag.
  const isSignedKiosk = !!(searchParams.get("sig") && searchParams.get("ts") && searchParams.get("nonce"));

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
      const json = await res.json().catch(() => ({}));
      if (res.ok && (json.access === "full" || json.access === "limited")) {
        setData(json);
        setError(null);
        if (json.signedRequest === true) setIsKioskMode(true);
      } else if (!res.ok) {
        setError(json.error || "Failed to load attendance");
      }
    } catch (error) {
      console.error("Failed to fetch attendance:", error);
      setError("Network error occurred.");
      notifications.show({ color: "red", message: "Network error", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  const isKioskDisplay = searchParams.get("mode") === "kiosk" || isSignedKiosk;
  usePolling(fetchAttendance, 60000, { idleStopMs: isKioskDisplay ? undefined : POLL_IDLE_STOP_MS });

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (typeof event.data === "object" && event.data?.type === "refresh-attendance" && event.data.attendance) {
        setData({ access: "full", attendance: event.data.attendance, counts: event.data.counts, safety: event.data.safety });
        setLoading(false);
        if (event.data.signedRequest) setIsKioskMode(true);
      } else if (event.data === "refresh-attendance") {
        fetchAttendance();
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [fetchAttendance]);

  useEffect(() => {
    const performSearch = async () => {
      if (searchQuery.length < 2) {
        setSearchResults([]);
        return;
      }
      try {
        const res = await fetch(`/api/roles`);
        if (res.ok) {
          const data = await res.json();
          const matchesSearch = personQueryMatcher(searchQuery);
          const filtered = data.people.filter((p: Person) => matchesSearch(p));
          setSearchResults(filtered);
        }
      } catch (error) {
        console.error("Search error:", error);
      }
    };
    const timeoutId = setTimeout(performSearch, 300);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const refreshAttendance = async () => {
    const headers: Record<string, string> = {};
    const sigParamsUrl = searchParams.get("sig");
    const tsParamsUrl = searchParams.get("ts");
    const nonceParamsUrl = searchParams.get("nonce");
    if (sigParamsUrl && tsParamsUrl && nonceParamsUrl) {
      headers["x-kiosk-signature"] = sigParamsUrl;
      headers["x-kiosk-timestamp"] = tsParamsUrl;
      headers["x-kiosk-nonce"] = nonceParamsUrl;
    }
    const attRes = await fetch("/api/attendance", { headers });
    const json = await attRes.json();
    if (attRes.ok && (json.access === "full" || json.access === "limited")) {
      setData(json);
      if (json.signedRequest) setIsKioskMode(true);
    }
    // Refresh nav/sub-tab building counts too — they read a separate cached fetch.
    notifyNavRefresh();
  };

  const handleForceCheckout = async (visitId: number, isSelf: boolean = false) => {
    if (!isSelf) {
      setPendingCheckoutVisitId(visitId);
      openConfirmCheckout();
      return;
    }
    await doForceCheckout(visitId, true);
  };

  const doForceCheckout = async (visitId: number, isSelf: boolean = false, token?: string) => {
    setCheckingOut(visitId);
    try {
      const res = await fetch("/api/attendance", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId, ...(token ? { forceCloseToken: token } : {}) }),
      });
      const resData = await res.json().catch(() => ({}));
      if (res.ok) {
        if (resData.facilityClosed) {
          notifications.show({ color: "yellow", message: "Facility closed — all remaining visits ended.", autoClose: 5000 });
        }
        refreshAttendance();
      } else if (resData.type === "warning" && resData.forceCloseToken) {
        setForceCloseVisitId(visitId);
        setForceCloseToken(resData.forceCloseToken);
        setForceCloseMessage(resData.error);
        openForceClose();
      } else {
        notifications.show({ color: "red", message: isSelf ? "Failed to check out." : "Failed to force checkout.", autoClose: false });
      }
    } catch (e) {
      console.error("Attendance action failed:", e);
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setCheckingOut(null);
    }
  };

  const confirmForceCheckout = async () => {
    if (pendingCheckoutVisitId === null) return;
    closeConfirmCheckout();
    const visitId = pendingCheckoutVisitId;
    setPendingCheckoutVisitId(null);
    await doForceCheckout(visitId);
  };

  const confirmFacilityClose = async () => {
    if (forceCloseVisitId === null || forceCloseToken === null) return;
    closeForceClose();
    const visitId = forceCloseVisitId;
    const token = forceCloseToken;
    setForceCloseVisitId(null);
    setForceCloseToken(null);
    setForceCloseMessage("");
    await doForceCheckout(visitId, false, token);
  };

  const handleManualCheckIn = async (participantId: number) => {
    setCheckingInId(participantId);
    try {
      const res = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "MANUAL_CHECKIN", participantId }),
      });
      if (res.ok) {
        setSearchQuery("");
        setSearchResults([]);
        refreshAttendance();
      } else {
        const d = await res.json().catch(() => ({}));
        if (d.error === "User is already checked in") {
          notifications.show({ color: "red", message: d.error, autoClose: 4000 });
          refreshAttendance();
        } else {
          notifications.show({ color: "red", message: d.error || "Action failed.", autoClose: false });
        }
      }
    } catch (e) {
      console.error("Attendance action failed:", e);
      notifications.show({ color: "red", message: "Network error.", autoClose: false });
    } finally {
      setCheckingInId(null);
    }
  };

  const checkedInIds = isFull
    ? fullAttendance.map(v => v.participant.id)
    : [...limitedHousehold.map(v => v.participant.id), ...(limitedSelf ? [limitedSelf.participant.id] : [])];
  const displayResults = searchResults.filter(p => !checkedInIds.includes(p.id));

  const kioskDisplayNames = useMemo(() => {
    if (!isKioskMode) return new Map<number, string>();
    const allVisits = [...keyholderList, ...volunteerList, ...youthList];
    return getKioskDisplayNames(allVisits.map(v => ({ id: v.participant.id, name: v.participant.name || null, nickname: v.participant.nickname, email: v.participant.email })));
  }, [isKioskMode, keyholderList, volunteerList, youthList]);

  const canSeeNames = !isKioskMode && (currentUserIsKeyholder || currentUserIsSysadmin || currentUserIsBoardMember);

  const renderPersonCard = (visit: Visit, showCheckout: boolean) => {
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
          {showCheckout && (
            <Button size="compact-xs" color="red" variant="light" onClick={() => handleForceCheckout(visit.id, visit.participant.id === session?.user?.id)} disabled={checkingOut === visit.id}>
              {checkingOut === visit.id ? "..." : "Out"}
            </Button>
          )}
        </Group>
      </Paper>
    );
  };

  const canCheckoutVisit = (visit: Visit): boolean => Boolean(
    visit.participant.id === session?.user?.id ||
    (session?.user?.householdLead &&
      visit.participant.householdId === currentUserHouseholdId)
  );

  const renderColumn = (icon: string, count: number, label: string, color: string, list: Visit[]) => (
    <div>
      <Group gap={8} mb="sm" pb="xs" style={{ borderBottom: `2px solid var(--mantine-color-${color}-5)` }}>
        <Text fz="xl">{icon}</Text>
        <div>
          <Text fz="xl" fw={800} c={color} lh={1}>{count}</Text>
          <Text size="xs" tt="uppercase" c="dimmed">{label}</Text>
        </div>
      </Group>
      <SimpleGrid cols={list.length > 10 ? 2 : 1} spacing="xs">
        {list.map(v => renderPersonCard(v, canCheckoutVisit(v)))}
      </SimpleGrid>
    </div>
  );

  const userId = session?.user?.id;

  const pageBody = (
    <>
      {!isKioskMode && <AttendanceTabs />}
      <Card withBorder radius="md" padding="lg" style={{ width: "100%", maxWidth: 1200, margin: "0 auto" }}>
        {/* Check-in button — hidden in kiosk mode */}
        {!isKioskMode && (
          <Box mb="lg">
            {!isCheckedIn ? (
              <Button
                fullWidth size="md"
                onClick={() => { if (userId) handleManualCheckIn(userId); }}
                disabled={checkingInId === userId}
                loading={checkingInId === userId}
              >
                Check Me In
              </Button>
            ) : (
              <Alert color="teal" ta="center">You are currently checked in!</Alert>
            )}
          </Box>
        )}

        {/* Header */}
        <Group justify="space-between" align="center" wrap="wrap" mb="lg">
          <Title order={1}>Current Attendance</Title>
          <Group align="center" gap="md" wrap="wrap">
            {!isKioskMode && canAdminCheckout && (
              <Button color="red" variant="light" radius="xl" size="xs" fz={15} onClick={() => setShowSignOutModal(true)}>
                Sign out a user
              </Button>
            )}
            <CountBadge intent="info" size="lg">People Present: {data ? counts.total : "—"}</CountBadge>
            {/* A number only — no names, no reasons, no link that invites a
                login on the kiosk. The panel is the copy of record. */}
            {isKioskDisplay && (counts.needReview ?? 0) > 0 && (
              <CountBadge intent="alert" size="lg">⚠ {counts.needReview} need review</CountBadge>
            )}
          </Group>
        </Group>

        {/* Household check-in buttons — hidden in kiosk mode */}
        {!isKioskMode && canCheckInHousehold && household && session?.user?.householdLead && (
          <Box mb="lg">
            <Title order={4} c="blue" mb="sm">Check In Household Members</Title>
            <Group gap="xs" wrap="wrap">
              {household.householdMembers?.filter((p) => !checkedInIds.includes(p.id)).map((p) => (
                <Button key={p.id} variant="default" onClick={() => handleManualCheckIn(p.id)} disabled={checkingInId === p.id}>
                  {checkingInId === p.id ? "..." : (p.name || p.email)}
                </Button>
              ))}
              {household.householdMembers?.filter((p) => !checkedInIds.includes(p.id)).length === 0 && (
                <Text c="dimmed" fs="italic" size="sm">All household members are currently checked in!</Text>
              )}
            </Group>
          </Box>
        )}

        {/* Admin manual check-in search — hidden in kiosk mode */}
        {!isKioskMode && canManuallyCheckInGlobal && (
          <Box mb="lg" pos="relative">
            <TextInput
              placeholder="Manually check someone in (Search by name, email, or ID)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
            />
            {displayResults.length > 0 && searchQuery.length >= 2 && (
              <Paper withBorder shadow="md" radius="sm" pos="absolute" left={0} right={0} style={{ zIndex: 10, maxHeight: 200, overflowY: "auto" }}>
                {displayResults.map((p) => (
                  <Group key={p.id} justify="space-between" p="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
                    <div>
                      <Text fw={500}>{p.name || "Unnamed"}</Text>
                      <Text size="xs" c="dimmed">{p.email}</Text>
                    </div>
                    <Button size="compact-xs" variant="light" disabled={checkingInId === p.id} onClick={() => handleManualCheckIn(p.id)}>
                      {checkingInId === p.id ? "..." : "Check In"}
                    </Button>
                  </Group>
                ))}
              </Paper>
            )}
          </Box>
        )}

        {/* Safety warnings — a missing roster reads as unknown, not as all-clear */}
        {!loading && !safety && (
          <Alert color="orange" icon="⚠️" title="Supervision status unknown" mb="lg">
            {data
              ? "Attendance loaded without safety flags, so Two-Deep Compliance and keyholder coverage cannot be checked. Verify supervision in the building."
              : "Attendance could not be loaded, so Two-Deep Compliance and keyholder coverage cannot be checked. Verify supervision in the building."}
          </Alert>
        )}
        {data && safety?.isTwoDeepViolation && (
          <Alert color="red" icon="🚨" title="Critical Warning" mb="lg">
            Two-Deep Compliance is failing! An unaccompanied youth is present without sufficient
            adult supervision.
          </Alert>
        )}
        {data && safety && !safety.isTwoDeepViolation && safety.isLastKeyholder && (
          <Alert color="yellow" icon="⚠️" title="Warning" mb="lg">
            Only one isKeyholder is currently in the building.
          </Alert>
        )}

        {/* Main content */}
        {loading ? (
          <Center py="xl"><Loader /></Center>
        ) : error ? (
          <Alert color="red">{error === "Unauthorized" ? "Access Denied: Please sign in to view attendance." : error}</Alert>
        ) : !data ? (
          <Alert color="red">Attendance is unavailable — the roster could not be loaded.</Alert>
        ) : counts.total === 0 ? (
          <Center py="xl"><Text c="dimmed">The facility is currently empty.</Text></Center>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
            {renderColumn("🔑", counts.keyholders, "Keyholders", "blue", isFull ? keyholderList : householdKeyholders)}
            {renderColumn("🤝", counts.volunteers, "Volunteers/Adults", "teal", isFull ? volunteerList : householdVolunteers)}
            {renderColumn("🎓", counts.youth, "Students", "grape", isFull ? youthList : householdYouth)}
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

      {/* Admin Sign Out Modal */}
      <Modal opened={showSignOutModal} onClose={() => setShowSignOutModal(false)} title={<Text span fw={700} fz="lg">Sign Out A User</Text>} size="lg">
        <TextInput
          placeholder="Search checked-in users..."
          value={searchSignOutQuery}
          onChange={(e) => setSearchSignOutQuery(e.currentTarget.value)}
          data-autofocus
          mb="md"
        />
        <Stack gap="xs" style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {fullAttendance.length === 0 ? (
            <Text c="dimmed" ta="center" py="xl">No one is checked in.</Text>
          ) : (
            fullAttendance
              .filter(v => matchesSignOutQuery(v.participant))
              .sort((a, b) => (a.participant.name || "").localeCompare(b.participant.name || ""))
              .map(v => (
                <Paper key={v.id} withBorder radius="md" p="sm">
                  <Group justify="space-between">
                    <div>
                      <Text fw={500}>{v.participant.name || v.participant.email.split('@')[0]}</Text>
                      <Text size="xs" c="dimmed">Arrived: {formatTime(v.arrivedAt)}</Text>
                    </div>
                    <Button color="red" variant="light" onClick={() => handleForceCheckout(v.id)} disabled={checkingOut === v.id}>
                      {checkingOut === v.id ? "Signing Out..." : "Sign Out"}
                    </Button>
                  </Group>
                </Paper>
              ))
          )}
        </Stack>
      </Modal>

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

      {/* Force Checkout Confirmation Modal */}
      <Modal
        opened={confirmCheckoutOpened}
        onClose={closeConfirmCheckout}
        title={<Text span fw={700} fz="lg">Force Checkout</Text>}
        centered
      >
        <Text mb="lg">Are you sure you want to force checkout this user?</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={closeConfirmCheckout}>Cancel</Button>
          <Button color="red" onClick={confirmForceCheckout}>Force Checkout</Button>
        </Group>
      </Modal>

      {/* Last-keyholder facility-close confirmation */}
      <Modal
        opened={forceCloseOpened}
        onClose={() => { closeForceClose(); setForceCloseToken(null); }}
        title={<Text span fw={700} fz="lg" c="red">Close Facility?</Text>}
        centered
      >
        <Alert color="yellow" mb="md">{forceCloseMessage}</Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => { closeForceClose(); setForceCloseToken(null); }}>Cancel</Button>
          <Button color="red" onClick={confirmFacilityClose}>Confirm &amp; Close Facility</Button>
        </Group>
      </Modal>
    </>
  );

  // Kiosk mode is a fullscreen board surface with its own chrome (cursor
  // hidden, content pulled up under the header); the member-facing page rides
  // the canonical PageContainer like every other page — no hand-rolled copy of
  // its margins (PR #1026 review). A plain conditional (not a per-render
  // wrapper component) so the subtree never remounts when state changes.
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
