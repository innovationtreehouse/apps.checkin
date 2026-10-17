/**
 * Smoke test for the shared RTL harness (test-helpers/rtl). Proves the Mantine
 * wrap, fetch stub, and nav/auth mocks work, so page/component tests can rely on it.
 */
import { screen } from "@testing-library/react";
import { Button } from "@mantine/core";
import { renderWithProviders, mockFetchJson, navMock, authMock, setSession, setPathname, resetRtl, router } from "../rtl";

beforeEach(() => resetRtl());

describe("rtl test-helper", () => {
    it("renderWithProviders renders a Mantine component (matchMedia/ResizeObserver polyfilled)", () => {
        renderWithProviders(<Button>Hi</Button>);
        expect(screen.getByRole("button", { name: "Hi" })).toBeInTheDocument();
    });

    it("mockFetchJson routes by URL substring (data + factory + miss)", async () => {
        const fn = mockFetchJson({ "/api/foo": { a: 1 }, "/api/bar": () => ({ b: 2 }) });
        expect(await (await fetch("/api/foo")).json()).toEqual({ a: 1 });
        expect(await (await fetch("/api/bar")).json()).toEqual({ b: 2 });
        const miss = await fetch("/api/nope");
        expect(miss.ok).toBe(false);
        expect(miss.status).toBe(404);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("nav/auth mocks expose controllable state", () => {
        setPathname("/x");
        setSession({ id: 1, isSysadmin: true });
        expect(navMock().usePathname()).toBe("/x");
        expect(navMock().useRouter()).toBe(router);
        expect(authMock().useSession()).toEqual({ data: { user: { id: 1, isSysadmin: true } }, status: "authenticated", update: expect.any(Function) });
    });

    it("resetRtl clears router spies and state", () => {
        router.push("/a");
        setSession({ id: 9 });
        resetRtl();
        expect(router.push).not.toHaveBeenCalled();
        expect(authMock().useSession()).toEqual({ data: null, status: "unauthenticated" });
    });
});
