"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { PageLoader } from "@/components/ui/PageLoader";
// Bare /attendance is just the entry point — the Current view lives at
// /attendance/current. Redirect here, preserving query params so signed kiosk
// URLs (/attendance?mode=kiosk&sig=...&ts=...&nonce=...) keep working.
function Redirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const qs = searchParams.toString();
    router.replace(`/attendance/current${qs ? `?${qs}` : ""}`);
  }, [router, searchParams]);
  return <PageLoader minHeight="100vh" />;
}

export default function AttendanceIndex() {
  return (
    <Suspense fallback={<PageLoader minHeight="100vh" />}>
      <Redirect />
    </Suspense>
  );
}
