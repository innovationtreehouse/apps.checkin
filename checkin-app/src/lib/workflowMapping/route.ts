/**
 * Mount a workflow-mapping route factory under checkin's handler() (#1289 §7).
 *
 * handler() renders an error's status only when it is `instanceof` its own
 * ApiResponseError, so the library's HTTP error is translated here, in the
 * route's module graph.
 */
import type { WorkflowRouteHandler } from "@inventory/workflow-mapping";
import { ApiResponseError } from "@/security/handler";
import { WorkflowMappingHttpError } from "@/lib/workflowMapping/configure";

export function workflowRoute(factory: WorkflowRouteHandler): WorkflowRouteHandler {
  return async (ctx) => {
    try {
      return await factory(ctx);
    } catch (err) {
      if (err instanceof WorkflowMappingHttpError) throw new ApiResponseError(err.status, err.message);
      throw err;
    }
  };
}
