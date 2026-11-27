'use client';

import { useAction, useQuery } from 'convex/react';
import { useMemo, useState } from 'react';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

import { api } from '@/convex/_generated/api';
import {
  EMPTY_FIREFLY_SETTINGS,
  defaultLoanRateRule,
  effectiveApr,
  financeIdForAsset,
  financeIdForLiability,
  type FireflySettings,
  type FireflySnapshot,
  type LoanRateRule,
} from '@/convex/utils/firefly_mapping';
import { DialogTitle, DialogBody, DialogActions } from '@/components/catalyst/dialog';
import { Button } from '@/components/catalyst/button';
import { Checkbox } from '@/components/catalyst/checkbox';
import { Switch, SwitchField } from '@/components/catalyst/switch';
import { Input } from '@/components/catalyst/input';
import { Label, Description } from '@/components/catalyst/fieldset';
import ErrorMessageCard from '@/components/ui/error-message-card';
import { formatCurrency } from '@/lib/utils/number-formatters';

import { useFireflySnapshot, FireflyStatus, SectionHeading, errorText, parseAmount } from './firefly-shared';

interface LoanRateDraft {
  rate: string;
  repoLinked: boolean;
}

interface Draft {
  excluded: Set<string>;
  overrides: Record<string, string>;
  rates: Record<string, LoanRateDraft>;
  autoSync: boolean;
}

function draftFrom(snapshot: FireflySnapshot, saved: FireflySettings): Draft {
  const repo = snapshot.repoRate?.value ?? null;
  const rates: Record<string, LoanRateDraft> = {};
  for (const l of snapshot.liabilities) {
    const id = financeIdForLiability(l.fireflyId);
    const rule = saved.loanRates[id] ?? defaultLoanRateRule(l.fireflyApr, repo);
    const apr = effectiveApr(rule, l.fireflyApr, repo);
    rates[id] = { rate: apr !== undefined ? String(apr) : '', repoLinked: rule ? rule.mode === 'repoLinked' : repo !== null };
  }
  return {
    excluded: new Set(saved.excludedIds),
    overrides: Object.fromEntries(Object.entries(saved.balanceOverrides).map(([k, v]) => [k, String(v)])),
    rates,
    autoSync: saved.autoSync,
  };
}

function settingsFrom(draft: Draft, snapshot: FireflySnapshot, saved: FireflySettings): FireflySettings {
  const repo = snapshot.repoRate?.value ?? null;
  const loanRates: Record<string, LoanRateRule> = {};
  for (const [id, { rate, repoLinked }] of Object.entries(draft.rates)) {
    const apr = parseAmount(rate);
    if (apr === undefined) continue;
    loanRates[id] =
      repoLinked && repo !== null ? { mode: 'repoLinked', spread: Math.round((apr - repo) * 100) / 100 } : { mode: 'fixed', apr };
  }
  const balanceOverrides: Record<string, number> = {};
  for (const [id, value] of Object.entries(draft.overrides)) {
    const n = parseAmount(value);
    if (n !== undefined) balanceOverrides[id] = n;
  }
  return {
    ...saved,
    excludedIds: [...draft.excluded],
    balanceOverrides,
    loanRates,
    autoSync: draft.autoSync,
  };
}

export default function FireflySyncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snapshot, error: loadError, loading } = useFireflySnapshot(open);
  const savedSettings = useQuery(api.firefly.getSettings);
  const syncNow = useAction(api.firefly.syncNow);

  const [editedDraft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Until the user edits something, the draft is derived from the snapshot and saved settings
  const initialDraft = useMemo(
    () => (snapshot && savedSettings !== undefined ? draftFrom(snapshot, savedSettings ?? EMPTY_FIREFLY_SETTINGS) : null),
    [snapshot, savedSettings]
  );
  const draft = editedDraft ?? initialDraft;

  const toggleIncluded = (id: string, include: boolean) => {
    if (!draft) return;
    const excluded = new Set(draft.excluded);
    if (include) excluded.delete(id);
    else excluded.add(id);
    setDraft({ ...draft, excluded });
  };

  const onSave = async () => {
    if (!snapshot || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await syncNow({ settings: settingsFrom(draft, snapshot, savedSettings ?? EMPTY_FIREFLY_SETTINGS) });
      onClose();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const repo = snapshot?.repoRate?.value ?? null;

  return (
    <>
      <DialogTitle onClose={onClose}>
        <div className="flex items-center gap-4">
          <ArrowPathIcon className="text-primary size-8 shrink-0" aria-hidden="true" />
          <span>Sync from Firefly III</span>
        </div>
      </DialogTitle>
      <DialogBody>
        <div className="space-y-6">
          {(loadError || saveError) && <ErrorMessageCard errorMessage={loadError || saveError} />}
          {loading && !snapshot && <p className="text-muted-foreground text-sm/6">Reading Firefly III and the RBI repo rate…</p>}

          {snapshot && draft && (
            <>
              <FireflyStatus snapshot={snapshot} />

              <section className="space-y-3">
                <SectionHeading>Accounts</SectionHeading>
                <p className="text-muted-foreground text-sm/6">
                  Leave a balance blank to use Firefly&apos;s. Enter your real balance when Firefly&apos;s is wrong; it is kept on every
                  sync.
                </p>
                <ul className="space-y-2">
                  {snapshot.assets.map((a) => {
                    const id = financeIdForAsset(a.fireflyId);
                    const included = !draft.excluded.has(id);
                    return (
                      <li
                        key={id}
                        className="border-border/50 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-lg border p-3 sm:grid-cols-[auto_1fr_12rem]"
                      >
                        <Checkbox checked={included} onChange={(c: boolean) => toggleIncluded(id, c)} aria-label={`Include ${a.name}`} />
                        <div className="min-w-0">
                          <p className="truncate text-sm/6 font-medium">{a.name}</p>
                          <p className="text-muted-foreground text-xs/5">Firefly: {formatCurrency(a.balance)}</p>
                        </div>
                        <Input
                          className="col-span-2 sm:col-span-1"
                          aria-label={`Balance to use for ${a.name}`}
                          inputMode="decimal"
                          placeholder={formatCurrency(a.balance)}
                          disabled={!included}
                          value={draft.overrides[id] ?? ''}
                          onChange={(e) => setDraft({ ...draft, overrides: { ...draft.overrides, [id]: e.target.value } })}
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="space-y-3">
                <SectionHeading>Loans</SectionHeading>
                <p className="text-muted-foreground text-sm/6">
                  A repo-linked loan is saved as repo rate + spread, so its rate moves on the next sync after the RBI changes the repo rate.
                </p>
                <ul className="space-y-2">
                  {snapshot.liabilities.map((l) => {
                    const id = financeIdForLiability(l.fireflyId);
                    const included = !draft.excluded.has(id);
                    const rateDraft = draft.rates[id];
                    const apr = parseAmount(rateDraft.rate);
                    const spread = apr !== undefined && repo !== null ? apr - repo : undefined;
                    return (
                      <li key={id} className="border-border/50 space-y-3 rounded-lg border p-3">
                        <div className="grid grid-cols-[auto_1fr] items-center gap-3">
                          <Checkbox checked={included} onChange={(c: boolean) => toggleIncluded(id, c)} aria-label={`Include ${l.name}`} />
                          <div className="min-w-0">
                            <p className="truncate text-sm/6 font-medium">{l.name}</p>
                            <p className="text-muted-foreground text-xs/5">
                              Owed: {formatCurrency(l.balance)}
                              {l.fireflyApr !== null ? ` · Firefly rate ${l.fireflyApr}%` : ' · no rate in Firefly'}
                            </p>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <label className="block">
                            <span className="text-sm/6 font-medium">Current rate (% a year)</span>
                            <Input
                              inputMode="decimal"
                              placeholder="e.g. 7.0"
                              disabled={!included}
                              value={rateDraft.rate}
                              onChange={(e) =>
                                setDraft({ ...draft, rates: { ...draft.rates, [id]: { ...rateDraft, rate: e.target.value } } })
                              }
                            />
                          </label>
                          <SwitchField>
                            <Label>Follows repo rate</Label>
                            <Description>
                              {rateDraft.repoLinked && spread !== undefined
                                ? `Repo + ${spread.toFixed(2)}%`
                                : repo === null
                                  ? 'Repo rate unavailable'
                                  : 'Fixed rate'}
                            </Description>
                            <Switch
                              checked={rateDraft.repoLinked}
                              disabled={!included || repo === null}
                              onChange={(c: boolean) =>
                                setDraft({ ...draft, rates: { ...draft.rates, [id]: { ...rateDraft, repoLinked: c } } })
                              }
                            />
                          </SwitchField>
                        </div>
                        <label className="block">
                          <span className="text-sm/6 font-medium">Balance to use (optional)</span>
                          <Input
                            inputMode="decimal"
                            placeholder={formatCurrency(l.balance)}
                            disabled={!included}
                            value={draft.overrides[id] ?? ''}
                            onChange={(e) => setDraft({ ...draft, overrides: { ...draft.overrides, [id]: e.target.value } })}
                          />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <SwitchField>
                <Label>Refresh every morning</Label>
                <Description>Balances and repo-linked rates update daily at 6:30 IST.</Description>
                <Switch checked={draft.autoSync} onChange={(c: boolean) => setDraft({ ...draft, autoSync: c })} />
              </SwitchField>
            </>
          )}
        </div>
      </DialogBody>
      <DialogActions>
        <Button plain onClick={onClose} className="hidden sm:inline-flex" disabled={saving}>
          Cancel
        </Button>
        <Button color="rose" onClick={onSave} disabled={saving || !snapshot || !draft}>
          {saving ? 'Syncing…' : 'Save and sync'}
        </Button>
      </DialogActions>
    </>
  );
}
