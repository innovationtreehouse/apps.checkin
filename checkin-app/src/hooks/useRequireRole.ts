"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import type { BusinessRole } from "@/types/auth";

type AdminSessionUser = NonNullable<ReturnType<typeof useSession>["data"]>["user"];

export interface RequireRoleResult {
  /** The typed session user (the role flags come from the next-auth.d.ts augmentation). */
  user: AdminSessionUser | undefined;
  /** True once the user is authenticated AND holds one of the allowed roles. */
  authorized: boolean;
  /** Session is still resolving — render a loader. */
  loading: boolean;
  /** Safe to render the page (authenticated + authorized). */
  ready: boolean;
}

/**
 * Client-side admin role gate. Redirects unauthenticated or unauthorized users to `/`
 * and returns the typed session user plus loading/ready flags.
 *
 * Replaces the copy-pasted `useSession` + `useEffect(redirect)` + `session.user as {...}`
 * block that each admin page hand-rolled. The `/admin` layout still enforces the global
 * gate; this enforces the page's own (often stricter) role requirement and removes the
 * unnecessary casts — `Session['user']` is already typed via `src/types/next-auth.d.ts`.
 *
 * Unauthenticated users are always sent to `/` (they must sign in); authenticated users who
 * lack every allowed role are sent to `options.redirectTo` (default `/`).
 *
 * Usage:
 *   const { user, loading, ready } = useRequireRole(['isSysadmin', 'isBoardMember']);
 *   if (loading) return <Center mih="60vh"><Loader /></Center>;
 *   if (!ready) return null; // a redirect is in flight
 */
export function useRequireRole(
  allowed: (BusinessRole | "isFinance")[],
  options?: { redirectTo?: string },
): RequireRoleResult {
  const redirectTo = options?.redirectTo ?? "/";
  const { data: session, status } = useSession();
  const router = useRouter();
  const user = session?.user;
  // Empty `allowed` = any authenticated user (a plain sign-in gate); otherwise
  // the user must hold one of the listed roles.
  const authorized = !!user && (allowed.length === 0 || allowed.some((role) => user[role] === true));

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    } else if (status === "authenticated" && !authorized) {
      router.push(redirectTo);
    }
  }, [status, authorized, router, redirectTo]);

  return {
    user,
    authorized,
    loading: status === "loading",
    ready: status === "authenticated" && authorized,
  };
}
