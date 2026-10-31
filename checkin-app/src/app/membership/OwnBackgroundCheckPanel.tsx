"use client";

import { useState } from "react";
import { Anchor, Button, Card, Checkbox, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { notifyNavRefresh } from "@/lib/nav-refresh";
import { apiError, type OwnBackgroundCheck } from "./useMembershipPage";

/** Consent to the caller's own background check, apart from any household application. */
export default function OwnBackgroundCheckPanel({ check }: { check: OwnBackgroundCheck }) {
  // The confirm checkbox unlocks only once the Averity form has been opened this visit.
  const [linkOpened, setLinkOpened] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [recorded, setRecorded] = useState(false);

  const recordConsent = async () => {
    setConsenting(true);
    try {
      const res = await fetch("/api/membership/bg-consent", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRecorded(true);
        notifyNavRefresh();
      } else {
        setConsenting(false);
        notifications.show({ color: "red", message: apiError(data, "Could not record your consent. Please try again."), autoClose: false });
      }
    } catch {
      setConsenting(false);
      notifications.show({ color: "red", message: "Network error. Your consent was not recorded; please try again.", autoClose: false });
    }
  };

  const reopenLink = check.deepLinkUrl ? (
    <Anchor href={check.deepLinkUrl} target="_blank" rel="noopener noreferrer" size="sm">
      Reopen the Averity consent form →
    </Anchor>
  ) : null;

  return (
    <Card withBorder radius="md" padding="lg" mb="lg" maw={640}>
      <Title order={2}>Your background check</Title>
      {check.consented || recorded ? (
        <Stack gap="xs" mt="sm" align="flex-start">
          <Text c="green">Your consent is recorded. The background-check reviewers take it from here.</Text>
          {reopenLink}
        </Stack>
      ) : (
        <Stack gap="xs" mt="sm" align="flex-start">
          <Text c="dimmed">
            You&apos;re due a background check of your own. Consent to it on Averity, then confirm
            here so we know you&apos;ve done your part.
          </Text>
          {check.deepLinkUrl ? (
            <>
              <Button
                component="a"
                href={check.deepLinkUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setLinkOpened(true)}
              >
                Consent on Averity →
              </Button>
              <Checkbox
                label="I submitted my consent on Averity"
                description={linkOpened ? undefined : "Open the Averity form above first, then confirm here."}
                checked={consenting}
                disabled={!linkOpened || consenting}
                onChange={(e) => { if (e.currentTarget.checked) recordConsent(); }}
              />
            </>
          ) : (
            <Text c="dimmed">The background-check link isn&apos;t available yet. Please check back shortly.</Text>
          )}
        </Stack>
      )}
    </Card>
  );
}
