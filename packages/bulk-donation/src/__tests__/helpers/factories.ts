import { db } from '../../db';
import { configureBulkDonation } from '../../runtime';
import type { OwnerInfo } from '../../contract';

export const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001";

let seq = 0;
function uid(): string {
  return `test-${Date.now()}-${++seq}`;
}

export async function makeFile(orgId: string = TEST_ORG_ID) {
  return db.uploadedFile.create({
    data: {
      orgId,
      uploadedByUserId: 1,
      originalFilename: 'test.csv',
      fileHash: uid(),
      rowCount: 0,
      newRowCount: 0,
      duplicateRowCount: 0,
      allDuplicate: false,
      blobDeleted: false,
    },
  });
}

type TxOverrides = {
  disbursementId?: string;
  disbursementDate?: string;
  disbursementFrom?: string;
  companyName?: string | null;
  corporatePeerCampaign?: string | null;
  donationMethod?: string | null;
  donationType?: string | null;
  donationAmountCents?: number;
  matchAmountCents?: number;
  causeSupportFeeCents?: number;
  merchantFeeCents?: number;
  checkFeeCents?: number;
  ownerId?: number | null;
  isOrganizationalLevel?: boolean;
  projectName?: string | null;
};

export async function makeTransaction(orgId: string = TEST_ORG_ID, fileId: number, overrides: TxOverrides = {}) {
  return db.transaction.create({
    data: {
      orgId,
      uploadedFileId: fileId,
      transactionId: uid(),
      disbursementId: overrides.disbursementId ?? `disb-${uid()}`,
      disbursementDate: overrides.disbursementDate ?? '2025-01-15',
      disbursementFrom: overrides.disbursementFrom ?? 'Benevity',
      companyName: overrides.companyName ?? 'Acme Corp',
      corporatePeerCampaign: overrides.corporatePeerCampaign ?? null,
      donationMethod: overrides.donationMethod ?? 'check',
      donationType: overrides.donationType ?? 'standard',
      donationAmountCents: overrides.donationAmountCents ?? 100,
      matchAmountCents: overrides.matchAmountCents ?? 0,
      causeSupportFeeCents: overrides.causeSupportFeeCents ?? 0,
      merchantFeeCents: overrides.merchantFeeCents ?? 0,
      checkFeeCents: overrides.checkFeeCents ?? 0,
      projectName: overrides.projectName ?? null,
      ownerId: 'ownerId' in overrides ? overrides.ownerId ?? null : 1,
      isOrganizationalLevel: overrides.isOrganizationalLevel ?? false,
    },
  });
}

type RuleOverrides = {
  companyName?: string;
  corporatePeerCampaign?: string;
  donationMethod?: string | null;
  donationType?: string | null;
  donationAccount?: string;
  matchAccount?: string;
  feesAccount?: string;
};

export async function makeAccountMapRule(orgId: string = TEST_ORG_ID, overrides: RuleOverrides = {}) {
  return db.accountMap.create({
    data: {
      orgId,
      companyName: overrides.companyName ?? 'Acme Corp',
      corporatePeerCampaign: overrides.corporatePeerCampaign ?? '*',
      donationMethod: 'donationMethod' in overrides ? overrides.donationMethod ?? null : 'check',
      donationType: 'donationType' in overrides ? overrides.donationType ?? null : 'standard',
      donationAccount: overrides.donationAccount ?? '4000-Donations',
      matchAccount: overrides.matchAccount ?? '4001-Match',
      feesAccount: overrides.feesAccount ?? '6000-Fees',
    },
  });
}

export async function makeHold(orgId: string = TEST_ORG_ID, txId: number, disbursementId: string, overrides: {
  reason?: 'NO_MATCH' | 'MULTIPLE_MATCHES';
  status?: 'PENDING' | 'RESOLVED';
} = {}) {
  return db.disbursementHold.create({
    data: {
      orgId,
      disbursementId,
      transactionId: txId,
      reason: overrides.reason ?? 'NO_MATCH',
      matchedRows: '[]',
      status: overrides.status ?? 'PENDING',
    },
  });
}

export async function makeEvent(orgId: string = TEST_ORG_ID, disbursementId: string) {
  return db.disbursementEvent.create({
    data: {
      orgId,
      disbursementId,
      payload: JSON.stringify({ id: disbursementId, items: [] }),
    },
  });
}

export const TEST_OWNERS: OwnerInfo[] = [
  ...[1, 9, 201, 202, 203, 204, 205, 206].map((id) => ({ id, name: `Bucket ${id}`, archivedAt: null })),
  { id: 99, name: 'Archived bucket', archivedAt: new Date('2026-01-01T00:00:00Z') },
];

/** Bind the runtime the way checkin does at boot, with a fixed owner directory. */
export function configureTestRuntime(): void {
  configureBulkDonation({
    auth: { getPrincipal: async () => ({ id: 1, name: 'testfinance' }) },
    org: () => ({ id: TEST_ORG_ID, name: 'Test Org' }),
    owners: { list: async () => TEST_OWNERS },
  });
}
