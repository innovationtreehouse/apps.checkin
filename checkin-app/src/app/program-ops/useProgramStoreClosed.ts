"use client";

import { useLoad } from '@/lib/api';

type StoreSettings = { programStoreClosedAt?: string | null };
type MembershipSettingsAnswer = { settings?: StoreSettings & { BoardSettings?: StoreSettings } };

/**
 * Whether the Board has closed the store to program seats, for a viewer who may
 * read board settings; false for anyone else, who sees the open-store checkout rule.
 */
export function useProgramStoreClosed(enabled: boolean): boolean {
  const { data } = useLoad<MembershipSettingsAnswer>(enabled ? '/api/settings/membership' : null);
  return !!(data?.settings?.BoardSettings ?? data?.settings)?.programStoreClosedAt;
}
