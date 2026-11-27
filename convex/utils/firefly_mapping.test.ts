import { describe, it, expect } from 'vitest';

import {
  normalizeAssetAccounts,
  normalizeLiabilityAccounts,
  aggregateCategorySpend,
  parseRepoRate,
  effectiveApr,
  defaultLoanRateRule,
  buildFinanceEntries,
  buildPlanSeed,
  defaultPlanSeedOptions,
  monthlyEmi,
  financeIdForAsset,
  financeIdForLiability,
  type FireflyAccount,
  type FireflySnapshot,
  type FireflySettings,
} from './firefly_mapping';

const account = (id: string, attributes: Partial<FireflyAccount['attributes']>): FireflyAccount => ({
  id,
  attributes: { name: `Account ${id}`, type: 'asset', active: true, current_balance: '0', currency_code: 'INR', ...attributes },
});

const NOW = Date.UTC(2026, 10, 27); // 27 Nov 2026

const snapshot: FireflySnapshot = {
  baseUrl: 'http://firefly.test',
  fetchedAt: NOW,
  repoRate: { value: 5.5, asOf: NOW, live: true },
  periodStart: '2025-11-01',
  periodEnd: '2026-10-31',
  assets: [
    { fireflyId: '1', name: 'Primary Bank', balance: 1500000.25, role: 'defaultAsset', currency: 'INR' },
    { fireflyId: '15', name: 'TDS Receivable', balance: 12000, role: 'defaultAsset', currency: 'INR' },
  ],
  liabilities: [
    {
      fireflyId: '14',
      name: 'Education Loan A',
      balance: 2000000,
      fireflyApr: null,
      liabilityType: 'loan',
      directionMismatch: true,
      currency: 'INR',
    },
    {
      fireflyId: '26',
      name: 'Education Loan B',
      balance: 2400000,
      fireflyApr: 7.6,
      liabilityType: 'loan',
      directionMismatch: true,
      currency: 'INR',
    },
  ],
  categories: [
    { name: 'Loan Interest', total: 240000, monthlyAverage: 20000 },
    { name: 'Food & Dining', total: 96000, monthlyAverage: 8000 },
    { name: 'Travel & Commute', total: 70, monthlyAverage: 6 },
  ],
  warnings: [],
};

const emptySettings: FireflySettings = { excludedIds: [], balanceOverrides: {}, loanRates: {}, autoSync: false };

describe('normalizeAssetAccounts', () => {
  it('keeps active accounts with numeric balances and their role', () => {
    const result = normalizeAssetAccounts([
      account('1', { name: 'Primary Bank', current_balance: '1500000.25', account_role: 'defaultAsset' }),
      account('2', { name: 'Old', active: false, current_balance: '10' }),
    ]);
    expect(result.accounts).toEqual([{ fireflyId: '1', name: 'Primary Bank', balance: 1500000.25, role: 'defaultAsset', currency: 'INR' }]);
  });

  it('warns about non-INR accounts and leaves them out', () => {
    const result = normalizeAssetAccounts([account('3', { name: 'Wise USD', currency_code: 'USD', current_balance: '100' })]);
    expect(result.accounts).toHaveLength(0);
    expect(result.warnings[0]).toMatch(/Wise USD.*USD/);
  });
});

describe('normalizeLiabilityAccounts', () => {
  it('uses the owed amount as a positive balance and converts the interest period to a yearly rate', () => {
    const result = normalizeLiabilityAccounts([
      account('26', {
        name: 'Education Loan B',
        type: 'liabilities',
        current_balance: '-2400000',
        liability_type: 'loan',
        liability_direction: 'debit',
        interest: '7.6',
        interest_period: 'yearly',
      }),
      account('27', { name: 'Card', type: 'liabilities', current_balance: '-1000', interest: '3', interest_period: 'monthly' }),
    ]);
    expect(result.accounts[0]).toMatchObject({ fireflyId: '26', balance: 2400000, fireflyApr: 7.6, directionMismatch: false });
    expect(result.accounts[1].fireflyApr).toBe(36);
  });

  it('flags a loan recorded as "I am owed this debt" but still treats it as owed', () => {
    const result = normalizeLiabilityAccounts([
      account('14', { name: 'Education Loan A', type: 'liabilities', current_balance: '-2000000', liability_direction: 'credit' }),
    ]);
    expect(result.accounts[0]).toMatchObject({ balance: 2000000, fireflyApr: null, directionMismatch: true });
    expect(result.warnings[0]).toMatch(/Education Loan A/);
  });
});

describe('aggregateCategorySpend', () => {
  it('turns Firefly expense insight into positive totals and monthly averages, largest first', () => {
    const result = aggregateCategorySpend(
      [
        { name: 'Food & Dining', difference_float: -96000, currency_code: 'INR' },
        { name: 'Loan Interest', difference_float: -240000, currency_code: 'INR' },
        { name: 'Ignored', difference_float: -50, currency_code: 'USD' },
      ],
      { difference_float: -1200, currency_code: 'INR' },
      12
    );
    expect(result).toEqual([
      { name: 'Loan Interest', total: 240000, monthlyAverage: 20000 },
      { name: 'Food & Dining', total: 96000, monthlyAverage: 8000 },
      { name: 'Uncategorised', total: 1200, monthlyAverage: 100 },
    ]);
  });
});

describe('parseRepoRate', () => {
  it('reads the policy repo rate from the RBI homepage HTML', () => {
    const html = '<td>Policy Repo Rate</td><td> : </td><td>5.50%</td><td>Standing Deposit Facility Rate : 5.25%</td>';
    expect(parseRepoRate(html)).toBe(5.5);
  });

  it('returns null when the rate is missing or implausible', () => {
    expect(parseRepoRate('<html>maintenance</html>')).toBeNull();
    expect(parseRepoRate('Policy Repo Rate : 55.0%')).toBeNull();
  });
});

describe('loan rates', () => {
  it('derives a repo-linked spread from the Firefly rate', () => {
    expect(defaultLoanRateRule(7.6, 5.5)).toEqual({ mode: 'repoLinked', spread: 2.1 });
    expect(defaultLoanRateRule(null, 5.5)).toBeUndefined();
    expect(defaultLoanRateRule(7.6, null)).toEqual({ mode: 'fixed', apr: 7.6 });
  });

  it('moves a repo-linked loan with the repo rate and leaves a fixed loan alone', () => {
    expect(effectiveApr({ mode: 'repoLinked', spread: 2.1 }, 7.6, 5.75)).toBeCloseTo(7.85, 10);
    expect(effectiveApr({ mode: 'fixed', apr: 9 }, 7.6, 5.75)).toBe(9);
    expect(effectiveApr(undefined, 7.6, 5.75)).toBe(7.6);
    expect(effectiveApr(undefined, null, 5.75)).toBeUndefined();
    // No repo rate known: fall back to the Firefly rate
    expect(effectiveApr({ mode: 'repoLinked', spread: 1.5 }, null, null)).toBeUndefined();
  });
});

describe('buildFinanceEntries', () => {
  it('maps accounts to NW Tracker entries with stable ids, overrides and exclusions', () => {
    const settings: FireflySettings = {
      ...emptySettings,
      excludedIds: [financeIdForAsset('15')],
      balanceOverrides: { [financeIdForAsset('1')]: 40000 },
      loanRates: { [financeIdForLiability('14')]: { mode: 'repoLinked', spread: 1.5 } },
    };
    const { assets, liabilities } = buildFinanceEntries(snapshot, settings, NOW);

    expect(assets).toEqual([
      {
        id: 'firefly-asset-1',
        name: 'Primary Bank',
        value: 40000,
        updatedAt: NOW,
        url: 'http://firefly.test/accounts/show/1',
        type: 'checking',
      },
    ]);
    expect(liabilities).toHaveLength(2);
    expect(liabilities[0]).toMatchObject({ id: 'firefly-liability-14', balance: 2000000, type: 'studentLoan', apr: 7 });
    // Loan B has no saved rule yet: default spread from its Firefly rate keeps 7.6 at today's repo
    expect(liabilities[1]).toMatchObject({ id: 'firefly-liability-26', apr: 7.6 });
  });
});

describe('monthlyEmi', () => {
  it('matches the standard reducing-balance EMI formula', () => {
    // 10 lakh at 7.6% over 120 months: r = 0.076/12, (1+r)^120 = 2.1331, EMI = 11,922.4
    expect(monthlyEmi(1000000, 7.6, 120)).toBeCloseTo(11922.4, 0);
    expect(monthlyEmi(120000, 0, 12)).toBe(10000);
  });
});

describe('buildPlanSeed', () => {
  it('seeds accounts, repo-linked debts, moratorium interest and spending, without double-counting loan interest', () => {
    const settings: FireflySettings = {
      ...emptySettings,
      balanceOverrides: { [financeIdForAsset('1')]: 40000 },
      excludedIds: [financeIdForAsset('15')],
      loanRates: { [financeIdForLiability('14')]: { mode: 'repoLinked', spread: 1.5 } },
    };
    const options = defaultPlanSeedOptions(snapshot, settings, NOW);
    expect(options.loans[financeIdForLiability('14')].emiStart).toEqual({ month: 11, year: 2027 });
    expect(options.expenses.find((e) => e.name === 'Loan Interest')?.include).toBe(false);

    const seed = buildPlanSeed(snapshot, settings, options, new Set([financeIdForAsset('1')]));

    expect(seed.accounts).toEqual([
      { id: 'firefly-1', name: 'Primary Bank', balance: 40000, type: 'savings', syncedFinanceId: 'firefly-asset-1' },
    ]);

    const ubi = seed.debts.find((d) => d.id === 'firefly-14')!;
    expect(ubi).toMatchObject({
      apr: 7,
      balance: 2000000,
      interestType: 'compound',
      compoundingFrequency: 'monthly',
      startDate: { type: 'customDate', month: 11, year: 2027 },
    });
    expect(ubi.syncedFinanceId).toBeUndefined();
    expect(ubi.monthlyPayment).toBeCloseTo(monthlyEmi(2000000, 7, 120), 0);

    const interestExpense = seed.expenses.find((e) => e.id === 'firefly-interest-14')!;
    expect(interestExpense).toMatchObject({
      frequency: 'monthly',
      timeframe: { start: { type: 'now' }, end: { type: 'customDate', month: 10, year: 2027 } },
    });
    expect(interestExpense.amount).toBeCloseTo((2000000 * 0.07) / 12, 0);

    expect(seed.expenses.find((e) => e.name.startsWith('Loan Interest'))).toBeUndefined();
    expect(seed.expenses.find((e) => e.name.startsWith('Food & Dining'))).toMatchObject({ amount: 8000, frequency: 'monthly' });
    // Tiny categories under Rs 100 a month are left out by default
    expect(seed.expenses.find((e) => e.name.startsWith('Travel'))).toBeUndefined();
  });
});
