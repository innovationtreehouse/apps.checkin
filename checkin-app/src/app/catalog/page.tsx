"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageLoader } from "@/components/ui/PageLoader";
import { CATALOG_TOP_NAV } from "@/lib/catalogNav";

/** /catalog has no content of its own — it redirects to the first tab (Items).
 *  The layout enforces access. */
export default function CatalogIndex() {
  const router = useRouter();
  useEffect(() => { router.replace(CATALOG_TOP_NAV.href); }, [router]);
  return <PageLoader />;
}
