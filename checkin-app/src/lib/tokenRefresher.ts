/**
 * Invokes a token refresher Lambda (QuickBooks or Gmail) for `{ action: "current" }`. A failed
 * invocation is `connection` when the refresher names it ReconsentRequired (a revoked login a
 * person must reconnect), and `system` otherwise, which is all a refresher deployed before
 * that name existed can answer.
 */
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { KindedError } from "@checkin/component-kit";
import { config } from "@/lib/config";

export interface RefresherCall {
  functionName: string;
  /** "QBO token refresher", "Gmail token refresher": names the failure without its detail. */
  service: string;
  /** The connection error's message: what to reconnect, and who does it. */
  reconnect: string;
}

/** Only errorType is read: the error message can echo token-endpoint detail. */
function errorType(payload: Uint8Array | undefined): unknown {
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(payload));
    return typeof body === "object" && body !== null && "errorType" in body ? body.errorType : undefined;
  } catch {
    return undefined;
  }
}

export async function invokeRefresher(call: RefresherCall): Promise<unknown> {
  const lambda = new LambdaClient({ region: config.awsRegion() });
  let res;
  try {
    res = await lambda.send(new InvokeCommand({ FunctionName: call.functionName, Payload: JSON.stringify({ action: "current" }) }));
  } catch (err) {
    throw new KindedError("system", `${call.service} ${call.functionName} could not be invoked`, { cause: err });
  }
  if (res.FunctionError) {
    if (errorType(res.Payload) === "ReconsentRequired") throw new KindedError("connection", call.reconnect);
    throw new KindedError("system", `${call.service} ${call.functionName} failed`);
  }
  return JSON.parse(new TextDecoder().decode(res.Payload));
}
