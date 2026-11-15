/**
 * @jest-environment node
 *
 * The response shape `handler()` builds from a bag: one key sends that key's
 * value, two keys send the bag keyed by model name, and a string envelope
 * wraps either payload under its key.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { defineRoute, type Envelope } from '@/security/core';
import { handler, type ModelBag } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const BARE = 'POST /api/__test__/envelope/bare';
const WRAPPED = 'POST /api/__test__/envelope/wrapped';
const TOOL = { id: 1, name: 'Lathe', safetyGuide: 'Tie back hair' };
const STATUS = { personId: 7 };

for (const [endpoint, envelope] of [[BARE, null], [WRAPPED, 'data']] as const) {
    defineRoute({
        endpoint,
        authorize: 'public',
        envelope,
        returns: ['Tool', 'ToolStatus'],
        orderedView: [['anyone', ['public']]],
    });
}

async function body(endpoint: string, bag: ModelBag): Promise<unknown> {
    const req = new NextRequest(`http://localhost${endpoint.slice('POST '.length)}`, { method: 'POST' });
    const res = await handler(endpoint, async () => bag)(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    return res.json();
}

beforeEach(() => mockSession.mockResolvedValue(null));

describe.each([
    ['null', BARE, null],
    ["'data'", WRAPPED, 'data'],
] as const)('envelope %s', (_label, endpoint, envelope: Envelope) => {
    const wrap = (payload: unknown) => (envelope === null ? payload : { [envelope]: payload });

    it('sends a one-key bag as that key\'s value', async () => {
        expect(await body(endpoint, { Tool: [TOOL] })).toEqual(wrap([TOOL]));
    });

    it('sends a two-key bag keyed by model name', async () => {
        expect(await body(endpoint, { Tool: [TOOL], ToolStatus: [STATUS] })).toEqual(
            wrap({ Tool: [TOOL], ToolStatus: [STATUS] }),
        );
    });
});
