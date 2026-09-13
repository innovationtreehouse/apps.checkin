"use client";

import { Badge, type BadgeProps } from '@mantine/core';

/**
 * Centralized role / certification badge. Replaces the per-page inline-styled badges that
 * were duplicated across the admin, shop, and household pages. Add new roles to ROLE_META.
 *
 * Tool-CERTIFICATION colors (BASIC/DOF/CERTIFIED/INSTRUCTOR/MAY_CERTIFY_OTHERS) live solely in
 * ToolLevelBadge (the regulated Safety Rules palette) — do not re-add them here. The
 * `ParticipantRole` union below makes that a compile error, not just a convention.
 */
type RoleMeta = { label: string; color: string };

export type ParticipantRole =
  | 'isSysadmin'
  | 'isBoardMember'
  | 'isKeyholder'
  | 'isBackgroundCheckReviewer'
  | 'isOperations'
  | 'isInventoryManager'
  | 'coreVolunteer';

export const ROLE_META: Record<ParticipantRole, RoleMeta> = {
  isSysadmin: { label: 'Sysadmin', color: 'red' },
  isBoardMember: { label: 'Board', color: 'treehousePurple' },
  isKeyholder: { label: 'Keyholder', color: 'treehousePurple' },
  isBackgroundCheckReviewer: { label: 'BG Reviewer', color: 'treehousePurple' },
  isOperations: { label: 'Operations', color: 'treehousePurple' },
  isInventoryManager: { label: 'Inventory Manager', color: 'treehousePurple' },
  coreVolunteer: { label: 'Core Volunteer', color: 'treehousePurple' },
};

/** The display label for a role/certification key — same lookup RoleBadge renders, for callers that need plain text (e.g. a confirm-modal delta summary). */
export function roleLabel(role: string): string {
  return (ROLE_META as Record<string, RoleMeta>)[role]?.label ?? role;
}

export function RoleBadge({
  role,
  label,
  ...badgeProps
}: { role: string; label?: string } & Omit<BadgeProps, 'color' | 'children'>) {
  const meta = (ROLE_META as Record<string, RoleMeta>)[role];
  return (
    <Badge color={meta?.color ?? 'gray'} variant="light" {...badgeProps}>
      {label ?? meta?.label ?? role}
    </Badge>
  );
}
