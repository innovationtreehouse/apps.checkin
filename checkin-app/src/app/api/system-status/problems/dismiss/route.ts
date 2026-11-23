import { isServiceError } from "@checkin/component-kit";
import { dismissProblem } from "@/lib/problems";
import { mayRetry } from "@/lib/problemsRetryRoles";
import { badRequest, forbidden, handler, notFound, unauthorized } from "@/security/handler";

// Registry-governed (POST /api/system-status/problems/dismiss): sysadmin or Board, envelope 'results';
// whoever may retry an item may dismiss it (mayRetry). Body `{ library, step, id }`, one item per press.
const ENDPOINT = "POST /api/system-status/problems/dismiss";

type Item = { library: string; step: string; id: string };

function parseItem(body: unknown): Item | null {
    if (typeof body !== "object" || body === null) return null;
    const { library, step, id } = body as Record<string, unknown>;
    return typeof library === "string" && typeof step === "string" && typeof id === "string" ? { library, step, id } : null;
}

/** Takes one listed stuck item off the Problems list until it fails again, audited with who pressed; 404 when it is not listed now. */
export const POST = handler(ENDPOINT, async ({ req, auth }) => {
    if (auth.type !== "session") throw unauthorized();
    const item = parseItem(await req.json().catch(() => null));
    if (!item) throw badRequest("Expected { library, step, id }");
    if (!mayRetry(auth.user, item)) throw forbidden();

    try {
        await dismissProblem(item, { userId: auth.user.id });
    } catch (err) {
        if (isServiceError(err) && err.status === 404) throw notFound("That item is not on the Problems list");
        // The library's message can carry personal data, so only the item's names reach the log.
        throw new Error(`${item.library} dismiss of ${item.step} threw`);
    }
    return { ProblemDismissResult: [{ step: item.step, id: item.id, ok: true }] };
});
