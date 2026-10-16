/** In-kind donations that arrived with a receipt: the finance queue. */
import { inKindService } from "../services/inKindService";
import { getOrgId } from "../runtime";
import type { DonationRouteHandler } from "../contract";

export const listQueue: DonationRouteHandler = async () => ({
  InKindQueueItemView: await inKindService.listQueue(await getOrgId()),
});
