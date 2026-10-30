import { NextResponse } from "next/server";
import { SCAN_PROTOCOL_VERSION } from "@/lib/scanProtocol";

// Fixed per build, so every task of one deploy reports the same value.
const version = process.env.NEXT_PUBLIC_GIT_SHA || "dev";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ version, scanProtocolVersion: SCAN_PROTOCOL_VERSION });
}
