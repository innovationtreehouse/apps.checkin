"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Alert, Button, Group, Text } from "@mantine/core";
import { useLoad } from "@/lib/api";

/**
 * Non-blocking login-time nudge for household leads whose membership is up for
 * renewal. Distinct from OnboardingGate (a hard modal) — renewal is a reminder,
 * not a gate. A household that has said it won't renew is told it still can.
 * Dismissable for the session. Best-effort on every page: a failed read
 * shows nothing, retries nothing and moves nobody.
 */
export default function RenewalBanner() {
  const { status } = useSession();
  const [dismissed, setDismissed] = useState(false);
  const { data } = useLoad<{ renewalDue: boolean; dueDate?: string | null; wasDue?: boolean; notRenewing?: boolean }>(
    status === "authenticated" ? "/api/membership/renewal-status" : null,
    { retry: false, expireOn401: false },
  );

  if (!data?.renewalDue || dismissed || sessionStorage.getItem("renewal_banner_dismissed") === "true") return null;

  const dueDate = data.dueDate ?? null;
  const due = !dueDate ? "" : data.wasDue ? ` (it was due ${dueDate})` : ` by ${dueDate}`;

  const dismiss = () => {
    sessionStorage.setItem("renewal_banner_dismissed", "true");
    setDismissed(true);
  };

  return (
    <Alert color="yellow" variant="light" radius={0} withCloseButton onClose={dismiss}
      title={data.notRenewing ? "You've told the Board you won't be renewing" : "Membership renewal due"}>
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text size="sm">
          {data.notRenewing ? (
            <>You can still renew{due} if you change your mind.</>
          ) : (
            <>
              Your household membership is up for renewal{due}. You&apos;re
              still active — confirm to continue for another year.
            </>
          )}
        </Text>
        <Button component={Link} href="/membership" size="xs" fz={15} color="yellow" variant="filled">
          Renew now
        </Button>
      </Group>
    </Alert>
  );
}
