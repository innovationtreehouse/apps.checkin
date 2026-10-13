/**
 * Registry of the lifecycle machines whose review artifacts are generated and
 * drift-checked. Each entry pairs a machine's exported `TRANSITIONS` with the
 * state metadata the renderers need (`allStates`, `initials`, `accepting`,
 * `origins`). Consumed by both the generator CLI (generate.ts) and the drift
 * test (artifactsDrift.test.ts), so the two can never disagree on what a machine
 * looks like.
 *
 * Adding a machine here (with its checked-in `<name>.md`) is all it takes to put
 * it under the artifact drift guard.
 */
import type { MachineSpec } from './artifacts';
import { TRANSITIONS as ENROLLMENT_TRANSITIONS } from '../programs/enrollmentState';
import {
    TRANSITIONS as MEMBERSHIP_TRANSITIONS,
    ALL_STATUSES as MEMBERSHIP_ALL_STATUSES,
    INITIAL_STATES as MEMBERSHIP_INITIAL_STATES,
} from '../membership/lifecycle';
import {
    TRANSITIONS as HOUSEHOLD_TRANSITIONS,
    STATES as HOUSEHOLD_STATES,
    INITIAL_STATES as HOUSEHOLD_INITIAL_STATES,
} from '../membership/householdStatus';

/**
 * ProgramParticipant enrollment. `UNENROLLED`
 * is the ∅/no-row state — both an entry and the withdrawal target — so it renders
 * as mermaid `[*]`. `ACTIVE` is the one non-∅ resting state.
 */
const ENROLLMENT: MachineSpec = {
    name: 'enrollment',
    title: 'ProgramParticipant enrollment',
    transitions: ENROLLMENT_TRANSITIONS,
    allStates: [
        'UNENROLLED',
        'PENDING_UNPAID',
        'PENDING_HOLD_FAILED',
        'PENDING_HELD',
        'PENDING_HELD_DENIED',
        'ACTIVE',
    ],
    initials: ['UNENROLLED'],
    accepting: ['ACTIVE'],
    origins: ['UNENROLLED'],
};

/**
 * OrgMembershipProcess. `∅` is the origin
 * pseudo-state. `ACTIVE`/`ARCHIVED` are the accepting resting states — ARCHIVED is
 * where a disposed application stops, not a sealed state (unarchive walks back out
 * to whatever phase it collapsed); the legacy
 * `RENEWAL_PENDING_BG` is expected to show up as unreachable — the
 * report is where that dead-but-guarded status is meant to surface.
 */
const MEMBERSHIP: MachineSpec = {
    name: 'membership',
    title: 'OrgMembershipProcess',
    transitions: MEMBERSHIP_TRANSITIONS,
    allStates: MEMBERSHIP_ALL_STATUSES,
    initials: MEMBERSHIP_INITIAL_STATES,
    accepting: ['ACTIVE', 'ARCHIVED'],
    origins: ['∅'],
};

/**
 * OrgMembership.status — the household's status. `∅` is the origin (no row yet).
 * Every state rests; DENIED's one exit is the board's restore to NONE.
 */
const HOUSEHOLD: MachineSpec = {
    name: 'household',
    title: 'OrgMembership (household status)',
    transitions: HOUSEHOLD_TRANSITIONS,
    allStates: HOUSEHOLD_STATES,
    initials: HOUSEHOLD_INITIAL_STATES,
    accepting: HOUSEHOLD_STATES,
    origins: ['∅'],
};

export const MACHINES: readonly MachineSpec[] = [ENROLLMENT, MEMBERSHIP, HOUSEHOLD];
