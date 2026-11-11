/**
 * Mount the receipt library's route factories under checkin's handler() and fileHandler().
 */
import type { Access, ReceiptFileRouteHandler, ReceiptRouteCtx, ReceiptRouteHandler } from "@checkin/receipt";
import { componentRoute } from "@/lib/components/route";
import { FILE_CONTENT_TYPES, type FileContentType, type Role } from "@/security/core";
import type { FileHandlerFn } from "@/security/fileHandler";
import { badRequest, unauthorized, type HandlerContext, type HandlerFn } from "@/security/handler";

function routeCtx({ req, params, role, auth }: HandlerContext): ReceiptRouteCtx {
  const access = accessOf(role);
  return {
    req,
    params,
    access,
    financeActorId: role === "isFinance" ? sessionId({ auth }) : null,
    submitterActorId: access === "submitter" ? sessionPersonId(auth) : null,
  };
}

export function receiptRoute(factory: ReceiptRouteHandler): HandlerFn {
  return componentRoute((ctx) => factory(routeCtx(ctx)));
}

function isFileContentType(type: string): type is FileContentType {
  return (FILE_CONTENT_TYPES as readonly string[]).includes(type);
}

export function receiptFileRoute(factory: ReceiptFileRouteHandler): FileHandlerFn {
  return componentRoute(async (ctx) => {
    const file = await factory(routeCtx(ctx));
    // The upload and intake magic-byte checks admit only allowlisted types; anything else is a stored-data bug.
    if (!isFileContentType(file.contentType)) throw new Error(`${ctx.req.nextUrl.pathname} has unservable type ${file.contentType}`);
    return { ...file, contentType: file.contentType };
  });
}

/** The view handler() picked: FINANCE (or BOARD on a read) acts org-wide, anyone else on their own. */
export function accessOf(role: Role): Access {
  return role === "isFinance" || role === "isBoardMember" ? "finance" : "submitter";
}

export async function readJson(ctx: HandlerContext<Record<string, string>>): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

function sessionPersonId(auth: HandlerContext["auth"]): number | null {
  return auth.type === "session" && Number.isInteger(auth.user.id) ? auth.user.id : null;
}

/** The caller's Person.id. Admission already required one; anything else is a 401. */
export function sessionId(ctx: Pick<HandlerContext, "auth">): number {
  const id = sessionPersonId(ctx.auth);
  if (id === null) throw unauthorized();
  return id;
}
