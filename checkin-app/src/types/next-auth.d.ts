import type { AgeBand } from "@/lib/programAge";
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: {
      id: number;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      // Household membership is DENIED — login is blocked; all role flags are forced false.
      denied?: boolean;
      isSysadmin?: boolean;
      isKeyholder?: boolean;
      isBoardMember?: boolean;
      isBackgroundCheckReviewer?: boolean;
      isOperations?: boolean;
      isInventoryManager?: boolean;
      householdId?: number | null;
      householdLead?: boolean;
      // adult / youth / unknown — the derived band only, never the date
      // (dateOfBirth is @sensitivity:personal). Gates the youth surfaces in
      // docs/rules/programs.md ("What a youth sees of money"); the routes are
      // the boundary.
      ageBand?: AgeBand;
      // Program ids this user is the lead mentor of. Client-side row gate only
      // (the API is the real boundary); mirrors access-resolvers' programsLed.
      programsLed?: number[];
      toolStatuses?: { toolId: number; level: string }[];
      // Inert impersonation provenance — display/audit only, never read by authz.
      impersonatedBy?: string | null;
      // Org-gate claims surfaced for the dev-instance server-action fence (assertDevActor).
      // Not secrets — anyone able to load the dev app is already org-verified by the middleware.
      hd?: string | null;
      emailVerified?: boolean;
      // ops-stg access gate escape hatch — sysadmin-settable, NOT one of the
      // five PersonRole flags above. See lib/config.ts isStagingAccessAllowed.
      canAccessStaging?: boolean;
    };
  }

  interface User {
    id: number | string;
    isSysadmin?: boolean;
    isKeyholder?: boolean;
    isBoardMember?: boolean;
    isBackgroundCheckReviewer?: boolean;
    isOperations?: boolean;
    isInventoryManager?: boolean;
    householdId?: number | null;
    householdLead?: boolean;
    toolStatuses?: { toolId: number; level: string }[];
    // Set by the persona-mint provider; carried into the JWT by the jwt callback.
    impersonatedBy?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: number;
    // Household membership is DENIED — login is blocked; all role flags are forced false.
    denied?: boolean;
    // Google hosted-domain + email_verified claims, used by the dev-instance org-login gate.
    hd?: string | null;
    emailVerified?: boolean;
    // Inert impersonation provenance — display/audit only, never read by authz.
    impersonatedBy?: string | null;
    isSysadmin?: boolean;
    isKeyholder?: boolean;
    isBoardMember?: boolean;
    isBackgroundCheckReviewer?: boolean;
    isOperations?: boolean;
    isInventoryManager?: boolean;
    householdId?: number | null;
    householdLead?: boolean;
    // See Session.user.ageBand above — derived band, never the DOB.
    ageBand?: AgeBand;
    programsLed?: number[];
    toolStatuses?: { toolId: number; level: string }[];
    // ops-stg access gate escape hatch — see Session.user.canAccessStaging above.
    canAccessStaging?: boolean;
  }
}
