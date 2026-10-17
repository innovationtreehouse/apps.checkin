import { it, expect, beforeEach } from 'vitest';
import { describeDb } from "../helpers/db";
import { db } from '../../db';
import { determineAccountsFromMap } from '../../lib/account-map-lookup';
import { makeAccountMapRule, TEST_ORG_ID } from '../helpers/factories';

type TxFields = {
  companyName: string | null;
  corporatePeerCampaign: string | null;
  donationMethod: string | null;
  donationType: string | null;
};

// Loads org-scoped rules from the DB then applies the matcher — mirrors how
// runAccountDetermination resolves accounts in production (org filtering is in
// the query, matching is in determineAccountsFromMap).
async function determineAccounts(orgId: string, tx: TxFields) {
  const rules = await db.accountMap.findMany({ where: { orgId } });
  return determineAccountsFromMap(rules, tx);
}

let orgId: string;

beforeEach(async () => {
  await db.accountMap.deleteMany({});
  orgId = TEST_ORG_ID;
});

// ── Successful single match ────────────────────────────────────────────────────

describeDb('exact match', () => {
  it('returns accounts when all fields match exactly', async () => {
    await makeAccountMapRule(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: 'Campaign A',
      donationMethod: 'check',
      donationType: 'standard',
      donationAccount: '4000',
      matchAccount: '4001',
      feesAccount: '6000',
    });

    const result = await determineAccounts(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: 'Campaign A',
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('result' in result).toBe(true);
    if ('result' in result) {
      expect(result.result.donationAccount).toBe('4000');
      expect(result.result.matchAccount).toBe('4001');
      expect(result.result.feesAccount).toBe('6000');
    }
  });
});

// ── Wildcard matching ─────────────────────────────────────────────────────────

describeDb('companyName wildcard', () => {
  it('* matches any companyName including null', async () => {
    await makeAccountMapRule(orgId, { companyName: '*', corporatePeerCampaign: '*' });

    const result = await determineAccounts(orgId, {
      companyName: 'Any Company At All',
      corporatePeerCampaign: null,
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('result' in result).toBe(true);
  });

  it('exact companyName does not match a different company', async () => {
    await makeAccountMapRule(orgId, { companyName: 'Acme', corporatePeerCampaign: '*' });

    const result = await determineAccounts(orgId, {
      companyName: 'Other Corp',
      corporatePeerCampaign: null,
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict.reason).toBe('NO_MATCH');
    }
  });
});

describeDb('corporatePeerCampaign wildcard', () => {
  it('* matches any campaign value', async () => {
    await makeAccountMapRule(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: '*',
      donationMethod: 'check',
      donationType: 'standard',
    });

    const result = await determineAccounts(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: 'Spring Drive 2025',
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('result' in result).toBe(true);
  });
});

// ── donationMethod / donationType have no wildcard support ────────────────────

describeDb('donationMethod exact-only matching', () => {
  it('does not match when donationMethod differs', async () => {
    await makeAccountMapRule(orgId, {
      companyName: '*',
      corporatePeerCampaign: '*',
      donationMethod: 'check',
      donationType: 'standard',
    });

    const result = await determineAccounts(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: null,
      donationMethod: 'wire',
      donationType: 'standard',
    });

    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict.reason).toBe('NO_MATCH');
    }
  });

  it('matches null donationMethod only when rule also has null', async () => {
    await makeAccountMapRule(orgId, {
      companyName: '*',
      corporatePeerCampaign: '*',
      donationMethod: null,
      donationType: null,
    });

    const match = await determineAccounts(orgId, {
      companyName: 'X',
      corporatePeerCampaign: null,
      donationMethod: null,
      donationType: null,
    });
    expect('result' in match).toBe(true);

    const mismatch = await determineAccounts(orgId, {
      companyName: 'X',
      corporatePeerCampaign: null,
      donationMethod: 'check',
      donationType: null,
    });
    expect('conflict' in mismatch).toBe(true);
  });
});

// ── Conflict: no match ─────────────────────────────────────────────────────────

describeDb('NO_MATCH conflict', () => {
  it('reports NO_MATCH when no rules exist for the org', async () => {
    const result = await determineAccounts(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: null,
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict.reason).toBe('NO_MATCH');
      expect(result.conflict.matchedRows).toHaveLength(0);
    }
  });

  it('does not leak rules from other orgs', async () => {
    const otherOrgId = "00000000-0000-0000-0000-000000000002";
    await makeAccountMapRule(otherOrgId, {
      companyName: '*',
      corporatePeerCampaign: '*',
      donationMethod: 'check',
      donationType: 'standard',
    });

    const result = await determineAccounts(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: null,
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict.reason).toBe('NO_MATCH');
    }
  });
});

// ── Conflict: multiple matches ─────────────────────────────────────────────────

describeDb('MULTIPLE_MATCHES conflict', () => {
  it('reports MULTIPLE_MATCHES when two rules both match the transaction', async () => {
    await makeAccountMapRule(orgId, { companyName: '*', corporatePeerCampaign: '*', donationAccount: '4000' });
    await makeAccountMapRule(orgId, { companyName: 'Acme', corporatePeerCampaign: '*', donationAccount: '4099' });

    const result = await determineAccounts(orgId, {
      companyName: 'Acme',
      corporatePeerCampaign: null,
      donationMethod: 'check',
      donationType: 'standard',
    });

    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict.reason).toBe('MULTIPLE_MATCHES');
      expect(result.conflict.matchedRows).toHaveLength(2);
    }
  });
});
