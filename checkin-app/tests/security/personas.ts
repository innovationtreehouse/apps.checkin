import prisma from '@/lib/prisma';
import type { Role } from '@/security/core';
import type { AuthenticatedUser } from '@/types/auth';

export interface Persona {
    role: Role;
    sessionUser?: AuthenticatedUser;
    description: string;
}

let cached: Record<string, Persona> | null = null;

async function ensure(
    emailSuffix: string,
    mutate: Partial<{
        name: string;
        isSysadmin: boolean;
        isBoardMember: boolean;
        isKeyholder: boolean;
        isBackgroundCheckReviewer: boolean;
    }>,
) {
    const email = `policy-persona-${emailSuffix}@example.test`;
    let p = await prisma.person.findUnique({ where: { email } });
    if (!p) {
        p = await prisma.person.create({
            data: {
                email,
                name: mutate.name ?? emailSuffix,
                ...mutate,
                household: { create: { name: `${mutate.name ?? emailSuffix} Household` } },
            },
        });
    } else {
        p = await prisma.person.update({ where: { id: p.id }, data: mutate });
    }
    return p;
}

export async function loadPersonas(): Promise<Record<string, Persona>> {
    if (cached) return cached;

    const rankAndFile = await ensure('rank-and-file', { name: 'Rank File' });
    const isSysadmin = await ensure('isSysadmin', { name: 'Sys Admin', isSysadmin: true });
    const isBoardMember = await ensure('board-member', { name: 'Board Member', isBoardMember: true });
    const isKeyholder = await ensure('isKeyholder', { name: 'Key Holder', isKeyholder: true });
    const bgReviewer = await ensure('bg-reviewer', { name: 'BG Reviewer', isBackgroundCheckReviewer: true });

    // isOperations is table-only (PersonRole, no Person column) and none of these
    // fixtures hold it — no 'isOperations' persona exists below, so the generic
    // contract test skips any route that gates on it (`if (!persona) return;`).
    const mkUser = (p: {
        id: number;
        email: string | null;
        name: string | null;
        isSysadmin: boolean;
        isBoardMember: boolean;
        isKeyholder: boolean;
        isBackgroundCheckReviewer: boolean;
    }): AuthenticatedUser => ({
        id: p.id,
        email: p.email ?? '',
        name: p.name ?? undefined,
        isSysadmin: p.isSysadmin,
        isBoardMember: p.isBoardMember,
        isKeyholder: p.isKeyholder,
        isBackgroundCheckReviewer: p.isBackgroundCheckReviewer,
        isOperations: false,
        isInventoryManager: false,
    });

    cached = {
        anyone: {
            role: 'anyone',
            sessionUser: mkUser(rankAndFile),
            description: 'Catch-all — use any logged-in user',
        },
        unauthenticated: { role: 'unauthenticated', description: 'No session, no kiosk' },
        authenticated: {
            role: 'authenticated',
            sessionUser: mkUser(rankAndFile),
            description: 'Logged-in non-privileged user',
        },
        isSysadmin: { role: 'isSysadmin', sessionUser: mkUser(isSysadmin), description: 'isSysadmin=true' },
        isBoardMember: {
            role: 'isBoardMember',
            sessionUser: mkUser(isBoardMember),
            description: 'isBoardMember=true',
        },
        isKeyholder: {
            role: 'isKeyholder',
            sessionUser: mkUser(isKeyholder),
            description: 'isKeyholder=true',
        },
        isBackgroundCheckReviewer: {
            role: 'isBackgroundCheckReviewer',
            sessionUser: mkUser(bgReviewer),
            description: 'isBackgroundCheckReviewer=true',
        },
        kiosk: { role: 'kiosk', description: 'Kiosk signature (no user)' },
        // programLeadMentor, programCoreVolunteer, householdLead are data-scoped roles
        // exercised through their parent route's specific tests, not the generic contract.
    };
    return cached;
}
