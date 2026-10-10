// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next/navigation", () => require("@/test-helpers/rtl").navMock());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock("next-auth/react", () => require("@/test-helpers/rtl").authMock());
import { screen, fireEvent } from "@testing-library/react";
import { signIn, signOut } from "next-auth/react";
import {
    renderWithProviders,
    setSession,
    setSearchParams,
    setCheckinEnv,
    resetRtl,
    router,
} from "@/test-helpers/rtl";
import SignInPage from "../page";

beforeEach(() => resetRtl());

describe("SignInPage", () => {
    it("wires the Google sign-in button when signed out", () => {
        renderWithProviders(<SignInPage />);

        fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

        expect(signIn).toHaveBeenCalledWith("google", { callbackUrl: "/" });
    });

    it("offers a continue link when already signed in", () => {
        setSession({ id: 1, name: "Ann Admin" });
        renderWithProviders(<SignInPage />);

        expect(screen.getByRole("link", { name: /continue as ann admin/i })).toBeInTheDocument();
    });

    it("redirects an authenticated, org-OK visitor straight to the callback URL", () => {
        setSession({ id: 1, name: "Ann Admin" });
        renderWithProviders(<SignInPage />);

        expect(router.replace).toHaveBeenCalledWith("/");
    });

    it("renders no sign-in button while the session is still loading", () => {
        setSession(null, "loading");
        renderWithProviders(<SignInPage />);

        expect(screen.queryByRole("button", { name: /sign in with google/i })).not.toBeInTheDocument();
    });

    it("shows the wrong-account notice (via AlertBanner) and wires sign-out on a dev, non-org account", () => {
        setCheckinEnv("dev");
        setSession({ id: 1, email: "x@gmail.com", hd: "gmail.com" });
        renderWithProviders(<SignInPage />);

        expect(screen.getByText(/not managed by the/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
        expect(signOut).toHaveBeenCalledWith({ callbackUrl: "/signin" });
    });

    it("shows the sign-in-didn't-complete notice (via AlertBanner) when signed in with an error param", () => {
        setSession({ id: 1, name: "Ann Admin" });
        setSearchParams("error=OAuthCallback");
        renderWithProviders(<SignInPage />);

        expect(screen.getByText(/didn't complete/i)).toBeInTheDocument();
        expect(screen.getByText(/OAuthCallback/)).toBeInTheDocument();
    });

    it("tells a signed-out visitor refused over an unverified Google email what to do", () => {
        setSearchParams("error=EmailNotVerified");
        renderWithProviders(<SignInPage />);

        expect(screen.getByText(/confirm your email address in your google account/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    });

    it("renders the wordmark lowercase", () => {
        renderWithProviders(<SignInPage />);

        const wordmark = screen.getByRole("heading", { name: /checkmein/i });
        expect(wordmark).toHaveStyle({ textTransform: "lowercase" });
    });

    it("(regression) shows the primary sign-in button when signed out and not on a local instance", () => {
        renderWithProviders(<SignInPage />);

        expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    });
});
