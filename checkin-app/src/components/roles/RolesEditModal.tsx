"use client";

import { useEffect, useState } from "react";
import { Box, Button, Group, Modal, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { roleLabel } from "@/components/ui/RoleBadge";
import { ROLE_FLAGS, type RoleFlag } from "@/lib/roles";

export type RolesEditTarget = {
  id: number;
  name: string | null;
  email: string | null;
  isSysadmin?: boolean;
  isBoardMember?: boolean;
  isKeyholder?: boolean;
  isBackgroundCheckReviewer?: boolean;
  isOperations?: boolean;
  isInventoryManager?: boolean;
  // ops-stg access gate escape hatch. NOT one of the five ROLE_FLAGS above —
  // sysadmin-settable only (see PATCH /api/roles), so it is edited separately
  // below rather than folded into the ROLE_FLAGS loop's board-symmetric switches.
  canAccessStaging?: boolean;
};

/** The subset of the session actor this modal needs to compute the client-side authority matrix. */
export type RolesEditActor = {
  isSysadmin?: boolean;
  isBoardMember?: boolean;
};

export interface RolesEditModalProps {
  /** Person being edited; the modal is open iff this is non-null. */
  target: RolesEditTarget | null;
  /** The acting session user (for the client-side matrix — UX only, the endpoint enforces it). */
  me: RolesEditActor | undefined;
  onClose: () => void;
  /** Called with the server's post-write user (five booleans + id/email/name) after a successful save. */
  onSaved: (updatedUser: RolesEditTarget) => void;
}

/** Read the role-flags subset off a target, defaulting every ROLE_FLAGS key to false — the
 * one place the flag list is enumerated, so adding a flag to ROLE_FLAGS is enough. */
function flagsFromTarget(t: RolesEditTarget | null): Record<RoleFlag, boolean> {
  return Object.fromEntries(ROLE_FLAGS.map((f) => [f, !!t?.[f]])) as Record<RoleFlag, boolean>;
}

/**
 * Extracted, verbatim (#1104 -> roles-foundation rework §6.1): the five-switch role editor +
 * its confirm-delta modal + PATCH /api/roles call. Shared by the holders-first
 * `/membership-ops/roles` page (the sole editor) — the participants page renders role pills
 * read-only and no longer opens this.
 */
export function RolesEditModal({ target, me, onClose, onSaved }: RolesEditModalProps) {
  const [rolesForm, setRolesForm] = useState<Record<RoleFlag, boolean>>(() => flagsFromTarget(null));
  // Tracked separately from rolesForm: canAccessStaging is not a ROLE_FLAGS entry
  // (see RolesEditTarget) — it has its own sysadmin-only rule, not the board-symmetric matrix.
  const [stagingForm, setStagingForm] = useState(false);
  const [savingRoles, setSavingRoles] = useState(false);

  useEffect(() => {
    if (!target) return;
    setRolesForm(flagsFromTarget(target));
    setStagingForm(!!target.canAccessStaging);
  }, [target]);

  const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
    notifications.show({ message, color: type === 'error' ? 'red' : 'green', autoClose: type === 'error' ? false : 4000 });
  };

  // Client-side mirror of the server's authority matrix (§4.3) — UX only, so
  // switches the actor can't legally flip are disabled with an explanation.
  // The endpoint enforces the real rule regardless of what this renders.
  const roleSwitchState = (field: RoleFlag): { disabled: boolean; reason?: string } => {
    if (me?.isBoardMember) return { disabled: false };
    if (me?.isSysadmin) {
      if (field === 'isBoardMember' && target?.isBoardMember) {
        return { disabled: true, reason: 'Only board members can remove board membership' };
      }
      return { disabled: false };
    }
    return { disabled: true, reason: 'You do not have permission to edit roles' };
  };

  type Delta = Partial<Record<RoleFlag, boolean>> & { canAccessStaging?: boolean };

  const saveRoles = async (t: RolesEditTarget, delta: Delta) => {
    setSavingRoles(true);
    try {
      const res = await fetch('/api/roles', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId: t.id, ...delta }),
      });
      if (res.ok) {
        const data = await res.json();
        showNotification("Roles updated.");
        onSaved(data.user);
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        // Revert the form to the target's last-known-good state.
        setRolesForm(flagsFromTarget(t));
        setStagingForm(!!t.canAccessStaging);
        showNotification(data.error || "Failed to update roles", "error");
      }
    } catch (err) {
      console.error("Failed to update roles:", err);
      showNotification("Network error updating roles", "error");
    } finally {
      setSavingRoles(false);
    }
  };

  const handleSaveRoles = () => {
    if (!target) return;
    const current = flagsFromTarget(target);
    const delta: Delta = {};
    for (const field of ROLE_FLAGS) {
      if (rolesForm[field] !== current[field]) delta[field] = rolesForm[field];
    }
    // Sysadmin-only, and only rendered for a sysadmin actor (see the switch below) —
    // but re-derive from target rather than trust the rendered-or-not state, so a
    // stale `me` prop can never smuggle a delta the server would reject anyway.
    if (me?.isSysadmin && stagingForm !== !!target.canAccessStaging) {
      delta.canAccessStaging = stagingForm;
    }
    if (Object.keys(delta).length === 0) {
      onClose();
      return;
    }
    const deltaText = [
      ...(Object.keys(delta) as (RoleFlag | 'canAccessStaging')[])
        .filter((f): f is RoleFlag => f !== 'canAccessStaging')
        .map((f) => `${delta[f] ? 'Grant' : 'Revoke'} ${roleLabel(f)}`),
      ...(delta.canAccessStaging !== undefined ? [`${delta.canAccessStaging ? 'Grant' : 'Revoke'} staging access`] : []),
    ].join('; ');
    modals.openConfirmModal({
      title: "Update roles?",
      children: (
        <Text size="sm">
          {deltaText} — for <strong>{target.name || target.email}</strong>
        </Text>
      ),
      labels: { confirm: 'Save', cancel: 'Cancel' },
      onConfirm: () => saveRoles(target, delta),
    });
  };

  return (
    <Modal opened={target !== null} onClose={onClose} title={<Text span fw={700} fz="lg">Edit Roles — {target?.name || target?.email}</Text>}>
      <Stack>
        {ROLE_FLAGS.map((field) => {
          const { disabled, reason } = roleSwitchState(field);
          const switchEl = (
            <Switch
              label={roleLabel(field)}
              checked={rolesForm[field]}
              disabled={disabled}
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setRolesForm((f) => ({ ...f, [field]: checked }));
              }}
            />
          );
          return (
            <div key={field}>
              {disabled && reason ? (
                <Tooltip label={reason}>
                  <Box>{switchEl}</Box>
                </Tooltip>
              ) : switchEl}
            </div>
          );
        })}
        {/* canAccessStaging: sysadmin-only, not one of ROLE_FLAGS above — hidden
            entirely for a board-only actor rather than shown disabled, since they
            have no path to grant it regardless (mirrors the PATCH route's guard). */}
        {me?.isSysadmin && (
          <Switch
            label="Staging access (ops-stg)"
            description="Admits this person to ops-stg even though they are not a verified org member."
            checked={stagingForm}
            onChange={(e) => setStagingForm(e.currentTarget.checked)}
          />
        )}
      </Stack>
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose} disabled={savingRoles}>Cancel</Button>
        <Button onClick={handleSaveRoles} disabled={savingRoles} loading={savingRoles}>Save</Button>
      </Group>
    </Modal>
  );
}
