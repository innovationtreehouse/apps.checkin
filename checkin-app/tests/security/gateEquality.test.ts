/**
 * @jest-environment node
 */
/**
 * Every client gate in GATE_PAIRS admits exactly the personas its server token
 * admits, apart from the pair's listed differsFor (threat model D35). No DB: the
 * program treasurer lookup is stubbed to find the treasurer persona only.
 */
import prisma from '@/lib/prisma';
import { LIBRARY_COUNT_PROVIDERS } from '@/lib/navLibraryCounts';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import { GATE_PAIRS, GATE_PERSONAS, TREASURER_IDS } from './gatePairs';

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

const treasurerLookup = jest.fn(async (args: { where: { personId: number } }) =>
    TREASURER_IDS.has(args.where.personId) ? { programId: 1 } : null,
);

beforeEach(() => {
    prisma.programVolunteer.findFirst = treasurerLookup as unknown as typeof prisma.programVolunteer.findFirst;
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
