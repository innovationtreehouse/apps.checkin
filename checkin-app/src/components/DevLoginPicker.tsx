"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { Card, Center, Divider, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useCheckinEnv } from "@/components/EnvProvider";
import { RoleBadge } from "@/components/ui/RoleBadge";

interface Persona {
  id: number;
  email: string;
  name: string | null;
  isSysadmin: boolean;
  isBoardMember: boolean;
  isKeyholder: boolean;
  isBackgroundCheckReviewer: boolean;
  dateOfBirth: string | null;
  householdId: number | null;
  toolStatuses: { toolId: number; level: string }[];
}

/**
 * DevLoginPicker — renders a list of debug personas for quick login.
 * Only rendered in dev mode when the user is NOT signed in.
 */
export default function DevLoginPicker({ callbackUrl = "/" }: { callbackUrl?: string }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const checkinEnv = useCheckinEnv();

  useEffect(() => {
    fetch("/api/auth/dev-personas", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        setPersonas(data.personas || []);
        setNow(Date.now());
        setLoading(false);
      })
      .catch(() => {
        setNow(Date.now());
        setLoading(false);
      });
  }, []);

  const handleLogin = (persona: Persona) => {
    setSigningIn(persona.email);
    // Initial local login: no current session, so the mint is a plain login as this persona
    // (impersonatedBy stays null). The same flow handles impersonation once signed in.
    signIn("persona-mint", { personaId: String(persona.id), mode: "impersonate", callbackUrl });
  };

  // Local only: mint a brand-new empty registrant (server generates the identity), then log in
  // as it via the same persona-mint. Exercises the auth-first first-time intake path on a laptop.
  const handleNewRegistrant = async () => {
    setSigningIn("__new__");
    const res = await fetch("/api/auth/dev-personas", { method: "POST" });
    if (!res.ok) { setSigningIn(null); return; }
    const { personaId } = await res.json();
    signIn("persona-mint", { personaId: String(personaId), mode: "impersonate", callbackUrl });
  };

  // The four participant-role badges render through the shared RoleBadge (its ROLE_META
  // is the one source of truth for role colors). The three derived, non-role labels below
  // (Certified/Household/Student) have no ROLE_META entry, so a fake `_`-prefixed role plus
  // a label override renders them through the same component with the gray fallback.
  const getRoleBadges = (p: Persona): { role: string; label?: string }[] => {
    const badges: { role: string; label?: string }[] = [];
    if (p.isSysadmin) badges.push({ role: "isSysadmin" });
    if (p.isBoardMember) badges.push({ role: "isBoardMember" });
    if (p.isKeyholder) badges.push({ role: "isKeyholder" });
    if (p.isBackgroundCheckReviewer) badges.push({ role: "isBackgroundCheckReviewer" });
    if (p.toolStatuses?.length > 0) badges.push({ role: "_certified", label: "Certified" });
    if (p.householdId) badges.push({ role: "_household", label: "Household" });
    if (p.dateOfBirth && now !== null) {
      const age = Math.floor((now - new Date(p.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 18) badges.push({ role: "_student", label: `Student (${age})` });
    }
    return badges;
  };

  // checkinEnv comes from EnvProvider (server-resolved) and fails safe to 'prod'
  // when unset — a client bundle has no server env of its own to read.
  if (checkinEnv === 'prod') return null;

  if (loading) {
    return (
      <Center mt="md">
        <Text c="dimmed">Loading dev personas...</Text>
      </Center>
    );
  }

  if (personas.length === 0) return null;

  return (
    <Stack mt="md" w="100%">
      <Divider label="🛠 Dev Quick Login" labelPosition="center" />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        {personas.map((p) => (
          <Card
            key={p.id}
            id={`dev-login-${p.email.split("@")[0].replace(/\./g, "-")}`}
            withBorder
            radius="md"
            padding="sm"
            onClick={() => { if (!signingIn) handleLogin(p); }}
            style={{
              cursor: signingIn ? "wait" : "pointer",
              opacity: signingIn && signingIn !== p.email ? 0.5 : 1,
            }}
          >
            <Text fw={600} size="sm">
              {signingIn === p.email ? "⏳ " : ""}{p.name || p.email}
            </Text>
            <Text size="xs" c="dimmed">{p.email}</Text>
            {getRoleBadges(p).length > 0 && (
              <Group gap={4} mt={4}>
                {getRoleBadges(p).map((b) => (
                  <RoleBadge key={b.role} role={b.role} label={b.label} size="xs" />
                ))}
              </Group>
            )}
          </Card>
        ))}
        {checkinEnv === "local" && (
          <Card
            id="dev-login-new-registrant"
            withBorder
            radius="md"
            padding="sm"
            onClick={() => { if (!signingIn) handleNewRegistrant(); }}
            style={{
              cursor: signingIn ? "wait" : "pointer",
              opacity: signingIn && signingIn !== "__new__" ? 0.5 : 1,
              borderStyle: "dashed",
            }}
          >
            <Text fw={600} size="sm">
              {signingIn === "__new__" ? "⏳ " : "＋ "}New registrant (fresh household)
            </Text>
            <Text size="xs" c="dimmed">Brand-new empty user — tests the first-time intake path</Text>
          </Card>
        )}
      </SimpleGrid>
    </Stack>
  );
}
