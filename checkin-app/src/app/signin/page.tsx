"use client";

import { Suspense, useEffect } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession, signIn, signOut } from "next-auth/react";
import { Box, Button, Card, Container, Stack, Text, Title } from "@mantine/core";
import { AlertBanner } from "@/components/admin/AlertBanner";
import { ORG_DOMAIN } from "@/lib/config";
import { useCheckinEnv, useIsDevInstance, useIsLocalInstance } from "@/components/EnvProvider";
import DevLoginPicker from "@/components/DevLoginPicker";

// Set by the signIn callback in auth-options.ts (UNVERIFIED_EMAIL_SIGNIN_ERROR).
const UNVERIFIED_EMAIL_ERROR = "EmailNotVerified";

/**
 * Custom sign-in screen for the dev instance (replaces NextAuth's bare default page). The dev
 * middleware (docs/ops/dev-instance.md, "Running the cloud dev instance") bounces every anonymous
 * request here, and a signed-in but
 * non-org account lands here too (it can't pass the `hd` gate) — so this page covers both states.
 * Mirrors the homepage's signed-out card (page.tsx) on Mantine primitives.
 */
function SignInInner() {
    const router = useRouter();
    const params = useSearchParams();
    const { data: session, status } = useSession();
    const isDevInstance = useIsDevInstance();
    const isLocalInstance = useIsLocalInstance();
    const checkinEnv = useCheckinEnv();
    // Same-origin relative paths only: this value comes off the query string and
    // feeds a client-side redirect, so an absolute (or protocol-relative) URL here
    // would be an open redirect for any authenticated visitor.
    const rawCallback = params.get("callbackUrl") || "/";
    const callbackUrl = rawCallback.startsWith("/") && !rawCallback.startsWith("//") ? rawCallback : "/";
    const error = params.get("error");

    const signedIn = status === "authenticated" && !!session?.user;
    // The same org gate the dev middleware enforces (hd + verified email). Only a session that
    // actually FAILS it gets the "wrong account" treatment — a verified org member can also land
    // here (e.g. a persona-mint that was refused redirects back with ?error=), and telling them
    // their account isn't in the Workspace would be wrong on both counts. The gate only exists on
    // the cloud dev instance; local sessions never carry the hd claim.
    const orgVerified = session?.user?.hd === ORG_DOMAIN && session?.user?.emailVerified === true;
    const wrongAccount = signedIn && checkinEnv === "dev" && !orgVerified;

    // An authenticated, org-OK visitor lands here after an OAuth bounce (e.g. the
    // dev middleware's hd gate, or a stale /signin link) — send them straight on
    // instead of stranding them behind a redundant "Sign in with Google" button.
    useEffect(() => {
        if (status === "authenticated" && !wrongAccount) {
            router.replace(callbackUrl);
        }
    }, [status, wrongAccount, callbackUrl, router]);

    if (status === "loading") return null;

    return (
        <Container size="sm" py="xl">
            <Card withBorder shadow="sm" radius="md" padding="xl">
                <Stack align="center" gap="xs" mb="lg">
                    <Box
                        bg="white"
                        px={6}
                        py={2}
                        style={{ borderRadius: "var(--mantine-radius-md)", display: "inline-flex", alignItems: "center" }}
                    >
                        <Image src="/brand/treehouse-logo-full.webp" alt="Innovation Treehouse" width={84} height={40} priority />
                    </Box>
                    <Title order={1} tt="lowercase">{isDevInstance ? "CMI-dev" : "CheckMeIn"}</Title>
                    <Text c="dimmed">
                        {isDevInstance ? (
                            <>Log in with an <strong>@{ORG_DOMAIN}</strong> email below.</>
                        ) : (
                            "The Innovation Treehouse check-in system."
                        )}
                    </Text>
                </Stack>

                <Stack>
                    {!signedIn && error === UNVERIFIED_EMAIL_ERROR && (
                        <AlertBanner
                            tone="error"
                            message="Confirm your email address in your Google account, then sign in again."
                        />
                    )}
                    {wrongAccount ? (
                        <>
                            <AlertBanner
                                tone="error"
                                message={
                                    <>
                                        Signed in as <strong>{session?.user?.email}</strong>, but this Google account is
                                        not managed by the <code>@{ORG_DOMAIN}</code> Google Workspace — it may be a
                                        personal account or a forwarding alias. Sign out and use an actual{" "}
                                        <code>@{ORG_DOMAIN}</code> Workspace account to access the dev environment.
                                    </>
                                }
                            />
                            <Button fullWidth onClick={() => signOut({ callbackUrl: "/signin" })}>
                                Sign out &amp; use another account
                            </Button>
                        </>
                    ) : signedIn ? (
                        <>
                            {error && (
                                <AlertBanner
                                    tone="warning"
                                    message={
                                        <>
                                            That sign-in attempt didn&apos;t complete (code: <code>{error}</code>).
                                            You are still signed in as <strong>{session?.user?.email}</strong>.
                                        </>
                                    }
                                />
                            )}
                            <Button component="a" href={callbackUrl} fullWidth>
                                Continue as {session?.user?.name || session?.user?.email}
                            </Button>
                        </>
                    ) : isLocalInstance ? (
                        // LOCAL never calls Google (no Google identity on a laptop) — the offline
                        // dev persona picker is the only login path. callbackUrl is honored so a
                        // program-page "Sign in to enroll" returns to /programs/<id> after mint.
                        <DevLoginPicker callbackUrl={callbackUrl} />
                    ) : (
                        <Button size="lg" fullWidth onClick={() => signIn("google", { callbackUrl })}>
                            Sign in with Google
                        </Button>
                    )}
                </Stack>
            </Card>
        </Container>
    );
}

export default function SignInPage() {
    // useSearchParams requires a Suspense boundary in the app router.
    return (
        <Suspense fallback={null}>
            <SignInInner />
        </Suspense>
    );
}
