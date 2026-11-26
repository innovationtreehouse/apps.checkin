"use client";

import { useState, Suspense } from 'react';
import { useOrgTime } from "@/components/TimezoneProvider";
import { useSearchParams } from 'next/navigation';
import { useRequireRole } from '@/hooks/useRequireRole';
import { MEMBERSHIP_OPS_ADMIN_ROLES } from '@/lib/nav/sections/membershipOps';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { EntityPicker } from '@/components/admin/EntityPicker';
import { isYouth } from '@/lib/time';
import { Button, Card, Checkbox, Container, Paper, Stack, Text, TextInput } from '@mantine/core';
import { errorMessage, HttpError, LoadError, showError, showSuccess } from '@checkin/component-ui';
import { api, useLoad } from '@/lib/api';

import { PageLoader } from "@/components/ui/PageLoader";
type HouseholdOption = {
  id: number;
  name: string;
  householdMembers: { id: number; name: string | null; email: string | null }[];
};

export default function NewParticipantPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <NewParticipantForm />
    </Suspense>
  );
}

function NewParticipantForm() {
  const today = useOrgTime().today();
  const { ready, loading: authLoading } = useRequireRole(MEMBERSHIP_OPS_ADMIN_ROLES);
  const searchParams = useSearchParams();
  const queryHouseholdId = searchParams.get('householdId');

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [parentName, setParentName] = useState("");
  const [parentDob, setParentDob] = useState("");
  const [parentOver25, setParentOver25] = useState(false);
  const [dob, setDob] = useState("");
  const [over25, setOver25] = useState(false);

  // Household selection state (the EntityPicker owns the transient query/results)
  const [householdId, setHouseholdId] = useState("");
  const [householdSearch, setHouseholdSearch] = useState("");

  const isYouthSelected = isYouth(dob, today);

  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string }>({});

  const { data: linked, error: linkedError, reload: reloadLinked } = useLoad<{ household?: { id: number; name: string | null } }>(
    ready && queryHouseholdId ? `/api/membership-ops/households?id=${queryHouseholdId}` : null,
  );
  // The linked household fills an empty picker, including after each save, until staff clear it.
  const [linkCleared, setLinkCleared] = useState(false);
  const linkedHousehold = linked?.household;
  if (linkedHousehold && householdId === "" && !linkCleared) {
    setHouseholdId(linkedHousehold.id.toString());
    setHouseholdSearch(linkedHousehold.name || `Household #${linkedHousehold.id}`);
  }

  if (authLoading) {
    return <PageLoader />;
  }

  if (!ready) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFieldErrors({});

    try {
      const data = await api<{ participant: { email: string | null } }>('/api/membership-ops/participants', {
        method: 'POST',
        body: JSON.stringify({
          name,
          email: email || null,
          parentEmail: isYouthSelected ? parentEmail : null,
          parentName: isYouthSelected && parentEmail ? parentName : null,
          ...(isYouthSelected && parentEmail && { parentDob: parentOver25 ? null : (parentDob || null), parentOver25 }),
          dob: over25 ? null : (dob || null),
          over25,
          householdId: householdId ? parseInt(householdId) : null
        })
      });

      showSuccess(`Participant ${name || data.participant.email || 'created'} successfully!`);
      setName("");
      setEmail("");
      setParentEmail("");
      setParentName("");
      setParentDob("");
      setParentOver25(false);
      setDob("");
      setOver25(false);
      setHouseholdId("");
      setHouseholdSearch("");
    } catch (err) {
      if (err instanceof HttpError && err.fields.includes("email")) setFieldErrors({ email: "This email is already registered." });
      else showError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const submitDisabled = saving || !name.trim() || (!dob && !over25) || (!isYouthSelected && !email && !householdId) || (isYouthSelected && !parentEmail && !householdId) || (isYouthSelected && !!parentEmail && (!parentName.trim() || (!parentDob && !parentOver25)));

  return (
    <Container size="md" pb="md">
      <Card withBorder radius="md" padding="lg">
        <AdminPageHeader
          title="Register New User"
          back={queryHouseholdId
            ? { href: '/membership-ops/households', label: '← Households' }
            : { href: '/membership-ops', label: '← Membership Ops' }}
          mb="md"
        />

        <Text c="dimmed" mb="lg">
          System Administrators can manually register a new participant into the database. When they
          log in via their Google email for the first time, their account will instantly link to
          this profile.
        </Text>


        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Full Name"
              description="Printed on name badges exactly as typed — please double-check the spelling."
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Jane Doe"
            />

            <Checkbox
              label="Individual is over 25"
              checked={over25}
              onChange={(e) => { setOver25(e.currentTarget.checked); if (e.currentTarget.checked) setDob(""); }}
            />

            {!over25 && (
              <TextInput
                type="date"
                label="Date of Birth"
                description={isYouthSelected ? 'Student Detected' : undefined}
                value={dob}
                onChange={(e) => setDob(e.currentTarget.value)}
                maw={300}
              />
            )}

            <TextInput
              type="email"
              label={`Participant Google Email ${isYouthSelected ? '(Optional for Students)' : ''}`}
              required={!isYouthSelected && !householdId}
              value={email}
              error={fieldErrors.email}
              onChange={(e) => { setEmail(e.currentTarget.value); setFieldErrors((fe) => ({ ...fe, email: undefined })); }}
              placeholder="jane.doe@example.com"
            />

            {isYouthSelected && (
              <Paper withBorder radius="md" p="md" bg="var(--mantine-color-grape-light)">
                <TextInput
                  type="email"
                  label={`Parent / Guardian Google Email ${!householdId ? '' : '(Optional)'}`}
                  description="Because the participant is under 18, a parent or guardian's email is required to associate their accounts — unless you assign them to an existing household below."
                  required={isYouthSelected && !householdId}
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.currentTarget.value)}
                  placeholder="parent@example.com"
                />
                {parentEmail && (
                  <TextInput
                    label="Parent / Guardian Name"
                    description="Required in case this parent is not already in the system. Printed on name badges exactly as typed — please double-check the spelling."
                    required
                    value={parentName}
                    onChange={(e) => setParentName(e.currentTarget.value)}
                    placeholder="e.g. John Doe"
                    mt="sm"
                  />
                )}
                {parentEmail && (
                  <Checkbox
                    label="Parent / guardian is over 25"
                    checked={parentOver25}
                    onChange={(e) => { setParentOver25(e.currentTarget.checked); if (e.currentTarget.checked) setParentDob(""); }}
                    mt="sm"
                  />
                )}
                {parentEmail && !parentOver25 && (
                  <TextInput
                    type="date"
                    label="Parent / Guardian Date of Birth"
                    description="Required in case this parent is not already in the system."
                    value={parentDob}
                    onChange={(e) => setParentDob(e.currentTarget.value)}
                    mt="sm"
                    maw={300}
                  />
                )}
              </Paper>
            )}

            {/* Household Selector */}
            <Paper withBorder radius="md" p="md">
              {linkedError && <LoadError what="the linked household" message={linkedError} onRetry={reloadLinked} />}
              <EntityPicker<HouseholdOption>
                label="Add to Existing Household (Optional)"
                description="Search by household name or member name/email. If left blank, a new household will be created automatically for adults."
                placeholder="Search households..."
                selectedId={householdId || null}
                selectedLabel={householdSearch}
                search={(q) => api<{ households?: HouseholdOption[] }>(`/api/membership-ops/households?q=${encodeURIComponent(q)}`)
                  .then((data) => data.households ?? [], () => [])}
                getOptionLabel={(h) => h.name || `Household #${h.id}`}
                getOptionDescription={(h) => h.householdMembers.map((p) => p.name || p.email || 'Unnamed').join(', ') || 'Empty'}
                onSelect={(h) => { setHouseholdId(h.id.toString()); setHouseholdSearch(h.name || `Household #${h.id}`); setLinkCleared(false); }}
                onClear={() => { setHouseholdId(""); setHouseholdSearch(""); setLinkCleared(true); }}
              />
            </Paper>

            <Button type="submit" disabled={submitDisabled} loading={saving} mt="sm">
              Create Participant
            </Button>
          </Stack>
        </form>
      </Card>
    </Container>
  );
}
