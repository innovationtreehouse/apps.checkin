import { ApiResponseError, handler } from "@/security/handler";
import { answerHouseholdQuestion, householdQuestion, JoinQuestionError, type JoinRefusal } from "@/lib/household/joinQuestion";

const REFUSALS: Record<JoinRefusal, { message: string; status: number }> = {
    not_pending: { message: "There is no question to answer.", status: 409 },
    youth: { message: "A youth cannot answer this. Please ask the Board.", status: 403 },
    denied: { message: "This household cannot be answered for. Please ask the Board.", status: 403 },
};

async function readJoin(req: Request): Promise<boolean> {
    const body: unknown = await req.json().catch(() => null);
    const join = typeof body === "object" && body !== null && "join" in body ? body.join : undefined;
    if (typeof join !== "boolean") throw new ApiResponseError(400, "join must be true or false");
    return join;
}

export const GET = handler("GET /api/profile/household-question", async ({ auth }) => {
    if (auth.type !== "session") throw new ApiResponseError(401, "Unauthorized");
    return { Household: await householdQuestion(auth.user.id) };
});

export const POST = handler("POST /api/profile/household-question", async ({ req, auth }) => {
    if (auth.type !== "session") throw new ApiResponseError(401, "Unauthorized");
    const join = await readJoin(req);
    try {
        await answerHouseholdQuestion(auth.user.id, join);
    } catch (error) {
        if (!(error instanceof JoinQuestionError)) throw error;
        const { message, status } = REFUSALS[error.refusal];
        throw new ApiResponseError(status, message);
    }
    return {};
});
