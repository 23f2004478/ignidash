/**
 * India income tax, new regime (section 115BAC), for a resident individual.
 *
 * FY 2025-26 rates, retained unchanged for FY 2026-27 by Budget 2026 (the new
 * Income-tax Act takes effect 1 April 2026 with the same rates). Verify against
 * the Finance Act before relying on them for filing.
 *
 * First pass, deliberately narrow: salaried income plus listed-equity gains.
 * Not modelled: old regime, HRA, 80C and other old-regime deductions, employer
 * NPS 80CCD(2), surcharge marginal relief, short-term vs long-term holding period.
 */

import type { FederalIncomeTaxBracket } from './federal-income-tax-brackets';
import type { CapitalGainsTaxBracket } from './capital-gains-tax-brackets';

/** Slab rates on income after the standard deduction */
export const INDIA_NEW_REGIME_SLABS: FederalIncomeTaxBracket[] = [
  { min: 0, max: 400000, rate: 0.0 },
  { min: 400000, max: 800000, rate: 0.05 },
  { min: 800000, max: 1200000, rate: 0.1 },
  { min: 1200000, max: 1600000, rate: 0.15 },
  { min: 1600000, max: 2000000, rate: 0.2 },
  { min: 2000000, max: 2400000, rate: 0.25 },
  { min: 2400000, max: Infinity, rate: 0.3 },
];

/** Standard deduction for salary income, new regime */
export const INDIA_STANDARD_DEDUCTION_SALARY = 75000;

/** Section 87A: full rebate of slab tax (up to this amount) when total income is within the limit */
export const INDIA_REBATE_87A_INCOME_LIMIT = 1200000;
export const INDIA_REBATE_87A_MAX = 60000;

/** Health and education cess on tax plus surcharge */
export const INDIA_CESS_RATE = 0.04;

/** Surcharge by total income, new regime (capped at 25%) */
export const INDIA_SURCHARGE_BANDS: { above: number; rate: number }[] = [
  { above: 20000000, rate: 0.25 },
  { above: 10000000, rate: 0.15 },
  { above: 5000000, rate: 0.1 },
];

/** Surcharge on listed-equity gains (sections 111A / 112A) is capped at 15% */
export const INDIA_EQUITY_GAINS_SURCHARGE_CAP = 0.15;

/** Section 112A: long-term gains on listed equity, taxed at 12.5% above a yearly exemption */
export const INDIA_LTCG_EXEMPTION = 125000;
export const INDIA_LTCG_RATE = 0.125;

/** Shown on charts in place of US capital gains brackets */
export const INDIA_LTCG_BRACKETS: CapitalGainsTaxBracket[] = [
  { min: 0, max: INDIA_LTCG_EXEMPTION, rate: 0.0 },
  { min: INDIA_LTCG_EXEMPTION, max: Infinity, rate: INDIA_LTCG_RATE },
];

/**
 * Professional tax, Karnataka: Rs 200 a month once monthly salary reaches Rs 25,000
 * (Rs 300 in February, ignored here). Stands in for US FICA as the payroll deduction.
 * Employee PF is not a tax: model it as a savings account with a contribution rule.
 */
export const INDIA_PROFESSIONAL_TAX_MONTHLY = 200;
export const INDIA_PROFESSIONAL_TAX_THRESHOLD_MONTHLY = 25000;

export function getIndiaSurchargeRate(totalIncome: number): number {
  for (const band of INDIA_SURCHARGE_BANDS) {
    if (totalIncome > band.above) return band.rate;
  }
  return 0;
}
