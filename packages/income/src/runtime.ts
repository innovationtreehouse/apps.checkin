import type {
  IncomeAuth,
  IncomePrincipal,
  OrgIdentity,
  OwnerDirectory,
  PayoutMirror,
  QbDepositSource,
} from "./contract";
import { ServiceError } from "./services/serviceError";

export interface IncomeConfig {
  /** Who is acting; the routes need it, the reconcile engine does not. */
  auth?: IncomeAuth;
  /** Org identity as an async accessor, called per request: the host may read it from its store. */
  org?: () => Promise<OrgIdentity>;
  mirror?: PayoutMirror;
  deposits?: QbDepositSource;
  owners?: OwnerDirectory;
  /** Days after a payout within which its deposit must be booked. */
  windowDays?: number;
  /** Earliest payout date to reconcile. Defaults to the oldest payout in the mirror. */
  reconcileFrom?: Date;
}

// On globalThis so the instrumentation chunk that configures it and the route chunks that
// read it share one runtime (and it survives dev HMR).
const globalForRuntime = globalThis as typeof globalThis & { __incomeRuntime?: IncomeConfig };

export function configureIncome(next: IncomeConfig): void {
  globalForRuntime.__incomeRuntime = { ...next };
}

export function getIncomeConfig(): IncomeConfig {
  return globalForRuntime.__incomeRuntime ?? {};
}

/** The acting host user. Throws if absent: host admission has already run. */
export async function getPrincipal(): Promise<IncomePrincipal> {
  const auth = getIncomeConfig().auth;
  if (!auth) throw new Error("income runtime not configured: the host must pass auth to configureIncome()");
  const principal = await auth.getPrincipal();
  if (!principal || !Number.isInteger(principal.id)) {
    throw new Error("no income principal: host admission should have rejected this request");
  }
  return principal;
}

/** The current request's org id, the scope of every income row. */
export async function getOrgId(): Promise<string> {
  const org = getIncomeConfig().org;
  if (!org) throw new Error("income runtime not configured: the host must pass org to configureIncome()");
  return (await org()).id;
}

/** An HTTP-status error thrown by a route factory; the host renders it at the route boundary. */
export class IncomeHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "IncomeHttpError";
  }
}

/** Run a service call, remapping its ServiceError to a host-rendered HTTP error. */
export async function mapServiceErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw new IncomeHttpError(err.statusCode, err.message);
    throw err;
  }
}

/** YYYY-MM-DD in UTC, the format CSV payout dates and QB txnDates use. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
