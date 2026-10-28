/**
 * Shared React Testing Library harness for page/component tests (Phase 2+ of the
 * coverage plan). Lives under test-helpers/ (excluded from coverage) so ~60 page
 * tests don't each reinvent the Mantine + next-auth + next/navigation + fetch
 * mocking.
 *
 * Usage in a test file (jest.mock is hoisted, so the factory must `require`):
 *
 *   jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
 *   jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
 *   import { renderWithProviders, mockFetchJson, setSession, setPathname, router } from "@/test-helpers/rtl";
 *
 *   beforeEach(() => resetRtl());
 *   it("...", () => { setSession({ id: 1, isSysadmin: true }); mockFetchJson({ "/api/x": {...} }); renderWithProviders(<Page />); });
 */
import { render, configure, type RenderOptions } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";
import { EnvProvider } from "@/components/EnvProvider";
import type { CheckinEnv } from "@/lib/config";

// RTL's default findBy*/waitFor timeout is 1000ms of real (non-fake) timers.
// The full coverage run's CI job (290 suites, --coverage instrumentation, no
// --runInBand) shares a runner's few vCPUs across many workers; under that
// contention some renders legitimately settle after 1000ms even though
// there's no debounce/delay in the component. Give every findBy/waitFor
// headroom here once, instead of bumping it test-by-test.
configure({ asyncUtilTimeout: 5000 });

// jsdom lacks matchMedia + ResizeObserver, which Mantine's ScrollArea/Table use.
// Install once at import time; guarded so node-env (integration) files that happen
// to import this don't crash on the missing `window`.
if (typeof window !== "undefined") {
    window.matchMedia =
        window.matchMedia ||
        ((query: string) =>
            ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: () => {},
                removeEventListener: () => {},
                addListener: () => {},
                removeListener: () => {},
                dispatchEvent: () => false,
            }) as unknown as MediaQueryList);
    globalThis.ResizeObserver =
        globalThis.ResizeObserver ||
        (class {
            observe() {}
            unobserve() {}
            disconnect() {}
        } as unknown as typeof ResizeObserver);
}

// EnvProvider mirrors what the server layout injects at request time. Tests that
// exercise env-gated UI (Shopify checkout links, local-only login) set these via
// setShopifyStoreDomain / setCheckinEnv; resetRtl restores the prod defaults.
let checkinEnv: CheckinEnv = "prod";
let shopifyStoreDomain: string | null = null;
let isStaging = false;

/** Set the mocked CHECKIN_ENV seen by useCheckinEnv/useIsLocalInstance. */
export function setCheckinEnv(env: CheckinEnv) {
    checkinEnv = env;
}
/** Set the mocked Shopify store domain seen by useShopifyStoreDomain. */
export function setShopifyStoreDomain(domain: string | null) {
    shopifyStoreDomain = domain;
}
/** Set the mocked ops-stg flag seen by useIsStagingInstance. */
export function setStagingInstance(v: boolean) {
    isStaging = v;
}

/** Render `ui` wrapped in the providers a page/component tree needs. */
export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
    return render(
        <MantineProvider>
            <EnvProvider value={{ checkinEnv, shopifyStoreDomain, isStaging }}>{ui}</EnvProvider>
        </MantineProvider>,
        options,
    );
}

// ── next/navigation + next-auth/react mocks ──────────────────────────────────
export const router = {
    push: jest.fn(),
    replace: jest.fn(),
    refresh: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    prefetch: jest.fn(),
};
let pathname = "/";
let searchParams = new URLSearchParams();
let session: { data: unknown; status: string; update?: jest.Mock } = { data: null, status: "unauthenticated" };

/** Factory for `jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock())`. */
export function navMock() {
    return {
        useRouter: () => router,
        usePathname: () => pathname,
        useSearchParams: () => searchParams,
        useParams: () => ({}),
        redirect: jest.fn(),
        notFound: jest.fn(),
    };
}
/** Factory for `jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock())`. */
export function authMock() {
    return {
        useSession: () => session,
        signIn: jest.fn(),
        signOut: jest.fn(),
        SessionProvider: ({ children }: { children: ReactNode }) => children,
    };
}

export function setPathname(p: string) {
    pathname = p;
}
export function setSearchParams(sp: URLSearchParams | string) {
    searchParams = typeof sp === "string" ? new URLSearchParams(sp) : sp;
}
/** Set the mocked session user (pass null for signed-out). */
export function setSession(user: Record<string, unknown> | null, status = user ? "authenticated" : "unauthenticated") {
    // `update` is next-auth's force-a-re-stamp hook; components call it after a
    // write that changes their own claims. Resolving to the same session keeps
    // those call sites from hanging on an undefined function.
    session = { data: user ? { user } : null, status, update: jest.fn().mockResolvedValue(null) };
}
/** Reset router spies + pathname/search/session between tests. */
export function resetRtl() {
    Object.values(router).forEach((fn) => (fn as jest.Mock).mockClear());
    pathname = "/";
    searchParams = new URLSearchParams();
    session = { data: null, status: "unauthenticated" };
    checkinEnv = "prod";
    shopifyStoreDomain = null;
    isStaging = false;
}

// ── fetch stub ───────────────────────────────────────────────────────────────
/**
 * Stub `global.fetch`, routing by URL substring. Values may be data or a
 * `() => data` factory. A matched route → 200 + json; unmatched → 404.
 * Returns the jest.fn so callers can assert on it.
 */
export function mockFetchJson(routes: Record<string, unknown | (() => unknown)>) {
    // The unused `init` param types `.mock.calls[N][1]` as the RequestInit so tests
    // can assert on the request's method/body.
    const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = typeof input === "string" ? input : input.toString();
        const key = Object.keys(routes).find((k) => url.includes(k));
        const raw = key !== undefined ? routes[key] : undefined;
        const body = typeof raw === "function" ? (raw as () => unknown)() : raw;
        return {
            ok: key !== undefined,
            status: key !== undefined ? 200 : 404,
            json: async () => body ?? {},
            text: async () => JSON.stringify(body ?? {}),
        } as Response;
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
}

/**
 * Wrap a params/searchParams value as an ALREADY-fulfilled promise so React 19's
 * `use(params)` returns synchronously under RTL. A bare `Promise.resolve(v)`
 * suspends on the first read (its `.then` fires as a microtask, which RTL's sync
 * `render()`/`act()` doesn't await), committing an empty tree. Pre-marking the
 * promise with React's own thenable-cache shape (`status:"fulfilled"`, `value`)
 * makes `use()` unwrap it immediately — no Suspense boundary needed.
 * Usage: `renderWithProviders(<Page params={resolvedParams({ id: "1" })} />)`.
 */
export function resolvedParams<T>(value: T): Promise<T> {
    const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
    p.status = "fulfilled";
    p.value = value;
    return p;
}
