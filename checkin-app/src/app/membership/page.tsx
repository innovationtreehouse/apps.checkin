"use client";

import Link from "next/link";
import { Alert, Anchor, Box, Button, Card, Container, Group, Stack, Text, Title } from "@mantine/core";
import { AlertBanner } from "@/components/admin/AlertBanner";
import MembershipFlowStepper from "@/components/MembershipFlowStepper";
import { useConfirmNav } from "@/components/UnsavedChangesProvider";
import { PageLoader } from "@/components/ui/PageLoader";
import { useMembershipPage } from "./useMembershipPage";
import IntakePanel from "./IntakePanel";
import ExternalActionPanel from "./ExternalActionPanel";
import PaymentPanel from "./PaymentPanel";

export default function MembershipPage() {
  const {
    session, sessionStatus, state, loading, saving, setSaving, message, warnings, fieldErrors, clearErr, form,
    load, startApplication, save, submit, startSigning, renew, payment, bg,
  } = useMembershipPage();
  const confirmNav = useConfirmNav();

  if (sessionStatus === "loading" || (loading && sessionStatus === "authenticated")) {
    return <PageLoader />;
  }

  if (!session?.user) {
    return (
      <Container size="xs" py="xl">
        <Card withBorder radius="md" padding="xl" ta="center">
          <Title order={1}>Join the Treehouse</Title>
          <Text c="dimmed" my="md">Please sign in to start your membership application.</Text>
          <Button component={Link} href="/">Go to sign in</Button>
        </Card>
      </Container>
    );
  }

  const inStatus = state?.process?.status ?? null;
  const isIntake = inStatus === "INTAKE";
  const isActive = state?.membershipStatus === "ACTIVE";
  const isRenewal = state?.process?.kind === "RENEWAL";
  // Steps whose every action is the lead's — household details, contract signing,
  // background-check consent, dues and checkout. Each backing route refuses a
  // non-lead, so rendering the controls for one would only produce a 403.
  const isLeadOnlyStep = isIntake || inStatus === "PENDING_EXTERNAL_ACTION" || inStatus === "PENDING_PAYMENT";

  return (
    <Container size="lg" pb="md">
      <Group justify="space-between" align="center" wrap="wrap" mb="lg">
        <Title order={1}>Treehouse Membership</Title>
        <Button component={Link} href="/" variant="default" onNavigate={(e) => { if (!confirmNav()) e.preventDefault(); }}>← Home</Button>
      </Group>

      {/* Intake echoes `message` in a section-local Alert next to its buttons
          (long card), so suppress the top banner there to avoid a duplicate. */}
      <AlertBanner message={isIntake ? undefined : message?.text} tone={message?.tone} mb="lg" />

      {warnings.length > 0 && (
        <Alert color="yellow" mb="lg" title="Saved — with a couple of things to know">
          <Stack gap="xs">
            {warnings.map((w, i) => <Text key={i} size="sm">{w}</Text>)}
          </Stack>
        </Alert>
      )}

      {/* Your own agreement, not your household's — an adult can't be bound by a
          parent's signature. Rendered above the household flow and independent of it:
          the subject is usually a non-lead in a settled member household, where every
          branch below shows "you're a member" and nothing else. */}
      {state?.personAgreement && (
        <Card withBorder radius="md" padding="lg" mb="lg" maw={640}>
          <Title order={2}>Sign your individual membership agreement</Title>
          <Text c="dimmed" my="md">
            You&apos;re 18 or older, so you sign your own membership agreement rather than
            being covered by your household&apos;s. Have your insurance details handy — the
            agreement asks for your provider and policy number.
          </Text>
          <Button disabled={saving} loading={saving} onClick={startSigning}>
            {state.personAgreement.started ? "Resume signing →" : "Sign your agreement →"}
          </Button>
        </Card>
      )}

      {!state?.process ? (
        isActive ? (
          <Card withBorder radius="md" padding="xl">
            <Title order={2}>You&apos;re a member 🎉</Title>
            <Text c="dimmed" mt="sm">Your household membership is active. Thank you for being part of the Treehouse!</Text>
          </Card>
        ) : (
          <Card withBorder radius="md" padding="xl" maw={640}>
            <Title order={2}>Become a member</Title>
            <Text c="dimmed" my="md">
              Membership is for your whole household. We&apos;ll collect some information about your
              family, then walk you through signing a contract, a background check, and payment. You
              can stop and resume anytime.
            </Text>
            {state?.isLead ? (
              <Button disabled={saving} loading={saving} onClick={startApplication}>Start application</Button>
            ) : (
              <Text c="dimmed">Only a household lead can start the membership application. Ask your household&apos;s lead to begin.</Text>
            )}
          </Card>
        )
      ) : isRenewal && inStatus === "PENDING_RENEWAL" && !state.isLead ? (
        <Card withBorder radius="md" padding="xl" maw={640}>
          <Title order={2}>Your household is up for renewal</Title>
          <Text c="dimmed" mt="sm">
            Your household lead will confirm the renewal — nothing for you to do right now. Your
            membership stays active in the meantime.
          </Text>
        </Card>
      ) : isRenewal && inStatus === "PENDING_RENEWAL" ? (
        <Card withBorder radius="md" padding="xl" maw={640}>
          <Title order={2}>Time to renew</Title>
          <Text c="dimmed" my="md">
            Your household membership is up for renewal. You&apos;re still an active member — confirm
            below to continue for another year. You&apos;ll sign a fresh membership agreement; a new
            background check is only needed if your previous one has expired.
          </Text>
          <Text c="dimmed" mb="md">
            Did anything change — new members, address, phone, or email?{" "}
            <Anchor component={Link} href="/my-household">Update your household details first</Anchor>.
          </Text>
          <Button disabled={saving} loading={saving} onClick={renew}>Renew now</Button>
        </Card>
      ) : isRenewal && inStatus === "RENEWAL_PENDING_BG" ? (
        <Card withBorder radius="md" padding="xl" maw={640}>
          <Title order={2}>Renewal in progress</Title>
          <Text c="dimmed" mt="md">
            We&apos;re re-confirming your household&apos;s background check (the previous one has
            expired). You&apos;ll be able to pay once that&apos;s done. Your membership stays active
            in the meantime.
          </Text>
        </Card>
      ) : (
        <Group align="flex-start" gap="xl" wrap="wrap">
          {/* Renewals ride the same stepper as new applications — same phases, same
              progress, whether the background check is valid, expired, or first-time. */}
          <Box style={{ flex: "0 1 auto", maxWidth: "100%", overflowX: "auto" }}>
            <MembershipFlowStepper currentStatus={inStatus} />
          </Box>

          <Box style={{ flex: "1 1 420px", minWidth: "min(320px, 100%)" }}>
            {!state.isLead && isLeadOnlyStep ? (
              <Card withBorder radius="md" padding="lg">
                <Title order={2} mb="sm">Membership application in progress</Title>
                <Text c="dimmed">
                  Your household&apos;s membership application is in progress. Your household lead
                  will complete it — nothing for you to do right now.
                </Text>
              </Card>
            ) : isIntake ? (
              <IntakePanel form={form} fieldErrors={fieldErrors} clearErr={clearErr} message={message} saving={saving} onSave={save} onSubmit={submit} />
            ) : inStatus === "PENDING_EXTERNAL_ACTION" ? (
              <ExternalActionPanel external={state.external} isRenewal={isRenewal} saving={saving} onSign={startSigning} onRefresh={load} bg={bg} />
            ) : inStatus === "PENDING_PAYMENT" ? (
              <PaymentPanel processId={state.process.id} bgCleared={!!state.external?.bgCleared} saving={saving} setSaving={setSaving} controls={payment} />
            ) : inStatus === "PENDING_BG_CLEARANCE" ? (
              <Card withBorder radius="md" padding="lg">
                <Title order={2} mb="sm">Payment received 🎉</Title>
                <Text c="dimmed">
                  Thanks — your dues are paid. We&apos;re just finishing your background check. Your
                  membership activates automatically the moment it clears, and we&apos;ll email you
                  then. Nothing else to do.
                </Text>
              </Card>
            ) : (
              <Card withBorder radius="md" padding="xl">
                <Title order={2}>Application in progress</Title>
                <Text c="dimmed" mt="sm">
                  Your information is in. Follow the steps on the left — the next stages (background
                  check and payment) will appear here as they open.
                </Text>
              </Card>
            )}
          </Box>
        </Group>
      )}
    </Container>
  );
}
