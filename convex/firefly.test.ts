/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import schema from './schema';
import { internal } from './_generated/api';
import { basicTemplate } from './templates/basic';
import { EMPTY_FIREFLY_SETTINGS } from './utils/firefly_mapping';

const modules = import.meta.glob('./**/*.ts');
const USER = 'firefly-user';
const NOW = Date.UTC(2026, 10, 27);

const sbi = {
  id: 'firefly-liability-26',
  name: 'Education Loan B',
  balance: 2400000,
  updatedAt: NOW,
  type: 'studentLoan' as const,
  apr: 7.85,
};

describe('firefly.applyEntries', () => {
  it('replaces Firefly entries, keeps manual ones, unlinks removed ones and pushes rates to linked debts', async () => {
    const t = convexTest(schema, modules);

    const planId = await t.run(async (ctx) => {
      await ctx.db.insert('finances', {
        userId: USER,
        assets: [
          { id: 'manual-1', name: 'Gold', value: 50000, updatedAt: NOW, type: 'preciousMetals' },
          { id: 'firefly-asset-15', name: 'TDS Receivable', value: 12000, updatedAt: NOW, type: 'checking' },
        ],
        liabilities: [{ ...sbi, apr: 7.6, balance: 2300000 }],
      });
      return await ctx.db.insert('plans', {
        ...basicTemplate,
        userId: USER,
        name: 'Plan',
        accounts: [{ id: 'acc', name: 'TDS', type: 'savings', balance: 12000, syncedFinanceId: 'firefly-asset-15' }],
        debts: [
          {
            id: 'debt',
            name: 'Loan B',
            balance: 2300000,
            apr: 7.6,
            interestType: 'compound',
            compoundingFrequency: 'monthly',
            startDate: { type: 'customDate', month: 11, year: 2027 },
            monthlyPayment: 28000,
            syncedFinanceId: 'firefly-liability-26',
          },
        ],
      });
    });

    await t.mutation(internal.firefly.applyEntries, {
      userId: USER,
      assets: [{ id: 'firefly-asset-1', name: 'Primary Bank', value: 40000, updatedAt: NOW, type: 'checking' }],
      liabilities: [sbi],
      settings: { ...EMPTY_FIREFLY_SETTINGS, excludedIds: ['firefly-asset-15'], repoRate: { value: 5.75, asOf: NOW }, lastSyncedAt: NOW },
    });

    await t.run(async (ctx) => {
      const finances = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', USER))
        .first();
      expect(finances!.assets.map((a) => a.id)).toEqual(['manual-1', 'firefly-asset-1']);
      expect(finances!.liabilities).toEqual([sbi]);
      expect(finances!.firefly?.repoRate?.value).toBe(5.75);

      const plan = await ctx.db.get(planId);
      expect(plan!.accounts[0].syncedFinanceId).toBeUndefined();
      expect(plan!.debts![0]).toMatchObject({ balance: 2400000, apr: 7.85, syncedFinanceId: 'firefly-liability-26' });
    });
  });

  it('creates the finances document on first sync', async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.firefly.applyEntries, {
      userId: USER,
      assets: [{ id: 'firefly-asset-1', name: 'Primary Bank', value: 40000, updatedAt: NOW, type: 'checking' }],
      liabilities: [],
      settings: EMPTY_FIREFLY_SETTINGS,
    });
    await t.run(async (ctx) => {
      const all = await ctx.db.query('finances').collect();
      expect(all).toHaveLength(1);
      expect(all[0].firefly?.autoSync).toBe(false);
    });
  });
});
