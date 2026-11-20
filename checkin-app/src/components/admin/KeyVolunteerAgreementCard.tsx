"use client";

import { useState } from "react";
import { Badge, Button, Card, Group, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { errorMessage, LoadError, showError, showSuccess } from "@checkin/component-ui";
import { api, useLoad } from "@/lib/api";

/**
 * Board-only: the Key Volunteer Agreement's current version, whether its
 * document is in place, and the "new version" action that asks every Key
 * Volunteer to sign again.
 */
export function KeyVolunteerAgreementCard({ initialVersion }: { initialVersion: number }) {
  const [version, setVersion] = useState(initialVersion);
  const [bumping, setBumping] = useState(false);

  const agreement = useLoad<{ documentConfigured?: boolean }>("/api/membership/key-volunteer");
  const roles = useLoad<{ people?: { isKeyVolunteer?: boolean }[] }>("/api/roles");
  const documentConfigured = agreement.data?.documentConfigured ?? null;
  const holders = roles.data?.people ? roles.data.people.filter((p) => p.isKeyVolunteer).length : null;

  const bump = async () => {
    setBumping(true);
    try {
      const data = await api<{ agreementVersion?: number; agreementsOpened?: number }>("/api/settings/membership/key-volunteer-version", { method: "POST" });
      if (data?.agreementVersion === undefined) {
        showError("Failed to start a new agreement version");
        return;
      }
      setVersion(data.agreementVersion);
      showSuccess(`Version ${data.agreementVersion} is current. ${data.agreementsOpened ?? 0} Key Volunteer(s) asked to sign it.`);
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setBumping(false);
    }
  };

  const confirmBump = () => modals.openConfirmModal({
    title: "Start a new Key Volunteer Agreement version?",
    children: (
      <Text size="sm">
        Use this only for a material change, after the new document is in place.{" "}
        {holders === null ? "Every Key Volunteer" : `${holders} Key Volunteer${holders === 1 ? "" : "s"}`} will be
        asked to sign version {version + 1}. Nobody loses a role, but someone who has not re-signed can&apos;t be
        granted Board, BG reviewer or Finance until they do.
      </Text>
    ),
    labels: { confirm: "Start new version", cancel: "Cancel" },
    confirmProps: { color: "orange" },
    onConfirm: bump,
  });

  return (
    <Card withBorder radius="md" padding="lg">
      <Title order={3} mb="xs">Key Volunteer Agreement</Title>
      {agreement.error && <LoadError what="the agreement document status" message={agreement.error} onRetry={agreement.reload} />}
      {roles.error && <LoadError what="the Key Volunteer count" message={roles.error} onRetry={roles.reload} />}
      <Group gap="sm" mb="sm">
        <Text size="sm">Current version: <strong>{version}</strong></Text>
        {documentConfigured === true && <Badge color="green" variant="light">Document in place</Badge>}
        {documentConfigured === false && <Badge color="red" variant="light">Document not configured</Badge>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Key Volunteers sign this agreement once. Start a new version only when the agreement changes materially;
        a wording fix does not need one.
      </Text>
      <Button variant="light" color="orange" loading={bumping} onClick={confirmBump} style={{ alignSelf: "flex-start" }}>
        New version (material change)
      </Button>
    </Card>
  );
}
