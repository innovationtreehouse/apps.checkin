import type { NextRequest } from "next/server";
import { isServiceError } from "@checkin/component-kit";
import { personActor } from "@/lib/auditActor";
import prisma from "@/lib/prisma";
import { retryProblem } from "@/lib/problems";
import { mayRetry } from "@/lib/problemsRetryRoles";
import { badRequest, forbidden, handler, unauthorized } from "@/security/handler";

// Registry-governed (POST /api/system-status/problems/retry): sysadmin or Board, envelope 'results';
// a step that posts to QuickBooks is the Board's alone (mayRetry). Body `{ library, step, id }`, one
// item per press; Retry all presses once per item.
const ENDPOINT = "POST /api/system-status/problems/retry";

type Item = { library: string; step: string; id: string };

function parseItem(body: unknown): Item | null {
    if (typeof body !== "object" || body === null) return null;
    const { library, step, id } = body as Record<string, unknown>;
    return typeof library === "string" && typeof step === "string" && typeof id === "string" ? { library, step, id } : null;
}

/**
 * Retries one stuck item once and answers whether its step ran, with the library's status when it
 * refused (404, 409, 503). The library's message never leaves: it can carry personal data.
 */
export async function POST(req: NextRequest): Promise<Response> {
    let status = 200;
    const res = await handler(ENDPOINT, async ({ req, auth }) => {
        if (auth.type !== "session") throw unauthorized();
        const item = parseItem(await req.json().catch(() => null));
        if (!item) throw badRequest("Expected { library, step, id }");
        if (!mayRetry(auth.user, item)) throw forbidden();

        let failure: unknown = null;
        try {
            await retryProblem(item);
        } catch (err) {
            failure = err ?? new Error("retry rejected");
        }
        await prisma.auditLog.create({
            data: {
                ...personActor(auth.user.id),
                action: "CREATE",
                tableName: "PROBLEM_RETRY",
                affectedEntityId: 0,
                newData: { ...item, ok: failure === null },
            },
        });
        if (failure !== null) {
            if (!isServiceError(failure)) throw new Error(`${item.library} retry of ${item.step} threw`);
            status = failure.status;
        }
        return { ProblemRetryResult: [{ step: item.step, id: item.id, ok: failure === null }] };
    })(req);
    // DRIFT-GUARD ALLOWLIST: handler() admits and strips every call, and answers 200 for any bag;
    // a refused retry keeps its stripped body under the library's status.
    return status === 200 ? res : new Response(res.body, { status, headers: res.headers });
}
