// Stub (#1289): the screen lives in the workflow-mapping library; checkin passes the page it was opened from.
import ReceiptPage from "@checkin/workflow-mapping/pages/receipt";
import { returnPath } from "@/lib/returnPath";

export default async function Page({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams;
  return <ReceiptPage backHref={returnPath(from, "/inventory/receiving")} />;
}
