/**
 * Firefly III connector: pure mapping, no I/O.
 *
 * Turns a Firefly III snapshot (asset accounts, liabilities, twelve months of
 * spending by category) into NW Tracker entries and a seed for a new plan.
 * Loans can follow the RBI repo rate: the rate is stored as repo + spread, so a
 * repo change moves every linked loan on the next sync.
 *
 * Shared by the Convex actions (convex/firefly.ts) and the dashboard dialogs.
 */

import type { Infer } from 'convex/values';

import type { accountValidator } from '../validators/accounts_validator';
import type { debtValidator } from '../validators/debt_validator';
import type { expenseValidator } from '../validators/expenses_validator';
import type { assetValidator } from '../validators/asset_validator';
import type { liabilityValidator } from '../validators/liability_validator';

// ---------------------------------------------------------------------------
// Firefly III API shapes (v6, AccountTransformer and Insight\Expense\CategoryController)
// ---------------------------------------------------------------------------

export interface FireflyAccount {
  id: string;
  attributes: {
    name: string;
    type: string;
    active?: boolean;
    account_role?: string | null;
    current_balance: string;
    currency_code?: string | null;
    liability_type?: string | null;
    liability_direction?: string | null;
    interest?: string | null;
    interest_period?: string | null;
  };
}

export interface FireflyCategorySpend {
  id?: string;
  name?: string;
  difference_float: number;
  currency_code: string;
}

// ---------------------------------------------------------------------------
// Normalised snapshot
// ---------------------------------------------------------------------------

export interface SnapshotAsset {
  fireflyId: string;
  name: string;
  balance: number;
  role: string | null;
  currency: string;
}

export interface SnapshotLiability {
  fireflyId: string;
  name: string;
  /** Amount owed, always positive */
  balance: number;
  /** Yearly rate recorded in Firefly, if any */
  fireflyApr: number | null;
  liabilityType: string | null;
  /** Firefly says "I am owed this debt"; we still treat it as owed and warn */
  directionMismatch: boolean;
  currency: string;
}

export interface CategorySpend {
  name: string;
  total: number;
  monthlyAverage: number;
}

export interface RepoRate {
  value: number;
  asOf: number;
  /** false when RBI could not be reached and the last known rate was reused */
  live: boolean;
}

export interface FireflySnapshot {
  baseUrl: string;
  fetchedAt: number;
  repoRate: RepoRate | null;
  periodStart: string;
  periodEnd: string;
  assets: SnapshotAsset[];
  liabilities: SnapshotLiability[];
  categories: CategorySpend[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Settings saved per user (finances.firefly)
// ---------------------------------------------------------------------------

export type LoanRateRule = { mode: 'repoLinked'; spread: number } | { mode: 'fixed'; apr: number };

export interface FireflySettings {
  /** NW Tracker ids (firefly-asset-N / firefly-liability-N) to leave out */
  excludedIds: string[];
  /** NW Tracker id -> balance to use instead of Firefly's */
  balanceOverrides: Record<string, number>;
  /** NW Tracker liability id -> rate rule */
  loanRates: Record<string, LoanRateRule>;
  autoSync: boolean;
  repoRate?: { value: number; asOf: number };
  lastSyncedAt?: number;
}

export const EMPTY_FIREFLY_SETTINGS: FireflySettings = { excludedIds: [], balanceOverrides: {}, loanRates: {}, autoSync: false };

export const financeIdForAsset = (fireflyId: string) => `firefly-asset-${fireflyId}`;
export const financeIdForLiability = (fireflyId: string) => `firefly-liability-${fireflyId}`;
export const isFireflyFinanceId = (id: string) => id.startsWith('firefly-asset-') || id.startsWith('firefly-liability-');

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalizeAssetAccounts(accounts: FireflyAccount[]): { accounts: SnapshotAsset[]; warnings: string[] } {
  const warnings: string[] = [];
  const result: SnapshotAsset[] = [];

  for (const { id, attributes: a } of accounts) {
    if (a.active === false) continue;
    const currency = a.currency_code ?? 'INR';
    if (currency !== 'INR') {
      warnings.push(`${a.name} is in ${currency}; only INR accounts are imported.`);
      continue;
    }
    const balance = parseFloat(a.current_balance);
    if (!Number.isFinite(balance)) continue;
    result.push({ fireflyId: id, name: a.name, balance, role: a.account_role ?? null, currency });
  }

  return { accounts: result, warnings };
}

function yearlyRate(interest: string | null | undefined, period: string | null | undefined): number | null {
  if (interest === null || interest === undefined || interest === '') return null;
  const rate = parseFloat(interest);
  if (!Number.isFinite(rate)) return null;
  switch (period) {
    case 'monthly':
      return round2(rate * 12);
    case 'daily':
      return round2(rate * 365);
    default:
      return rate;
  }
}

export function normalizeLiabilityAccounts(accounts: FireflyAccount[]): { accounts: SnapshotLiability[]; warnings: string[] } {
  const warnings: string[] = [];
  const result: SnapshotLiability[] = [];

  for (const { id, attributes: a } of accounts) {
    if (a.active === false) continue;
    const currency = a.currency_code ?? 'INR';
    if (currency !== 'INR') {
      warnings.push(`${a.name} is in ${currency}; only INR accounts are imported.`);
      continue;
    }
    const raw = parseFloat(a.current_balance);
    if (!Number.isFinite(raw)) continue;

    const directionMismatch = a.liability_direction === 'credit';
    if (directionMismatch) {
      warnings.push(
        `${a.name} is marked "I am owed this debt" in Firefly. It is imported as a debt you owe; fix the direction in Firefly.`
      );
    }

    result.push({
      fireflyId: id,
      name: a.name,
      balance: Math.abs(raw),
      fireflyApr: yearlyRate(a.interest, a.interest_period),
      liabilityType: a.liability_type ?? null,
      directionMismatch,
      currency,
    });
  }

  return { accounts: result, warnings };
}

/** Firefly reports expenses as negative differences. Returns positive totals, largest first. */
export function aggregateCategorySpend(
  categories: FireflyCategorySpend[],
  uncategorised: Pick<FireflyCategorySpend, 'difference_float' | 'currency_code'> | null,
  months: number
): CategorySpend[] {
  const totals = new Map<string, number>();
  const add = (name: string, diff: number, currency: string) => {
    if (currency !== 'INR' || !(diff < 0)) return;
    totals.set(name, (totals.get(name) ?? 0) - diff);
  };

  for (const c of categories) add(c.name ?? 'Unnamed', c.difference_float, c.currency_code);
  if (uncategorised) add('Uncategorised', uncategorised.difference_float, uncategorised.currency_code);

  return [...totals.entries()]
    .map(([name, total]) => ({ name, total: Math.round(total), monthlyAverage: Math.round(total / months) }))
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// RBI repo rate and loan rates
// ---------------------------------------------------------------------------

/** Reads "Policy Repo Rate : 5.50%" from the RBI homepage. Returns null if absent or implausible. */
export function parseRepoRate(html: string): number | null {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const match = text.match(/Policy Repo Rate\s*:?\s*(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  return value > 0 && value < 20 ? value : null;
}

/** Default rule for a loan: repo-linked when both rates are known, else fixed at the Firefly rate. */
export function defaultLoanRateRule(fireflyApr: number | null, repoRate: number | null): LoanRateRule | undefined {
  if (fireflyApr === null) return undefined;
  if (repoRate === null) return { mode: 'fixed', apr: fireflyApr };
  return { mode: 'repoLinked', spread: round2(fireflyApr - repoRate) };
}

export function effectiveApr(rule: LoanRateRule | undefined, fireflyApr: number | null, repoRate: number | null): number | undefined {
  if (rule?.mode === 'fixed') return rule.apr;
  if (rule?.mode === 'repoLinked') return repoRate !== null ? round2(repoRate + rule.spread) : (fireflyApr ?? undefined);
  return fireflyApr ?? undefined;
}

function aprForLiability(l: SnapshotLiability, settings: FireflySettings, repoRate: number | null): number | undefined {
  const id = financeIdForLiability(l.fireflyId);
  const rule = settings.loanRates[id] ?? defaultLoanRateRule(l.fireflyApr, repoRate);
  return effectiveApr(rule, l.fireflyApr, repoRate);
}

// ---------------------------------------------------------------------------
// NW Tracker entries
// ---------------------------------------------------------------------------

export type FinanceAsset = Infer<typeof assetValidator>;
export type FinanceLiability = Infer<typeof liabilityValidator>;

function liabilityTypeFor(l: SnapshotLiability): FinanceLiability['type'] {
  if (/educat|student/i.test(l.name)) return 'studentLoan';
  if (l.liabilityType === 'mortgage') return 'mortgage';
  return 'personalLoan';
}

export function buildFinanceEntries(
  snapshot: FireflySnapshot,
  settings: FireflySettings,
  now: number
): { assets: FinanceAsset[]; liabilities: FinanceLiability[] } {
  const excluded = new Set(settings.excludedIds);
  const repo = snapshot.repoRate?.value ?? null;

  const assets: FinanceAsset[] = snapshot.assets
    .filter((a) => !excluded.has(financeIdForAsset(a.fireflyId)))
    .map((a) => {
      const id = financeIdForAsset(a.fireflyId);
      return {
        id,
        name: a.name.slice(0, 50),
        value: Math.max(0, settings.balanceOverrides[id] ?? a.balance),
        updatedAt: now,
        url: `${snapshot.baseUrl}/accounts/show/${a.fireflyId}`,
        type: a.role === 'savingAsset' ? ('savings' as const) : ('checking' as const),
      };
    });

  const liabilities: FinanceLiability[] = snapshot.liabilities
    .filter((l) => !excluded.has(financeIdForLiability(l.fireflyId)))
    .map((l) => {
      const id = financeIdForLiability(l.fireflyId);
      const apr = aprForLiability(l, settings, repo);
      return {
        id,
        name: l.name.slice(0, 50),
        balance: Math.max(0, settings.balanceOverrides[id] ?? l.balance),
        updatedAt: now,
        url: `${snapshot.baseUrl}/accounts/show/${l.fireflyId}`,
        type: liabilityTypeFor(l),
        ...(apr !== undefined ? { apr } : {}),
      };
    });

  return { assets, liabilities };
}

// ---------------------------------------------------------------------------
// Plan seed
// ---------------------------------------------------------------------------

export type PlanAccount = Infer<typeof accountValidator>;
export type PlanDebt = Infer<typeof debtValidator>;
export type PlanExpense = Infer<typeof expenseValidator>;

export interface MonthYear {
  month: number;
  year: number;
}

export interface PlanSeedOptions {
  /** NW Tracker id -> include */
  accounts: Record<string, { include: boolean }>;
  /** NW Tracker id -> loan repayment terms */
  loans: Record<string, { include: boolean; apr: number | undefined; emi: number; emiStart: MonthYear; tenureMonths: number }>;
  expenses: { name: string; monthlyAmount: number; include: boolean }[];
}

export const DEFAULT_TENURE_MONTHS = 120;
/** Categories smaller than this per month are left out of a seeded plan by default */
export const MIN_SEEDED_MONTHLY_EXPENSE = 100;

/** Reducing-balance EMI */
export function monthlyEmi(principal: number, aprPercent: number, months: number): number {
  if (months <= 0) return principal;
  const r = aprPercent / 1200;
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}

function addMonths({ month, year }: MonthYear, delta: number): MonthYear {
  const index = year * 12 + (month - 1) + delta;
  return { month: (index % 12) + 1, year: Math.floor(index / 12) };
}

function monthYearOf(timestamp: number): MonthYear {
  const d = new Date(timestamp);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

const isAfter = (a: MonthYear, b: MonthYear) => a.year * 12 + a.month > b.year * 12 + b.month;

export function defaultPlanSeedOptions(snapshot: FireflySnapshot, settings: FireflySettings, now: number): PlanSeedOptions {
  const excluded = new Set(settings.excludedIds);
  const repo = snapshot.repoRate?.value ?? null;
  const emiStart = addMonths(monthYearOf(now), 12);

  const accounts: PlanSeedOptions['accounts'] = {};
  for (const a of snapshot.assets) {
    const id = financeIdForAsset(a.fireflyId);
    accounts[id] = { include: !excluded.has(id) };
  }

  const loans: PlanSeedOptions['loans'] = {};
  for (const l of snapshot.liabilities) {
    const id = financeIdForLiability(l.fireflyId);
    const apr = aprForLiability(l, settings, repo);
    const balance = settings.balanceOverrides[id] ?? l.balance;
    loans[id] = {
      include: !excluded.has(id),
      apr,
      emi: Math.round(monthlyEmi(balance, apr ?? 0, DEFAULT_TENURE_MONTHS)),
      emiStart,
      tenureMonths: DEFAULT_TENURE_MONTHS,
    };
  }

  // Firefly's loan-interest category is replaced by the computed moratorium interest
  const expenses = snapshot.categories.map((c) => ({
    name: c.name,
    monthlyAmount: c.monthlyAverage,
    include: !/interest/i.test(c.name) && c.monthlyAverage >= MIN_SEEDED_MONTHLY_EXPENSE,
  }));

  return { accounts, loans, expenses };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function buildPlanSeed(
  snapshot: FireflySnapshot,
  settings: FireflySettings,
  options: PlanSeedOptions,
  syncedFinanceIds: Set<string>
): { accounts: PlanAccount[]; debts: PlanDebt[]; expenses: PlanExpense[] } {
  const today = monthYearOf(snapshot.fetchedAt);

  const accounts: PlanAccount[] = snapshot.assets
    .filter((a) => options.accounts[financeIdForAsset(a.fireflyId)]?.include)
    .map((a) => {
      const financeId = financeIdForAsset(a.fireflyId);
      return {
        id: `firefly-${a.fireflyId}`,
        name: a.name.slice(0, 50),
        balance: Math.max(0, settings.balanceOverrides[financeId] ?? a.balance),
        type: 'savings' as const,
        ...(syncedFinanceIds.has(financeId) ? { syncedFinanceId: financeId } : {}),
      };
    });

  const debts: PlanDebt[] = [];
  const expenses: PlanExpense[] = [];

  for (const l of snapshot.liabilities) {
    const financeId = financeIdForLiability(l.fireflyId);
    const terms = options.loans[financeId];
    if (!terms?.include) continue;

    const balance = Math.max(0, settings.balanceOverrides[financeId] ?? l.balance);
    if (balance === 0) continue;
    const apr = terms.apr ?? 0;

    debts.push({
      id: `firefly-${l.fireflyId}`,
      name: l.name.slice(0, 50),
      balance,
      apr,
      interestType: 'compound',
      compoundingFrequency: 'monthly',
      startDate: { type: 'customDate', month: terms.emiStart.month, year: terms.emiStart.year },
      monthlyPayment: Math.max(1, Math.round(terms.emi)),
      ...(syncedFinanceIds.has(financeId) ? { syncedFinanceId: financeId } : {}),
    });

    // Until EMIs start, the simulator does not run the debt; interest paid during the
    // moratorium is modelled as a monthly expense that ends the month before.
    if (isAfter(terms.emiStart, today) && apr > 0) {
      const end = addMonths(terms.emiStart, -1);
      expenses.push({
        id: `firefly-interest-${l.fireflyId}`,
        name: `Loan interest: ${l.name}`.slice(0, 50),
        amount: Math.round((balance * apr) / 100 / 12),
        frequency: 'monthly',
        timeframe: { start: { type: 'now' }, end: { type: 'customDate', month: end.month, year: end.year } },
        disabled: false,
      });
    }
  }

  for (const e of options.expenses) {
    if (!e.include || !(e.monthlyAmount > 0)) continue;
    expenses.push({
      id: `firefly-cat-${slug(e.name)}`,
      name: e.name.slice(0, 50),
      amount: Math.round(e.monthlyAmount),
      frequency: 'monthly',
      timeframe: { start: { type: 'now' } },
      disabled: false,
    });
  }

  return { accounts, debts, expenses };
}
