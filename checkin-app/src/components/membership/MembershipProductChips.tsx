"use client";

import { useEffect } from "react";
import { clearError, showError } from "@checkin/component-ui";
import { useLoad } from "@/lib/api";

type MembershipProductProblem = { year: number; cause: string; message: string };

const chipKey = (year: number) => `membership-product-${year}`;

/**
 * A red chip, which never closes on its own, for each membership year whose product
 * families with an unpaid application for that year can't pay through. A chip goes
 * once a re-read no longer lists its year.
 */
export function MembershipProductChips() {
  const { data } = useLoad<{ problems?: MembershipProductProblem[] }>("/api/membership-ops/membership-products", { retry: false });
  const problems = data?.problems;
  useEffect(() => {
    if (!problems) return;
    for (const p of problems) showError(p.message, { key: chipKey(p.year), title: "Membership payment unavailable" });
    return () => { for (const p of problems) clearError(chipKey(p.year)); };
  }, [problems]);
  return null;
}
