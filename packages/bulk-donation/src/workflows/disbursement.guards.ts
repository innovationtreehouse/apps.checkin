import type { DisbursementEvent } from './disbursement.events';

export type DisbursementMachineContext = Record<string, never>;

export const NEUTRAL_CONTEXT: DisbursementMachineContext = {};

export const disbursementGuards = {
  allOwnersReady: ({ event }: { context: DisbursementMachineContext; event: DisbursementEvent }): boolean =>
    event.type === 'OWNER_ASSIGNED' && event.allReady,
} as const;
