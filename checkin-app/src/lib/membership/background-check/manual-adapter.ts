import { config } from "@/lib/config";
import type { BackgroundCheckProvider } from "./provider";

/**
 * Manual (human-marked) background-check provider for Averity/VERITY.
 *
 * Consent link comes from the AVERITY_CONSENT_URL env var (Averity exposes no API,
 * so it's a static hosted deep link, configured out-of-band rather than board-edited).
 * After submitting on Averity the applicant self-reports in-app (#875); a board
 * member — who receives Averity's email — can also mark it as the backstop.
 */
export class ManualBackgroundCheckProvider implements BackgroundCheckProvider {
    async getConsentDeepLink(): Promise<string | null> {
        return config.averityConsentUrl();
    }
}

/**
 * Dev/local mock provider (see docs/ops/background-check-mock.md). Averity has no dev sandbox, so
 * when its consent URL is unset on a non-prod instance the mock hands the applicant an
 * in-app consent page (/dev/bg-consent) that records consent for real — driving the
 * same markBgConsent → parallel review path prod does. Board members then sign off
 * through the normal two-reviewer attestation. 404s off a dev instance by construction.
 */
export class MockBackgroundCheckProvider implements BackgroundCheckProvider {
    async getConsentDeepLink(): Promise<string | null> {
        return `${config.baseUrl()}/dev/bg-consent`;
    }
}

const realProvider = new ManualBackgroundCheckProvider();
const mockProvider = new MockBackgroundCheckProvider();

/**
 * The active provider: real (manual Averity) normally, the mock on an unconfigured dev
 * instance. Per-call selection (mirrors zohoSign) so tests toggling env pick up the change.
 */
export const backgroundCheckProvider: BackgroundCheckProvider = {
    getConsentDeepLink: () => (config.bgMockActive() ? mockProvider : realProvider).getConsentDeepLink(),
};
