"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Alert, Button, Group, Text } from "@mantine/core";
import { useLoad } from "@/lib/api";

/**
 * Non-blocking login-time nudge for household leads whose membership is up for
 * renewal. Distinct from OnboardingGate (a hard modal) — renewal is a reminder,
 * not a gate. Dismissable for the session. Best-effort on every page: a failed read
 * shows nothing, retries nothing and moves nobody.
 */
export default function RenewalBanner() {
  const { status } = useSession();
  const [dismissed, setDismissed] = useState(false);
  const { data } = useLoad<{ renewalDue: boolean; dueDate?: string | null }>(
    status === "authenticated" ? "/api/membership/renewal-status" : null,
    { retry: false, expireOn401: false },
  );

  if (!data?.renewalDue || dismissed || sessionStorage.getItem("renewal_banner_dismissed") === "true") return null;

  const dueDate = data.dueDate ?? null;

  const dismiss = () => {
    sessionStorage.setItem("renewal_banner_dismissed", "true");
    setDismissed(true);
  };

  return (
    <Alert color="yellow" variant="light" radius={0} withCloseButton onClose={dismiss} title="Membership renewal due">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text size="sm">
          Your household membership is up for renewal{dueDate ? ` by ${dueDate}` : ""}. You&apos;re
          still active — confirm to continue for another year.
        </Text>
        <Button component={Link} href="/membership" size="xs" fz={15} color="yellow" variant="filled">
          Renew now
        </Button>
      </Group>
    </Alert>
  );
}
