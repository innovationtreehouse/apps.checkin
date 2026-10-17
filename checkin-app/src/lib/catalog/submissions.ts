/**
 * X8: workflow-mapping's CatalogSubmissions bound in-process to the catalog's
 * proposal, conflict and provisional-GTIN services. Each payload is parsed with its
 * receipt-types schema, then stamped with the injected org. Catalog errors propagate, so
 * associate and propose fail rather than skip catalog curation.
 */
import { conflictResolutionService, proposalService, provisionalGtinService } from "@inventory/global-catalog";
import {
  catalogItemReferenceProposalSchema,
  catalogProvisionalItemProposalSchema,
  catalogReferenceConflictSchema,
} from "@inventory/receipt-types";
import type { CatalogSubmissions, OrgIdentity } from "@inventory/workflow-mapping";

export function createCatalogSubmissions(org: () => Promise<OrgIdentity>): CatalogSubmissions {
  return {
    async proposeItemReference(p) {
      const proposal = catalogItemReferenceProposalSchema.parse(p);
      const { id: orgId, name: orgName } = await org();
      const { id } = await proposalService.createItemReferenceProposal({ ...proposal, orgId, orgName });
      return { id };
    },

    async reportConflict(p) {
      return conflictResolutionService.reportConflict(catalogReferenceConflictSchema.parse(p));
    },

    async allocateProvisionalGtin() {
      return (await provisionalGtinService.allocateNextProvisionalGtin()).gtin13;
    },

    async proposeProvisionalItem(p) {
      const proposal = catalogProvisionalItemProposalSchema.parse(p);
      const { id: orgId, name: orgName } = await org();
      await provisionalGtinService.createProvisionalItem({ ...proposal, orgId, orgName });
    },
  };
}
