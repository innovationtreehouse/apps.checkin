import { describe, it, expect } from 'vitest';
import { parseBenevityCsv, CsvValidationError } from '../../lib/csv-parser';

function makeRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'Nonprofit Name': 'Test Nonprofit',
    'Nonprofit ID': 'NP-001',
    'Disbursement ID': 'DISB-001',
    'Disbursement Date': '2025-01-15',
    'Bank Date': '2025-01-20',
    'Bank Reference ID': 'REF-001',
    'Payment Method': 'EFT',
    'Disbursement From (Grantor)': 'Benevity',
    'Company Name': 'Acme Corp',
    'Corporate / Peer Campaign': 'Campaign A',
    'Project Name': '',
    'Project ID': '',
    'Transaction ID': 'TXN-001',
    'Donation Date': '2025-01-10',
    'Donation Amount': '100.00',
    'Match Amount': '50.00',
    'Donation Currency': 'USD',
    'Foreign Exchange Rate': '',
    'Cause Support Fee': '2.50',
    'Merchant Fee': '1.00',
    'Check Fee': '0.00',
    'Donation Frequency': 'one-time',
    'Donation Method': 'check',
    'Donation Type': 'standard',
    'Donor First Name': 'Jane',
    'Donor Last Name': 'Doe',
    'Donor Comment': 'For operations',
    ...overrides,
  };
}

function toCsv(rows: Record<string, string>[]): Buffer {
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => r[h] ?? '').join(',')),
  ];
  return Buffer.from(lines.join('\n'));
}

describe('parseBenevityCsv', () => {
  it('parses a well-formed row', () => {
    const result = parseBenevityCsv(toCsv([makeRow()]));
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe('TXN-001');
    expect(result[0].nonprofitName).toBe('Test Nonprofit');
    expect(result[0].companyName).toBe('Acme Corp');
  });

  it('parses numeric money fields as integer cents', () => {
    const result = parseBenevityCsv(toCsv([makeRow()]));
    expect(result[0].donationAmountCents).toBe(10000);
    expect(result[0].matchAmountCents).toBe(5000);
    expect(result[0].causeSupportFeeCents).toBe(250);
    expect(result[0].merchantFeeCents).toBe(100);
    expect(result[0].checkFeeCents).toBe(0);
  });

  it('treats empty numeric fields as 0 cents', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Donation Amount': '', 'Match Amount': '  ' })]));
    expect(result[0].donationAmountCents).toBe(0);
    expect(result[0].matchAmountCents).toBe(0);
  });

  it('throws CsvValidationError on non-numeric money values rather than silently zeroing', () => {
    expect(() => parseBenevityCsv(toCsv([makeRow({ 'Donation Amount': 'N/A', 'Check Fee': 'bad' })])))
      .toThrow(CsvValidationError);
  });

  it('reports the offending transaction and field in the validation error', () => {
    try {
      parseBenevityCsv(toCsv([makeRow({ 'Transaction ID': 'TXN-BAD', 'Donation Amount': 'oops' })]));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CsvValidationError);
      const issues = (err as CsvValidationError).issues.join(' ');
      expect(issues).toContain('TXN-BAD');
      expect(issues).toContain('donationAmountCents');
    }
  });

  it('parses foreignExchangeRate as null when empty', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Foreign Exchange Rate': '' })]));
    expect(result[0].foreignExchangeRate).toBeNull();
  });

  it('parses foreignExchangeRate as number when present', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Foreign Exchange Rate': '1.23' })]));
    expect(result[0].foreignExchangeRate).toBe(1.23);
  });

  it('defaults currency to USD when column is absent', () => {
    const row = makeRow();
    delete (row as Record<string, string>)['Donation Currency'];
    const result = parseBenevityCsv(toCsv([row]));
    expect(result[0].currency).toBe('USD');
  });

  it('filters out rows with empty transactionId', () => {
    const valid = makeRow({ 'Transaction ID': 'TXN-VALID' });
    const empty = makeRow({ 'Transaction ID': '' });
    const result = parseBenevityCsv(toCsv([valid, empty]));
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe('TXN-VALID');
  });

  it('returns empty array for CSV with only headers', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Transaction ID': '' })]));
    expect(result).toHaveLength(0);
  });

  it('parses multiple rows', () => {
    const rows = [
      makeRow({ 'Transaction ID': 'TXN-1' }),
      makeRow({ 'Transaction ID': 'TXN-2' }),
      makeRow({ 'Transaction ID': 'TXN-3' }),
    ];
    const result = parseBenevityCsv(toCsv(rows));
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.transactionId)).toEqual(['TXN-1', 'TXN-2', 'TXN-3']);
  });

  it('maps Disbursement From (Grantor) to disbursementFrom', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Disbursement From (Grantor)': 'Fidelity' })]));
    expect(result[0].disbursementFrom).toBe('Fidelity');
  });

  it('maps Corporate / Peer Campaign to corporatePeerCampaign', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Corporate / Peer Campaign': 'Spring Drive' })]));
    expect(result[0].corporatePeerCampaign).toBe('Spring Drive');
  });

  it('trims whitespace from string fields', () => {
    const result = parseBenevityCsv(toCsv([makeRow({ 'Company Name': '  Acme  ' })]));
    expect(result[0].companyName).toBe('Acme');
  });

  it('strips UTF-8 BOM prefix that Excel adds to CSV exports', () => {
    // Excel writes a BOM (﻿) before the first header, which would otherwise
    // corrupt the column name and cause silent mapping failures.
    const rows = [makeRow()];
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => r[h] ?? '').join(','))];
    const csvWithBom = Buffer.from('﻿' + lines.join('\n'), 'utf8');
    const result = parseBenevityCsv(csvWithBom);
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe('TXN-001');
  });

  it('documents that missing Transaction ID column silently produces empty result', () => {
    // Missing header → all rows map to transactionId="" and are filtered.
    // This test pins the current behaviour so a future stricter fix can be
    // validated against it.
    const rows = [makeRow()];
    const headers = Object.keys(rows[0]).filter((h) => h !== 'Transaction ID');
    const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => r[h] ?? '').join(','))];
    const result = parseBenevityCsv(Buffer.from(lines.join('\n')));
    expect(result).toHaveLength(0);
  });

  it('collects validation issues from multiple bad rows before throwing', () => {
    const bad1 = makeRow({ 'Transaction ID': 'TXN-BAD1', 'Donation Amount': 'X' });
    const bad2 = makeRow({ 'Transaction ID': 'TXN-BAD2', 'Match Amount': 'Y' });
    try {
      parseBenevityCsv(toCsv([bad1, bad2]));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CsvValidationError);
      const issues = (err as CsvValidationError).issues.join(' ');
      expect(issues).toContain('TXN-BAD1');
      expect(issues).toContain('TXN-BAD2');
    }
  });

  it('handles non-ASCII donor names without error', () => {
    const result = parseBenevityCsv(toCsv([makeRow({
      'Donor First Name': 'Ångström',
      'Donor Last Name': '山田',
    })]));
    expect(result[0].donorFirstName).toBe('Ångström');
    expect(result[0].donorLastName).toBe('山田');
  });
});

describe('date normalisation', () => {
  const HEADER = 'Transaction ID,Disbursement Date,Bank Date,Donation Date';
  const parse = (row: string) => parseBenevityCsv(Buffer.from(`${HEADER}\n${row}`));

  it('keeps ISO dates, drops a time part, and leaves blanks empty', () => {
    const [row] = parse('T1,2025-09-01,2025-09-03T14:05:00Z,');
    expect(row.disbursementDate).toBe('2025-09-01');
    expect(row.bankDate).toBe('2025-09-03');
    expect(row.donationDate).toBe('');
  });

  it('fails the file on a non-ISO or impossible date', () => {
    expect(() => parse('T1,9/1/2025,,')).toThrow(CsvValidationError);
    expect(() => parse('T1,2025-02-30,,')).toThrow(CsvValidationError);
  });
});

