import crypto from "crypto";
import * as realClient from "@/lib/membership/contract/zohoClient";
import { signingMockActive } from "@/lib/membership/contract/signingTarget";

/**
 * Zoho Sign provider seam (see docs/ops/contract-signing-mock.md).
 *
 * The real adapter is today's zohoClient (network + OAuth), used in prod and any
 * dev instance with real secrets. The mock adapter stands in on a non-prod
 * instance with the secrets unset (config.zohoMockActive()): it fabricates ids and
 * points the applicant at a dev interstitial (/dev/zoho-sign) instead of a real
 * signing ceremony. Everything BELOW markContractSigned — the webhook path and the
 * state machine — stays real, so transitions and audit rows are identical to prod.
 *
 * The interface is pinned to the real client's signatures via `typeof`, so the mock
 * can never drift from the shape external.ts calls.
 */
export type ZohoSignProvider = {
    getAccessToken: typeof realClient.getAccessToken;
    createRequest: typeof realClient.createRequest;
    submitRequest: typeof realClient.submitRequest;
    getEmbeddedSignUrl: typeof realClient.getEmbeddedSignUrl;
    getRequestStatus: typeof realClient.getRequestStatus;
    recallRequest: typeof realClient.recallRequest;
};

const realProvider: ZohoSignProvider = {
    getAccessToken: realClient.getAccessToken,
    createRequest: realClient.createRequest,
    submitRequest: realClient.submitRequest,
    getEmbeddedSignUrl: realClient.getEmbeddedSignUrl,
    getRequestStatus: realClient.getRequestStatus,
    recallRequest: realClient.recallRequest,
};

const mockProvider: ZohoSignProvider = {
    async getAccessToken() {
        return "dev-mock-token";
    },
    // Fabricate ids; the PDF is never uploaded (external.ts skips the S3 load in mock
    // mode). The requestId is what gets stored as zohoEnvelopeId and matched by the
    // (self-fired) webhook, so it must be unique per signing request.
    async createRequest() {
        const id = crypto.randomUUID();
        return { requestId: `dev-req-${id}`, actionId: `dev-act-${id}`, documentId: `dev-doc-${id}` };
    },
    async submitRequest() {
        /* no-op: no real request to attach fields to */
    },
    // Send the applicant to the dev interstitial carrying the request id, not
    // straight to ?signed=1 — the interstitial is where completion is triggered.
    async getEmbeddedSignUrl({ requestId, host }) {
        return `${host}/dev/zoho-sign?rid=${encodeURIComponent(requestId)}`;
    },
    // The webhook records signing in the mock; this backs the ?signed=1 sync path,
    // which then no-ops idempotently. Report completed so a sync-only race still
    // lands. Never "terminal": mock requests don't expire, so the dead-request
    // recovery path (#876) stays dormant in mock mode.
    async getRequestStatus() {
        return "completed" as const;
    },
    async recallRequest() {
        /* no-op: nothing was sent */
    },
};

/**
 * Per-call selection so tests toggling CHECKIN_ENV / secrets pick up the change,
 * and so the dev-instance settings radio (signingMockActive → BoardSettings.
 * devSigningTarget) takes effect without a redeploy. All methods are async, so
 * awaiting the pick doesn't change the interface.
 */
const pick = async (): Promise<ZohoSignProvider> => ((await signingMockActive()) ? mockProvider : realProvider);

export const zohoSign: ZohoSignProvider = {
    getAccessToken: async (...a) => (await pick()).getAccessToken(...a),
    createRequest: async (...a) => (await pick()).createRequest(...a),
    submitRequest: async (...a) => (await pick()).submitRequest(...a),
    getEmbeddedSignUrl: async (...a) => (await pick()).getEmbeddedSignUrl(...a),
    getRequestStatus: async (...a) => (await pick()).getRequestStatus(...a),
    recallRequest: async (...a) => (await pick()).recallRequest(...a),
};
