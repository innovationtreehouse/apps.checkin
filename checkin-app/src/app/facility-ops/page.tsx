"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

import { visibleLinks } from "@/lib/nav/gates";
import { FACILITY_OPS } from "@/lib/nav/sections/facilityOps";

import { PageLoader } from "@/components/ui/PageLoader";
/**
 * /facility-ops has no content of its own — it redirects to the caller's first
 * visible tab. Client-side because the destination depends on the session
 * (board/sysadmin→visits, operations→print-badges). The layout enforces access.
 */
export default function FacilityOpsIndex() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(visibleLinks(FACILITY_OPS, session?.user, null)[0]?.href ?? "/");
    }
  }, [status, session, router]);

  return (
    <PageLoader />
  );
}
