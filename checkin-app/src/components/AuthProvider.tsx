"use client";

import { useMemo } from "react";
import type { Session } from "next-auth";
import { SessionProvider, useSession } from "next-auth/react";
import { ViewerProvider, type Viewer } from "@checkin/component-ui";

/** The one place checkin's session shape meets the package UIs' viewer. */
export function viewerFromSession(session: Session | null | undefined): Viewer | null {
    const user = session?.user;
    if (!user) return null;
    return {
        id: user.id,
        ageBand: user.ageBand ?? "unknown",
        isFinance: user.isFinance === true,
        isBoardMember: user.isBoardMember === true,
        isOperations: user.isOperations === true,
        isInventoryManager: user.isInventoryManager === true,
    };
}

/** A lost session answers a load with 401; a full page load takes the person through the site's sign-in gate. */
export function expireSession(location: Pick<Location, "pathname" | "assign"> = window.location): void {
    if (location.pathname !== "/") location.assign("/");
}

function SessionViewer({ children }: { children: React.ReactNode }) {
    const { data } = useSession();
    const viewer = useMemo(() => viewerFromSession(data), [data]);
    return <ViewerProvider viewer={viewer} onSessionExpired={expireSession}>{children}</ViewerProvider>;
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider>
            <SessionViewer>{children}</SessionViewer>
        </SessionProvider>
    );
}
