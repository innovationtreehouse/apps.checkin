/**
 * @jest-environment node
 *
 * The error body handler() and fileHandler() render: `{ error }`, plus `code`
 * only when the thrower of an ApiResponseError set one.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import type { AuthResult } from '@/types/auth';
import { defineFileRoute, defineRoute } from '@/security/core';
import { fileHandler } from '@/security/fileHandler';
import { ApiResponseError, handler } from '@/security/handler';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
// jest.setup.js stubs next/server down to NextResponse.json; the request class is the real one.
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockAuth = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;

const JSON_ENDPOINT = 'GET /api/__test__/error-code';
const FILE_ENDPOINT = 'GET /api/__test__/error-code/file';
defineRoute({
    endpoint: JSON_ENDPOINT,
    authorize: 'authenticated',
    envelope: null,
    orderedView: [['authenticated', ['public']]],
});
defineFileRoute({
    endpoint: FILE_ENDPOINT,
    authorize: 'authenticated',
    orderedView: [['authenticated', ['their_own:pii']]],
    file: { model: 'Person', field: 'email' },
});

const renderers: [string, (err: Error) => Promise<Response>][] = [
    ['handler', (err) => handler(JSON_ENDPOINT, async () => { throw err; })(new NextRequest('http://localhost/x'))],
    ['fileHandler', (err) => fileHandler(FILE_ENDPOINT, async () => { throw err; })(new NextRequest('http://localhost/x'))],
];

beforeEach(() => {
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({
        type: 'session',
        user: {
            id: 7,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
        },
    } as AuthResult);
});

describe.each(renderers)('%s error body', (_, render) => {
    it('adds the code the thrower set', async () => {
        const res = await render(new ApiResponseError(409, 'Taken', 'already_taken'));
        expect(res.status).toBe(409);
        expect(await res.text()).toBe('{"error":"Taken","code":"already_taken"}');
    });

    it('has no code key when the thrower set none', async () => {
        const res = await render(new ApiResponseError(404, 'Not found'));
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('{"error":"Not found"}');
    });

    it("keeps an unknown error opaque, whatever its own code says", async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementationOnce(() => {});
        const res = await render(Object.assign(new Error('secret detail'), { code: 'P2002', status: 409 }));
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('{"error":"Internal Server Error"}');
        consoleError.mockRestore();
    });
});
