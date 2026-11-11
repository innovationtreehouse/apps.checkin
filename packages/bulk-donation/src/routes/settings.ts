/** The in-kind lane's QuickBooks settings. */
import { mapServiceErrors } from "@checkin/component-kit";
import { z } from "zod";
import { db } from "../db";
import { getOrgId } from "../runtime";
import type { DonationRouteHandler } from "../contract";
import { readDonationSettings, updateDonationSettings, type DonationSettingsRoles } from "../services/settingsService";
import { auditContext, parseBodyCapped } from "./_shared";

export const get: DonationRouteHandler = async () => {
  const orgId = await getOrgId();
  return { DonationOrgSettings: { orgId, ...(await readDonationSettings(db, orgId)) } };
};

/** The roles come from the host's auth context, because the library's principal carries none. */
export const update = (roles: DonationSettingsRoles): DonationRouteHandler => async ({ req }) => {
  const patch = await parseBodyCapped(req, z.unknown());
  const [orgId, actor] = await Promise.all([getOrgId(), auditContext(req)]);
  const next = await mapServiceErrors(() => updateDonationSettings(orgId, patch, roles, actor));
  return { DonationOrgSettings: { orgId, ...next } };
};
