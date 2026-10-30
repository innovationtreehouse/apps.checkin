"use client";

import { createContext, useContext } from 'react';
import type { CheckinEnv } from '@/lib/config';

/**
 * Carries server-only runtime config into client components.
 *
 * CHECKIN_ENV is server-only (not NEXT_PUBLIC_), so client code cannot read it from
 * process.env. The Shopify store domain lives in the same place: a single runtime
 * secret SHOPIFY_STORE_DOMAIN (never NEXT_PUBLIC_, so it is not baked into the client
 * bundle at build time). The root layout (a server component) reads both at request
 * time and feeds them in here; client components consume them via the hooks below.
 */
type EnvContextValue = {
    checkinEnv: CheckinEnv;
    /** Public …myshopify.com domain from SHOPIFY_STORE_DOMAIN, or null when unconfigured. */
    shopifyStoreDomain: string | null;
    /** True on ops-stg. Separate from checkinEnv, which staging deliberately collapses to 'prod' (see config.isStaging). */
    isStaging: boolean;
};

const CheckinEnvContext = createContext<EnvContextValue>({ checkinEnv: 'prod', shopifyStoreDomain: null, isStaging: false });

export function EnvProvider({
    value,
    children,
}: {
    value: EnvContextValue;
    children: React.ReactNode;
}) {
    return <CheckinEnvContext.Provider value={value}>{children}</CheckinEnvContext.Provider>;
}

export function useCheckinEnv(): CheckinEnv {
    return useContext(CheckinEnvContext).checkinEnv;
}

/** True on the cloud dev instance OR a local laptop (i.e. not prod). */
export function useIsDevInstance(): boolean {
    return useContext(CheckinEnvContext).checkinEnv !== 'prod';
}

/** True only on a developer laptop — gates offline credential login UI. */
export function useIsLocalInstance(): boolean {
    return useContext(CheckinEnvContext).checkinEnv === 'local';
}

/** True on ops-stg — gates the staging banner. NOT a mock gate; staging keeps checkinEnv 'prod'. */
export function useIsStagingInstance(): boolean {
    return useContext(CheckinEnvContext).isStaging;
}

/**
 * The public Shopify store domain, supplied by the server at request time from the
 * runtime SHOPIFY_STORE_DOMAIN secret. Null when the store isn't configured. Client
 * checkout links must read it from here — never from process.env, which would need a
 * build-time NEXT_PUBLIC_ copy that drifts out of sync with the runtime secret.
 */
export function useShopifyStoreDomain(): string | null {
    return useContext(CheckinEnvContext).shopifyStoreDomain;
}
