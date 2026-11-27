'use client';

import { useAction } from 'convex/react';
import { useEffect, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/20/solid';

import { api } from '@/convex/_generated/api';
import type { FireflySnapshot } from '@/convex/utils/firefly_mapping';
import { formatPercentage } from '@/lib/utils/number-formatters';

/**
 * Loads a Firefly snapshot while `open` is true. The dialogs unmount their content when
 * closed, so each opening starts fresh.
 */
export function useFireflySnapshot(open: boolean) {
  const getSnapshot = useAction(api.firefly.getSnapshot);
  const [snapshot, setSnapshot] = useState<FireflySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getSnapshot({})
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, getSnapshot]);

  return { snapshot, error, loading: open && snapshot === null && error === null };
}

export function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === 'string') return data;
  return e instanceof Error ? e.message : 'Something went wrong.';
}

const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export function FireflyStatus({ snapshot }: { snapshot: FireflySnapshot }) {
  const repo = snapshot.repoRate;
  return (
    <div className="space-y-3">
      <div className="bg-emphasized-background/60 border-border/50 grid grid-cols-1 gap-2 rounded-lg border p-3 text-sm/6 sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground">RBI repo rate</span>{' '}
          <span className="font-semibold">{repo ? formatPercentage(repo.value / 100, 2) : 'Unknown'}</span>
          {repo && (
            <span className="text-muted-foreground"> · {repo.live ? 'read live' : `last known, ${dateFormatter.format(repo.asOf)}`}</span>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">Spending window</span>{' '}
          <span className="font-semibold">
            {dateFormatter.format(new Date(snapshot.periodStart))} to {dateFormatter.format(new Date(snapshot.periodEnd))}
          </span>
        </div>
      </div>
      {snapshot.warnings.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-lg bg-amber-50 p-3 text-sm/6 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          {snapshot.warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <ExclamationTriangleIcon className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm/6 font-semibold text-stone-950 dark:text-white">{children}</h3>;
}

export const parseAmount = (value: string): number | undefined => {
  const n = parseFloat(value.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
