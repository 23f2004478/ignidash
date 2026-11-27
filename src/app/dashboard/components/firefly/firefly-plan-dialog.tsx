'use client';

import { useMutation, useQuery } from 'convex/react';
import { useMemo, useState } from 'react';
import { DocumentPlusIcon } from '@heroicons/react/24/outline';

import { api } from '@/convex/_generated/api';
import {
  EMPTY_FIREFLY_SETTINGS,
  buildPlanSeed,
  defaultPlanSeedOptions,
  financeIdForAsset,
  financeIdForLiability,
  monthlyEmi,
  type PlanSeedOptions,
} from '@/convex/utils/firefly_mapping';
import { DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Button } from '@/components/catalyst/button';
import { Checkbox } from '@/components/catalyst/checkbox';
import { Input } from '@/components/catalyst/input';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { formatCurrency } from '@/lib/utils/number-formatters';

import { useFireflySnapshot, FireflyStatus, SectionHeading, errorText, parseAmount } from './firefly-shared';

const toMonthInput = ({ month, year }: { month: number; year: number }) => `${year}-${String(month).padStart(2, '0')}`;
const fromMonthInput = (value: string) => {
  const [year, month] = value.split('-').map(Number);
  return year && month ? { month, year } : null;
};

const monthName = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' });

export default function FireflyPlanDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, error: loadError, loading } = useFireflySnapshot(open);
  const savedSettings = useQuery(api.firefly.getSettings);
  const nwAssets = useQuery(api.finances.getAssets);
  const nwLiabilities = useQuery(api.finances.getLiabilities);
  const createPlan = useMutation(api.plans.createPlanWithData);

  const settings = savedSettings ?? EMPTY_FIREFLY_SETTINGS;
  const [name, setName] = useState(() => `From Firefly, ${monthName.format(new Date())}`);
  const [editedOptions, setOptions] = useState<PlanSeedOptions | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Until the user edits something, options are derived from the snapshot and saved settings
  const initialOptions = useMemo(
    () =>
      snapshot && savedSettings !== undefined
        ? defaultPlanSeedOptions(snapshot, savedSettings ?? EMPTY_FIREFLY_SETTINGS, snapshot.fetchedAt)
        : null,
    [snapshot, savedSettings]
  );
  const options = editedOptions ?? initialOptions;

  const syncedFinanceIds = useMemo(
    () => new Set([...(nwAssets ?? []).map((a) => a.id), ...(nwLiabilities ?? []).map((l) => l.id)]),
    [nwAssets, nwLiabilities]
  );

  const updateLoan = (id: string, patch: Partial<PlanSeedOptions['loans'][string]>) => {
    if (!options) return;
    setOptions({ ...options, loans: { ...options.loans, [id]: { ...options.loans[id], ...patch } } });
  };

  const onCreate = async () => {
    if (!snapshot || !options) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setSaveError('Give the plan a name of at least 2 characters.');
      return;
    }
    const missingRate = snapshot.liabilities.find((l) => {
      const terms = options.loans[financeIdForLiability(l.fireflyId)];
      return terms?.include && terms.apr === undefined;
    });
    if (missingRate) {
      setSaveError(`${missingRate.name} has no interest rate. Set it in Sync from Firefly first, or leave the loan out.`);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const seed = buildPlanSeed(snapshot, settings, options, syncedFinanceIds);
      await createPlan({
        newPlanName: trimmed.slice(0, 50),
        isDefault: false,
        timeline: null,
        incomes: [],
        expenses: seed.expenses,
        debts: seed.debts,
        physicalAssets: [],
        accounts: seed.accounts,
        contributionRules: [],
        baseContributionRule: { type: 'save' },
        marketAssumptions: { stockReturn: 10, stockYield: 3.5, bondReturn: 5, bondYield: 4.5, cashReturn: 3, inflationRate: 3 },
        taxSettings: { filingStatus: 'single' },
        privacySettings: { isPrivate: true },
        simulationSettings: { simulationSeed: 9521, simulationMode: 'fixedReturns' },
      });
      onClose();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <DocumentPlusIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>New plan from Firefly III</span>
        </div>
      </DialogTitle>
      <DialogBody>
        <div className="space-y-6">
          {(loadError || saveError) && <ErrorMessageCard errorMessage={loadError || saveError} />}
          {loading && !snapshot && <p className="text-muted-foreground text-sm/6">Reading Firefly III…</p>}

          {snapshot && options && (
            <>
              <FireflyStatus snapshot={snapshot} />

              <label className="block">
                <span className="text-sm/6 font-medium">Plan name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
              </label>

              <section className="space-y-3">
                <SectionHeading>Savings</SectionHeading>
                <ul className="space-y-2">
                  {snapshot.assets.map((a) => {
                    const id = financeIdForAsset(a.fireflyId);
                    const balance = settings.balanceOverrides[id] ?? a.balance;
                    return (
                      <li key={id} className="border-border/50 flex items-center gap-3 rounded-lg border p-3">
                        <Checkbox
                          checked={options.accounts[id]?.include ?? false}
                          onChange={(c: boolean) => setOptions({ ...options, accounts: { ...options.accounts, [id]: { include: c } } })}
                          aria-label={`Include ${a.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm/6 font-medium">{a.name}</p>
                          <p className="text-muted-foreground text-xs/5">
                            {formatCurrency(balance)}
                            {settings.balanceOverrides[id] !== undefined && ' (your balance)'}
                            {syncedFinanceIds.has(id) && ' · stays synced with NW Tracker'}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="space-y-3">
                <SectionHeading>Loans</SectionHeading>
                <p className="text-muted-foreground text-sm/6">
                  Until EMIs start, the interest you pay each month is added as an expense. Rates come from Sync from Firefly.
                </p>
                <ul className="space-y-2">
                  {snapshot.liabilities.map((l) => {
                    const id = financeIdForLiability(l.fireflyId);
                    const terms = options.loans[id];
                    const balance = settings.balanceOverrides[id] ?? l.balance;
                    return (
                      <li key={id} className="border-border/50 space-y-3 rounded-lg border p-3">
                        <div className="flex items-center gap-3">
                          <Checkbox
                            checked={terms.include}
                            onChange={(c: boolean) => updateLoan(id, { include: c })}
                            aria-label={`Include ${l.name}`}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm/6 font-medium">{l.name}</p>
                            <p className="text-muted-foreground text-xs/5">
                              {formatCurrency(balance)} · {terms.apr !== undefined ? `${terms.apr}% a year` : 'no rate set'}
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          <label className="block">
                            <span className="text-sm/6 font-medium">EMIs start</span>
                            <Input
                              type="month"
                              disabled={!terms.include}
                              value={toMonthInput(terms.emiStart)}
                              onChange={(e) => {
                                const emiStart = fromMonthInput(e.target.value);
                                if (emiStart) updateLoan(id, { emiStart });
                              }}
                            />
                          </label>
                          <label className="block">
                            <span className="text-sm/6 font-medium">Tenure (years)</span>
                            <Input
                              inputMode="numeric"
                              disabled={!terms.include}
                              key={`tenure-${terms.tenureMonths}`}
                              defaultValue={String(terms.tenureMonths / 12)}
                              onBlur={(e) => {
                                const years = parseAmount(e.target.value);
                                if (years === undefined || years <= 0) return;
                                const tenureMonths = Math.round(years * 12);
                                updateLoan(id, { tenureMonths, emi: Math.round(monthlyEmi(balance, terms.apr ?? 0, tenureMonths)) });
                              }}
                            />
                          </label>
                          <label className="block">
                            <span className="text-sm/6 font-medium">EMI per month</span>
                            <Input
                              inputMode="decimal"
                              disabled={!terms.include}
                              key={`emi-${terms.emi}`}
                              defaultValue={String(terms.emi)}
                              onBlur={(e) => {
                                const emi = parseAmount(e.target.value);
                                if (emi !== undefined && emi > 0) updateLoan(id, { emi });
                              }}
                            />
                          </label>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="space-y-3">
                <SectionHeading>Monthly spending (12-month average)</SectionHeading>
                <ul className="space-y-2">
                  {options.expenses.map((e, index) => (
                    <li key={e.name} className="border-border/50 grid grid-cols-[auto_1fr_9rem] items-center gap-3 rounded-lg border p-3">
                      <Checkbox
                        checked={e.include}
                        onChange={(c: boolean) =>
                          setOptions({ ...options, expenses: options.expenses.map((x, i) => (i === index ? { ...x, include: c } : x)) })
                        }
                        aria-label={`Include ${e.name}`}
                      />
                      <span className="truncate text-sm/6">
                        {e.name}
                        {/interest/i.test(e.name) && <span className="text-muted-foreground"> (covered by loan interest above)</span>}
                      </span>
                      <Input
                        aria-label={`Monthly amount for ${e.name}`}
                        inputMode="decimal"
                        disabled={!e.include}
                        key={`amount-${e.monthlyAmount}`}
                        defaultValue={String(e.monthlyAmount)}
                        onBlur={(ev) => {
                          const amount = parseAmount(ev.target.value);
                          if (amount === undefined) return;
                          setOptions({
                            ...options,
                            expenses: options.expenses.map((x, i) => (i === index ? { ...x, monthlyAmount: amount } : x)),
                          });
                        }}
                      />
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-sm/6">
                  These are today&apos;s habits. Add rent, salary and move-in costs in the plan afterwards.
                </p>
              </section>
            </>
          )}
        </div>
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose} className="hidden sm:inline-flex" disabled={saving}>
          Cancel
        </Button>
        <Button color="rose" onClick={onCreate} disabled={saving || !snapshot || !options}>
          {saving ? 'Creating…' : 'Create plan'}
        </Button>
      </DialogActions>
    </>
  );
}
