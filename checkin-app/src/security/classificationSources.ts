import {
    classifications as checkinClassifications,
    relations as checkinRelations,
    marks as checkinMarks,
} from './generated/classifications';
import {
    classifications as catalogClassifications,
    relations as catalogRelations,
    marks as catalogMarks,
} from './generated/catalog-classifications';
import {
    classifications as catalogSyntheticClassifications,
    relations as catalogSyntheticRelations,
    marks as catalogSyntheticMarks,
} from './catalogSyntheticClassifications';
import * as inventoryGenerated from './generated/inventory-classifications';
import * as inventorySynthetic from './inventorySyntheticClassifications';
import * as expenseGenerated from './generated/expense-classifications';
import * as expenseSynthetic from './expenseSyntheticClassifications';
import * as incomeGenerated from './generated/income-classifications';
import * as incomeSynthetic from './incomeSyntheticClassifications';
import * as donationGenerated from './generated/donation-classifications';
import * as donationSynthetic from './donationSyntheticClassifications';
import * as workflowGenerated from './generated/workflow-classifications';
import * as workflowSynthetic from './workflowSyntheticClassifications';
import * as receiptGenerated from './generated/receipt-classifications';
import * as receiptSynthetic from './receiptSyntheticClassifications';
import * as programSynthetic from './programSyntheticClassifications';
import * as budgetOwnerSynthetic from './budgetOwnerSyntheticClassifications';
import * as keyVolunteerSynthetic from './keyVolunteerSyntheticClassifications';
import * as checkStartedSynthetic from './checkStartedSyntheticClassifications';
import * as volunteerRosterSynthetic from './volunteerRosterSyntheticClassifications';
import * as householdSynthetic from './householdSyntheticClassifications';
import * as problemsSynthetic from './problemsSyntheticClassifications';
import * as membershipApplicationSynthetic from './membershipApplicationSyntheticClassifications';
import * as facilitySafetySynthetic from './facilitySafetySyntheticClassifications';
import * as membershipAuditSynthetic from './membershipAuditSyntheticClassifications';
import * as shopifyReadGenerated from './generated/shopify-read-classifications';
import * as shopifyReadSynthetic from './shopifyReadSyntheticClassifications';

// Every classification source: checkin's schema, each vendored library's schema
// (its own `generator security` map), and hand-authored synthetic response
// models (e.g. CatalogItemCount). The flat merge below is
// the whole-system map every boundary consumer (stripper, outbound, registry)
// reads through — import `classifications` / `relations` from core.ts, not from a
// source file. Model keys must be disjoint across sources, or a later source
// silently overwrites an earlier one; __tests__/classification-sources.test.ts
// enforces that.
export const CLASSIFICATION_SOURCES = [
    { source: 'checkin', classifications: checkinClassifications, relations: checkinRelations, marks: checkinMarks },
    { source: 'global-catalog', classifications: catalogClassifications, relations: catalogRelations, marks: catalogMarks },
    { source: 'catalog-synthetic', classifications: catalogSyntheticClassifications, relations: catalogSyntheticRelations, marks: catalogSyntheticMarks },
    { source: 'inventory', classifications: inventoryGenerated.classifications, relations: inventoryGenerated.relations, marks: inventoryGenerated.marks },
    { source: 'inventory-synthetic', classifications: inventorySynthetic.classifications, relations: inventorySynthetic.relations, marks: inventorySynthetic.marks },
    { source: 'expense', classifications: expenseGenerated.classifications, relations: expenseGenerated.relations, marks: expenseGenerated.marks },
    { source: 'expense-synthetic', classifications: expenseSynthetic.classifications, relations: expenseSynthetic.relations, marks: expenseSynthetic.marks },
    { source: 'income', classifications: incomeGenerated.classifications, relations: incomeGenerated.relations, marks: incomeGenerated.marks },
    { source: 'income-synthetic', classifications: incomeSynthetic.classifications, relations: incomeSynthetic.relations, marks: incomeSynthetic.marks },
    { source: 'donation', classifications: donationGenerated.classifications, relations: donationGenerated.relations, marks: donationGenerated.marks },
    { source: 'donation-synthetic', classifications: donationSynthetic.classifications, relations: donationSynthetic.relations, marks: donationSynthetic.marks },
    { source: 'workflow', classifications: workflowGenerated.classifications, relations: workflowGenerated.relations, marks: workflowGenerated.marks },
    { source: 'workflow-synthetic', classifications: workflowSynthetic.classifications, relations: workflowSynthetic.relations, marks: workflowSynthetic.marks },
    { source: 'receipt', classifications: receiptGenerated.classifications, relations: receiptGenerated.relations, marks: receiptGenerated.marks },
    { source: 'receipt-synthetic', classifications: receiptSynthetic.classifications, relations: receiptSynthetic.relations, marks: receiptSynthetic.marks },
    { source: 'program-synthetic', classifications: programSynthetic.classifications, relations: programSynthetic.relations, marks: programSynthetic.marks },
    { source: 'budget-owner-synthetic', classifications: budgetOwnerSynthetic.classifications, relations: budgetOwnerSynthetic.relations, marks: budgetOwnerSynthetic.marks },
    { source: 'key-volunteer-synthetic', classifications: keyVolunteerSynthetic.classifications, relations: keyVolunteerSynthetic.relations, marks: keyVolunteerSynthetic.marks },
    { source: 'check-started-synthetic', classifications: checkStartedSynthetic.classifications, relations: checkStartedSynthetic.relations, marks: checkStartedSynthetic.marks },
    { source: 'volunteer-roster-synthetic', classifications: volunteerRosterSynthetic.classifications, relations: volunteerRosterSynthetic.relations, marks: volunteerRosterSynthetic.marks },
    { source: 'household-synthetic', classifications: householdSynthetic.classifications, relations: householdSynthetic.relations, marks: householdSynthetic.marks },
    { source: 'problems-synthetic', classifications: problemsSynthetic.classifications, relations: problemsSynthetic.relations, marks: problemsSynthetic.marks },
    { source: 'membership-application-synthetic', classifications: membershipApplicationSynthetic.classifications, relations: membershipApplicationSynthetic.relations, marks: membershipApplicationSynthetic.marks },
    { source: 'facility-safety-synthetic', classifications: facilitySafetySynthetic.classifications, relations: facilitySafetySynthetic.relations, marks: facilitySafetySynthetic.marks },
    { source: 'membership-audit-synthetic', classifications: membershipAuditSynthetic.classifications, relations: membershipAuditSynthetic.relations, marks: membershipAuditSynthetic.marks },
    { source: 'shopify-read', classifications: shopifyReadGenerated.classifications, relations: shopifyReadGenerated.relations, marks: shopifyReadGenerated.marks },
    { source: 'shopify-read-synthetic', classifications: shopifyReadSynthetic.classifications, relations: shopifyReadSynthetic.relations, marks: shopifyReadSynthetic.marks },
] as const;

type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];
type MergeSources<S extends readonly ClassificationSource[], K extends 'classifications' | 'relations'> =
    S extends readonly [infer Head extends ClassificationSource, ...infer Rest extends readonly ClassificationSource[]]
        ? Head[K] & MergeSources<Rest, K>
        : unknown;

function mergeSources(key: 'classifications' | 'relations' | 'marks'): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const s of CLASSIFICATION_SOURCES) Object.assign(merged, s[key]);
    return merged;
}

export const classifications = mergeSources('classifications') as MergeSources<typeof CLASSIFICATION_SOURCES, 'classifications'>;
export const relations = mergeSources('relations') as MergeSources<typeof CLASSIFICATION_SOURCES, 'relations'>;
/** Finance marks per model: a response carrying one of these fields is a logged finance view. */
export const marks = mergeSources('marks') as Readonly<Record<string, readonly string[]>>;
