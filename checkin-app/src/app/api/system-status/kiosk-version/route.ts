import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { SCAN_PROTOCOL_VERSION } from "@/lib/scanProtocol";
import { config } from "@/lib/config";
import { getKioskPublicKeys, verifyKioskSignature } from "@/lib/verify-kiosk";
import { peekFacilityState, type FacilityState } from "@/lib/getFullAttendance";

// Cache it for the lifetime of this Node process
let cachedVersion: string | null = null;

export const dynamic = "force-dynamic";

/**
 * A verified kiosk also gets the building state this task already holds. The
 * kiosk polls this route once a second, so nothing here may touch the database:
 * the version is a process-cached sha, the facility state is read from the
 * attendance cache without computing, and the signature's nonce cache and
 * last-seen stamp are both in memory. Whether a poll turns into a query is then
 * the server's decision — an empty building answers from memory and Aurora
 * stays paused.
 *
 * It is gated on the signature because "the building is empty right now" is not
 * something an unauthenticated caller may read.
 */
function kioskFacility(req: NextRequest): FacilityState | null {
    const pubKeys = getKioskPublicKeys();
    const signature = req.headers.get("x-kiosk-signature");

    if (pubKeys.length === 0) {
        // Local dev only, mirroring the keyless-kiosk gating on GET /api/attendance:
        // on the cloud dev instance or prod an unset KIOSK_PUBLIC_KEY grants nothing.
        return config.isLocal() ? peekFacilityState() : null;
    }
    if (!signature) return null;

    const result = verifyKioskSignature(
        "GET",
        "/api/system-status/kiosk-version",
        "",
        req.headers.get("x-kiosk-timestamp"),
        signature,
        req.headers.get("x-kiosk-nonce"),
        pubKeys,
    );
    return result.ok ? peekFacilityState() : null;
}

export async function GET(req: NextRequest) {
  if (!cachedVersion) {
    try {
      if (process.env.VERCEL_GIT_COMMIT_SHA) {
        cachedVersion = process.env.VERCEL_GIT_COMMIT_SHA;
      } else {
        cachedVersion = execSync("git rev-parse HEAD").toString().trim();
      }
    } catch {
      cachedVersion = "unknown-" + Date.now();
    }
  }

  const facility = kioskFacility(req);
  return NextResponse.json({
    version: cachedVersion,
    scanProtocolVersion: SCAN_PROTOCOL_VERSION,
    ...(facility ? { facility } : {}),
  });
}
