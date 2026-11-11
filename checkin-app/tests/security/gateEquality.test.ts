/**
 * @jest-environment node
 */
/**
 * Every client gate in GATE_PAIRS admits exactly the personas its server token
 * admits, apart from the pair's listed differsFor. No DB: the
 * bucket-approver lookup is stubbed to find APPROVER_IDS only.
 */
import { bucketsApprovedBy } from '@/lib/finance/bucketApprovers';
import { LIBRARY_COUNT_PROVIDERS } from '@/lib/navLibraryCounts';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import { APPROVER_IDS, GATE_PAIRS, GATE_PERSONAS } from './gatePairs';

jest.mock('@/lib/finance/bucketApprovers', () => ({ bucketsApprovedBy: jest.fn() }));

const emptyContext = (): CallerContext => ({
    isKeyholder: false,
    isKiosk: false,
    programsLed: new Set(),
    programsCoreVolIn: new Set(),
    participantIdsInScopePrograms: new Set(),
    householdIdsInScopePrograms: new Set(),
    eventIdsInScopePrograms: new Set(),
    activeVisitorIds: new Set(),
    ledHouseholdMemberIds: new Set(),
});

beforeEach(() => {
    jest.mocked(bucketsApprovedBy).mockImplementation(async (personId) => (APPROVER_IDS.has(personId) ? [1] : []));
});

describe('client gate ↔ server token equality', () => {
    test.each(GATE_PAIRS.map((p) => [p.name, p] as const))('%s', async (_name, pair) => {
        const differs: string[] = [];
        for (const [name, user] of GATE_PERSONAS) {
            const server = (await resolveAccess(pair.token, { auth: { type: 'session', user }, params: {}, callerContext: emptyContext() })).allowed;
            if (pair.client(user) !== server) differs.push(name);
        }
        expect(differs.sort()).toEqual([...(pair.differsFor ?? [])].sort());
    });

    test('pair names are unique', () => {
        const names = GATE_PAIRS.map((p) => p.name);
        expect(names).toEqual([...new Set(names)]);
    });

    test('every count provider has a counts:<library> pair over its own visible', () => {
        for (const provider of LIBRARY_COUNT_PROVIDERS) {
            const pair = GATE_PAIRS.find((p) => p.name === `counts:${provider.library}`);
            expect([provider.library, pair?.client]).toEqual([provider.library, provider.visible]);
        }
    });
});
