import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { todoCounts, type TodoCountsResponse } from "@/lib/nav/todoCounts";

export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") {
        return apiError("Unauthorized", 401);
    }
    const body: TodoCountsResponse = { ...(await todoCounts(auth.user)), personId: auth.user.id };
    return NextResponse.json(body);
});
