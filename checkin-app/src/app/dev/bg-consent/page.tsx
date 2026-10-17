import { notFound } from "next/navigation";
import { config } from "@/lib/config";
import DevBgConsentClient from "./DevBgConsentClient";

export const dynamic = "force-dynamic";

/**
 * Dev-only stand-in for Averity's hosted background-check consent page (see
 * docs/ops/background-check-mock.md). The mock provider's getConsentDeepLink points
 * the applicant here (Averity has no dev sandbox). Confirming records real consent
 * (markBgConsent) so the application advances and enters the board review queue,
 * where board members sign off through the normal two-reviewer attestation.
 * 404s the moment the mock isn't active (always in prod) so it can never surface.
 */
export default function DevBgConsentPage() {
    if (!config.bgMockActive()) notFound();
    return <DevBgConsentClient />;
}
