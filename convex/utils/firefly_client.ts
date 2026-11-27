/**
 * Firefly III and RBI fetchers for the connector. Runs inside Convex actions.
 *
 * Configuration (Convex environment variables; self-hosted: set in .env.local):
 *   FIREFLY_URL    base URL of the Firefly III instance, e.g. http://100.79.177.60:8090
 *   FIREFLY_TOKEN  a Firefly III Personal Access Token (Profile > OAuth). Read-only use.
 * The token never leaves the server.
 */

import { ConvexError } from 'convex/values';

import {
  normalizeAssetAccounts,
  normalizeLiabilityAccounts,
  aggregateCategorySpend,
  parseRepoRate,
  type FireflyAccount,
  type FireflyCategorySpend,
  type FireflySnapshot,
  type RepoRate,
} from './firefly_mapping';

const RBI_HOMEPAGE = 'https://www.rbi.org.in/';
const REQUEST_TIMEOUT_MS = 15000;
const SPEND_WINDOW_MONTHS = 12;

interface FireflyConfig {
  baseUrl: string;
  token: string;
}

export function getFireflyConfig(): FireflyConfig | null {
  const baseUrl = process.env.FIREFLY_URL?.trim().replace(/\/+$/, '');
  const token = process.env.FIREFLY_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fireflyGet<T>(config: FireflyConfig, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = `${config.baseUrl}/api/v1/${path}?${new URLSearchParams(params).toString()}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.api+json' },
    });
  } catch {
    throw new ConvexError(`Could not reach Firefly III at ${config.baseUrl}. Check FIREFLY_URL and that the server can reach it.`);
  }
  if (response.status === 401)
    throw new ConvexError('Firefly III rejected the token. Create a new Personal Access Token and update FIREFLY_TOKEN.');
  if (!response.ok) throw new ConvexError(`Firefly III returned ${response.status} for ${path}.`);
  return (await response.json()) as T;
}

interface Paginated<T> {
  data: T[];
  meta?: { pagination?: { total_pages?: number } };
}

async function listAccounts(config: FireflyConfig, type: 'asset' | 'liabilities'): Promise<FireflyAccount[]> {
  const all: FireflyAccount[] = [];
  for (let page = 1; page <= 20; page++) {
    const body = await fireflyGet<Paginated<FireflyAccount>>(config, 'accounts', { type, page: String(page), limit: '100' });
    all.push(...body.data);
    const totalPages = body.meta?.pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
  }
  return all;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** The last SPEND_WINDOW_MONTHS full calendar months before `now` */
export function spendWindow(now: Date): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (SPEND_WINDOW_MONTHS - 1), 1));
  return { start: isoDate(start), end: isoDate(end) };
}

/** Live RBI policy repo rate, or the last known one if RBI cannot be read */
export async function fetchRepoRate(lastKnown: { value: number; asOf: number } | null): Promise<RepoRate | null> {
  try {
    const response = await fetchWithTimeout(RBI_HOMEPAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; finance-planner)' } });
    if (response.ok) {
      const value = parseRepoRate(await response.text());
      if (value !== null) return { value, asOf: Date.now(), live: true };
    }
  } catch {
    // fall through to the last known rate
  }
  return lastKnown ? { ...lastKnown, live: false } : null;
}

export async function fetchFireflySnapshot(lastKnownRepo: { value: number; asOf: number } | null): Promise<FireflySnapshot> {
  const config = getFireflyConfig();
  if (!config) {
    throw new ConvexError('Firefly III is not connected. Set FIREFLY_URL and FIREFLY_TOKEN in the server environment.');
  }

  const { start, end } = spendWindow(new Date());

  const [assetAccounts, liabilityAccounts, categorySpend, uncategorised, repoRate] = await Promise.all([
    listAccounts(config, 'asset'),
    listAccounts(config, 'liabilities'),
    fireflyGet<FireflyCategorySpend[]>(config, 'insight/expense/category', { start, end }),
    fireflyGet<FireflyCategorySpend[]>(config, 'insight/expense/no-category', { start, end }),
    fetchRepoRate(lastKnownRepo),
  ]);

  const assets = normalizeAssetAccounts(assetAccounts);
  const liabilities = normalizeLiabilityAccounts(liabilityAccounts);
  const uncategorisedInr = uncategorised.find((u) => u.currency_code === 'INR') ?? null;

  const warnings = [...assets.warnings, ...liabilities.warnings];
  if (!repoRate) warnings.push('The RBI repo rate could not be read, so repo-linked loans keep their Firefly rate.');
  else if (!repoRate.live) warnings.push('RBI could not be reached; the last known repo rate was used.');

  return {
    baseUrl: config.baseUrl,
    fetchedAt: Date.now(),
    repoRate,
    periodStart: start,
    periodEnd: end,
    assets: assets.accounts,
    liabilities: liabilities.accounts,
    categories: aggregateCategorySpend(categorySpend, uncategorisedInr, SPEND_WINDOW_MONTHS),
    warnings,
  };
}
