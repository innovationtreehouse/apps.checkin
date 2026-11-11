"use client";
// The screen lives in the receipt library; opened from Finance review it returns there.
import ReceiptDetailPage from "@checkin/receipt/pages/detail";
import { FINANCE_REVIEW_PATH } from "@/lib/nav/sections/finance";

export default function Page() {
  return <ReceiptDetailPage queueBase={FINANCE_REVIEW_PATH} />;
}
