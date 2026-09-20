"use client";

import { useEffect, useState, Suspense, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, Badge, Box, Card, Center, Group, Loader, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAutoCycle } from "../../../hooks/useAutoCycle";
import { usePolling } from "@/hooks/usePolling";
import { getKioskDisplayNames } from "@/lib/kiosk-names";
import { ToolLevelBadge, toToolLevel, toolLevelDot } from "@/components/ToolLevelBadge";

import { PageLoader } from "@/components/ui/PageLoader";
type ToolStatusLevel = "BASIC" | "DOF" | "CERTIFIED" | "INSTRUCTOR" | "MAY_CERTIFY_OTHERS";

type Person = {
  id: number;
  // Display name resolved server-side (real name, else email-prefix); never the raw email (#329).
  name: string;
  // The name this person goes by; stands in for the first name in the grid.
  nickname?: string | null;
  toolStatuses: {
    toolId: number;
    level: ToolStatusLevel;
  }[];
};

type Tool = {
  id: number;
  name: string;
};

// Cert levels shown in the legend; the dot colors come from the regulated ToolLevelBadge.
const LEGEND_LEVELS: ToolStatusLevel[] = ["BASIC", "CERTIFIED", "DOF", "INSTRUCTOR", "MAY_CERTIFY_OTHERS"];

export default function KioskCertificationsDisplay() {
  return (
    <Suspense fallback={<PageLoader minHeight="100vh" />}>
      <KioskCertificationsInner />
    </Suspense>
  );
}

function KioskCertificationsInner() {
  const searchParams = useSearchParams();
  const limitToPresent = searchParams.get('limit_to_present') !== 'false';
  const [isKioskMode, setIsKioskMode] = useState(searchParams.get('mode') === 'kiosk' || !!searchParams.get('sig'));
  const [participants, setParticipants] = useState<Person[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);

  useEffect(() => {
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      // Pass kiosk signature headers if present in URL params
      const headers: Record<string, string> = {};
      const sigParam = searchParams.get("sig");
      const tsParam = searchParams.get("ts");
      const nonceParam = searchParams.get("nonce");

      if (sigParam && tsParam && nonceParam) {
        headers["x-kiosk-signature"] = sigParam;
        headers["x-kiosk-timestamp"] = tsParam;
        headers["x-kiosk-nonce"] = nonceParam;
      }

      const res = await fetch(`/api/kioskdisplay/certifications?limit_to_present=${limitToPresent}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.participants && data.tools) {
        setParticipants(data.participants);
        setTools(data.tools);
        setError(null);
        if (sigParam) {
          setIsKioskMode(true);
        }
      } else if (!res.ok) {
        setError(data.error || "Failed to load certifications data");
      }
    } catch (error) {
      console.error("Failed to fetch certifications data:", error);
      notifications.show({ color: "red", message: "Network error", autoClose: false });
    } finally {
      setLoading(false);
    }
  }, [searchParams, limitToPresent]);

  // Visibility gate only, NO idle-stop: this is an unattended wall display, so
  // idle-stop would freeze it. It's also cookieless (kiosk signature, not a
  // session), so it can't wake a slept env and can't defeat the overnight curfew.
  usePolling(fetchData, 10000);

  const getColorForLevel = (level: ToolStatusLevel | undefined) =>
    level ? toolLevelDot(toToolLevel(level)) : "transparent";

  // Abbreviate tool name for kiosk: stack words vertically, shorten long words
  const compactToolName = (name: string) => {
    const MAX_WORD_LEN = 6;
    return name.split(/\s+/).map(word => (word.length > MAX_WORD_LEN ? word.slice(0, MAX_WORD_LEN - 1) + '.' : word));
  };

  // Sort by the name the row actually shows — the nickname where there is one, else the
  // first name (name is server-resolved, email-prefix included).
  const sortAlphabetically = (a: Person, b: Person) => {
    const getFirstName = (p: Person) => {
      const nickname = p.nickname?.trim();
      if (nickname) return nickname.toLowerCase();
      if (p.name.includes(',')) return p.name.split(',')[1].trim().toLowerCase();
      return p.name.split(' ')[0].toLowerCase();
    };
    const firstA = getFirstName(a);
    const firstB = getFirstName(b);
    if (firstA !== firstB) return firstA.localeCompare(firstB);
    return a.name.localeCompare(b.name);
  };

  const sortedParticipants = [...participants].sort(sortAlphabetically);

  const displayNames = useMemo(() => getKioskDisplayNames(sortedParticipants), [sortedParticipants]);

  const { containerRef, visibleItems, currentPage, totalPages, isTransitioning } = useAutoCycle({
    items: sortedParticipants,
    intervalMs: 8000,
    rowHeight: 42,
    headerHeight: 42,
  });

  const cellBorder = '1px solid var(--mantine-color-default-border)';

  const renderVisitRow = (participant: Person, index: number) => (
    <tr key={participant.id} style={{ borderBottom: index % 2 === 1 ? '3px solid var(--mantine-color-default-border)' : cellBorder }}>
      <td style={{ padding: isKioskMode ? '0.5rem 0.75rem' : '0.75rem 1rem', position: 'sticky', left: 0, background: 'var(--mantine-color-body)', zIndex: 5, borderRight: cellBorder }}>
        <Text fw={isKioskMode ? 700 : 500} fz={isKioskMode ? '1.1rem' : undefined} truncate>
          {displayNames.get(participant.id) || participant.name}
        </Text>
      </td>
      {tools.map((tool) => {
        const status = participant.toolStatuses.find(ts => ts.toolId === tool.id);
        const bgColor = getColorForLevel(status?.level);
        const opacity = status ? 0.8 : 1;

        return (
          <td key={tool.id} style={{ padding: 0, textAlign: 'center', borderRight: cellBorder, height: '100%' }}>
            <div style={{ width: '100%', height: '100%', minHeight: isKioskMode ? '36px' : '48px', background: bgColor, opacity }} />
          </td>
        );
      })}
    </tr>
  );

  return (
    <Box
      style={{
        // Kiosk renders bare (no AppShell) and fills the viewport via absolute
        // inset. In-app this lives inside AppShell.Main, where absolute inset
        // escapes over the header/navbar — so use normal flow with a height that
        // clears the 60px header + 28px footer + md padding (#594).
        ...(isKioskMode
          ? { position: 'absolute' as const, inset: 0, height: '100%', cursor: 'none' }
          : { height: 'calc(100dvh - 120px)' }),
        minHeight: 0,
        padding: isKioskMode ? '1.5rem' : '2rem 1rem',
        overflow: 'hidden',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Card withBorder radius="md" padding={isKioskMode ? 'xs' : 'md'} style={{ width: "100%", maxWidth: isKioskMode ? "100%" : 1200, margin: "0 auto", flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Group justify="space-between" align="center" wrap="wrap" mb="md" style={{ flexShrink: 0 }}>
          <Group align="center" wrap="wrap">
            <Group align="center" wrap="wrap">
              <Title order={1} fz="clamp(1.5rem, 4vw, 2rem)">Live Certifications</Title>
              <Badge color={limitToPresent ? 'teal' : 'gray'} variant="light" size="lg">
                {limitToPresent ? `${participants.length} People Present` : `${participants.length} Total Members`}
              </Badge>
            </Group>
            <Group gap="sm" align="center">
              <Text fw={700} size="sm">Legend:</Text>
              {LEGEND_LEVELS.map((lvl) => (
                <ToolLevelBadge key={lvl} level={toToolLevel(lvl)} short size="sm" />
              ))}
            </Group>
          </Group>
          {currentTime && (
            <Group align="center" gap="lg">
              {totalPages > 1 && (
                <Text fz="1.5rem" fw={600} c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {currentPage + 1} / {totalPages}
                </Text>
              )}
              <Text fz="clamp(2rem, 5vw, 3.5rem)" fw={700} lh={1} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {currentTime.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })}
              </Text>
            </Group>
          )}
        </Group>

        {loading ? (
          <Center py="xl"><Loader /></Center>
        ) : error ? (
          <Alert color="red">{error}</Alert>
        ) : participants.length === 0 || tools.length === 0 ? (
          <Center py="xl"><Text c="dimmed">No {limitToPresent ? "active people" : "people"} found.</Text></Center>
        ) : (
          <div ref={containerRef} style={{ flex: 1, overflowX: 'hidden', borderRadius: 8, border: cellBorder, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <table style={{ borderCollapse: 'collapse', textAlign: 'left', width: '100%', tableLayout: isKioskMode ? 'fixed' : undefined }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
                <tr>
                  <th style={{ padding: isKioskMode ? '0.5rem 0.75rem' : '1rem', borderBottom: cellBorder, background: 'var(--mantine-color-default-hover)', position: 'sticky', left: 0, zIndex: 11, borderRight: cellBorder, verticalAlign: 'bottom', width: isKioskMode ? '12%' : 150, fontWeight: 700 }}>
                    Name
                  </th>
                  {tools.map((tool) => (
                    <th key={tool.id} style={{ borderBottom: cellBorder, borderRight: cellBorder, background: 'var(--mantine-color-default-hover)', fontSize: isKioskMode ? '0.8rem' : '0.875rem', fontWeight: 700, verticalAlign: 'bottom', padding: isKioskMode ? '0.4rem 0.2rem' : '0.5rem', textAlign: 'center', wordBreak: 'break-word', lineHeight: 1.2 }}>
                      {isKioskMode ? (
                        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.1 }}>
                          {compactToolName(tool.name).map((word, i) => <span key={i}>{word}</span>)}
                        </span>
                      ) : (
                        <span>{tool.name}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody style={{ opacity: isTransitioning ? 0 : 1, transition: 'opacity 0.5s ease-in-out' }}>
                {visibleItems.map((p, i) => renderVisitRow(p, i))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Box>
  );
}
