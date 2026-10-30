/**
 * Mount the receipt library's route factories under checkin's handler() and fileHandler(). The
 * routes that stamp a line's owner for the stripper stay in the host and use receiptHostRoute.
 */
import type { Access, ReceiptFileRouteHandler, ReceiptRouteCtx, ReceiptRouteHandler } from "@checkin/receipt";
import { componentRoute } from "@/lib/components/route";
import { FILE_CONTENT_TYPES, type FileContentType, type Role } from "@/security/core";
import type { FileHandlerFn } from "@/security/fileHandler";
import { badRequest, unauthorized, type HandlerContext, type HandlerFn } from "@/security/handler";

/** A route body in the host; the library's expected failures render as API errors. */
export function receiptHostRoute<P extends Record<string, string>>(fn: HandlerFn<P>): HandlerFn<P> {
  return componentRoute(fn);
}

function routeCtx({ req, params, role, auth }: HandlerContext): ReceiptRouteCtx {
  return { req, params, access: accessOf(role), financeActorId: role === "isFinance" ? sessionId({ auth }) : null };
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

/** The caller's Person.id. Admission already required one; anything else is a 401. */
export function sessionId(ctx: Pick<HandlerContext, "auth">): number {
  if (ctx.auth.type !== "session" || !Number.isInteger(ctx.auth.user.id)) throw unauthorized();
  return ctx.auth.user.id;
}

/**
 * A line row carries no owner column, and the stripper scopes each nested row by itself, so a
 * submitter's lines are stamped with their receipt's uploader or `their_own` strips them.
 */
export function stampLines<T extends object>(lines: T[], uploadedByUserId: number): (T & { uploadedByUserId: number })[] {
  return lines.map((line) => ({ ...line, uploadedByUserId }));
}

/**
 * One line a write returned. A submitter's write reached only their own receipt, so it is
 * stamped with their id; finance reads every line and needs no stamp.
 */
export function ownLine<T extends object>(ctx: HandlerContext<Record<string, string>>, line: T): T {
  return accessOf(ctx.role) === "submitter" ? { ...line, uploadedByUserId: sessionId(ctx) } : line;
}
