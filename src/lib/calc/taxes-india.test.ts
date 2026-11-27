import { describe, it, expect } from 'vitest';

import { TaxProcessor } from './taxes';
import { Portfolio } from './portfolio';
import { Income } from './incomes';
import {
  createEmptyPortfolioData,
  createEmptyIncomesData,
  createEmptyReturnsData,
  createEmptyPhysicalAssetsData,
} from './__tests__/test-utils';
import type { SimulationState } from './simulation-engine';
import type { IncomeInputs } from '@/lib/schemas/inputs/income-form-schema';

const createMockSimulationState = (age: number): SimulationState => ({
  time: { date: new Date(2027, 6, 1), age, year: 2027, month: 1 },
  portfolio: new Portfolio([]),
  phase: { name: 'accumulation' },
  annualData: { expenses: [], debts: [], physicalAssets: [] },
});

const processIndia = (salary: number, realizedGains = 0, dividends = 0) => {
  const processor = new TaxProcessor(createMockSimulationState(24), 'single', 'IN');
  const incomes = createEmptyIncomesData();
  incomes.totalIncome = salary;
  const portfolio = createEmptyPortfolioData();
  portfolio.realizedGains = realizedGains;
  const returns = createEmptyReturnsData();
  returns.yieldAmounts.taxable.stocks = dividends;
  return processor.process(portfolio, incomes, returns, createEmptyPhysicalAssetsData());
};

describe('TaxProcessor, India new regime', () => {
  it('taxes a 16 LPA salary at slab rates after the 75k standard deduction, plus 4% cess', () => {
    const result = processIndia(1600000);

    expect(result.deductions.standardDeduction).toBe(75000);
    expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(1525000);
    // 4-8L at 5% = 20,000; 8-12L at 10% = 40,000; 12-15.25L at 15% = 48,750. Total 1,08,750, no rebate
    // Cess 4%: 1,13,100
    expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(113100, 2);
    expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0.15);
    expect(result.niit.niitAmount).toBe(0);
  });

  it('is fully rebated under 87A up to 12.75L salary', () => {
    const result = processIndia(1275000);

    expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(1200000);
    expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBe(0);
    expect(result.federalIncomeTaxes.topMarginalFederalIncomeTaxRate).toBe(0);
  });

  it('applies 87A marginal relief just above the limit', () => {
    // Taxable 12.10L: slab tax 61,500, but tax cannot exceed income above 12L (10,000)
    const result = processIndia(1285000);

    expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(10400, 2);
  });

  it('taxes listed-equity gains at 12.5% above the 1.25L exemption', () => {
    const result = processIndia(1600000, 225000);

    // (2,25,000 - 1,25,000) * 12.5% * 1.04 = 13,000
    expect(result.capitalGainsTaxes.capitalGainsTaxAmount).toBeCloseTo(13000, 2);
    expect(result.capitalGainsTaxes.topMarginalCapitalGainsTaxRate).toBe(0.125);
  });

  it('taxes dividends at slab rates, not as capital gains', () => {
    const withDividends = processIndia(1600000, 0, 100000);

    expect(withDividends.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(1625000);
    expect(withDividends.capitalGainsTaxes.capitalGainsTaxAmount).toBe(0);
  });

  it('does not set capital losses against salary', () => {
    const result = processIndia(1600000, -50000);

    expect(result.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(1525000);
    expect(result.adjustments.capitalLossDeduction).toBe(0);
  });

  it('adds surcharge above 50L', () => {
    const result = processIndia(6075000);
    // Taxable 60L: 3,00,000 up to 24L (20k + 40k + 60k + 80k + 1L), then 36L at 30% = 10,80,000. Total 13,80,000
    // Surcharge 10%, cess 4%: 13,80,000 * 1.1 * 1.04 = 15,78,720
    expect(result.federalIncomeTaxes.federalIncomeTaxAmount).toBeCloseTo(1578720, 2);
  });
});

describe('Income payroll deduction, India', () => {
  const salary: IncomeInputs = {
    id: 'salary',
    name: 'Salary',
    amount: 1600000,
    frequency: 'yearly',
    timeframe: { start: { type: 'now' } },
    taxes: { incomeType: 'wage', withholding: 0 },
  } as unknown as IncomeInputs;

  it('deducts Karnataka professional tax instead of FICA', () => {
    const india = new Income(salary, 'IN').processMonthlyAmount(2027);
    expect(india.ficaTax).toBe(200);

    const us = new Income(salary, 'US').processMonthlyAmount(2027);
    expect(us.ficaTax).toBeCloseTo((1600000 / 12) * 0.0765, 2);
  });
});
