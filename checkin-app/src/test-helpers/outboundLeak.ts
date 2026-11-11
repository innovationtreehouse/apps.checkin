/**
 * The real outboundCall, wrapped for tests: records every stripped bag a writer's
 * `send` receives and, while `outboundLeak.inject` is on, first adds pii, personal
 * and internal marker fields to the bag the writer built. Install it with
 *
 *   jest.mock('@/security/outbound', () =>
 *       jest.requireActual<typeof import('@/test-helpers/outboundLeak')>('@/test-helpers/outboundLeak').leakingOutboundModule());
 */
import type { OutboundPayload } from '@/security/outbound';

type OutboundModule = typeof import('@/security/outbound');

export const LEAK = { pii: 'LEAK-PII', personal: 'LEAK-PERSONAL', internal: 'LEAK-INTERNAL' } as const;

export const outboundLeak: { inject: boolean; sent: { surface: string; stripped: OutboundPayload }[] } = { inject: false, sent: [] };

function withLeaks(payload: OutboundPayload): OutboundPayload {
    const program = (payload.Program ?? {}) as Record<string, unknown>;
    const household = (payload.Household ?? {}) as Record<string, unknown>;
    return {
        ...payload,
        Program: { ...program, leadMentorNotificationSettings: LEAK.personal, saleEndedAt: LEAK.internal },
        Household: { ...household, intakeNotes: LEAK.pii, line1: LEAK.internal },
        Person: { email: LEAK.pii, dateOfBirth: LEAK.personal },
    };
}

export function leakingOutboundModule(): OutboundModule {
    const actual = jest.requireActual<OutboundModule>('@/security/outbound');
    return {
        ...actual,
        outboundCall: (surface, payload, send) =>
            actual.outboundCall(surface, outboundLeak.inject ? withLeaks(payload) : payload, (stripped) => {
                outboundLeak.sent.push({ surface, stripped });
                return send(stripped);
            }),
    };
}
