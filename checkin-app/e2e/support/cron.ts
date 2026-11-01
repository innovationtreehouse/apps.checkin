import { api } from "../../flow-tests/helpers";

/**
 * The real nightly job. It also sends pending post-event emails, strips dates of birth over 25
 * and opens adult-child agreements, on a stack other specs share, so call it only for a test of
 * the nightly close.
 */
export async function runNightly(): Promise<void> {
  const { status } = await api(null, "/api/cron/nightly", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
  if (status !== 200) throw new Error(`nightly job: ${status}`);
}
