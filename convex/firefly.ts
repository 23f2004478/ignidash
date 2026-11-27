/**
 * Firefly III connector.
 *
 * - getSnapshot: read Firefly (and the RBI repo rate) for the sync and plan-seed dialogs.
 * - syncNow: write Firefly balances into the NW Tracker; linked plan accounts and debts follow.
 * - scheduledSync: daily cron for users who turned on automatic sync.
 *
 * Plans are seeded client-side from a snapshot through plans.createPlanWithData.
 */

import { v, ConvexError } from 'convex/values';

import { action, query, internalAction, internalMutation, internalQuery, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { assetValidator } from './validators/asset_validator';
import { liabilityValidator } from './validators/liability_validator';
import { fireflySettingsValidator } from './validators/firefly_settings_validator';
import { getUserIdOrThrow } from './utils/auth_utils';
import { getFinancesForUser } from './utils/finances_utils';
import { syncAssetToPlans, unsyncAssetFromPlans, syncLiabilityToPlans, unsyncLiabilityFromPlans } from './utils/finance_sync_utils';
import { fetchFireflySnapshot, getFireflyConfig } from './utils/firefly_client';
import {
  buildFinanceEntries,
  isFireflyFinanceId,
  type FireflySettings,
  type FireflySnapshot,
  type RepoRate,
} from './utils/firefly_mapping';

const MAX_ENTRIES = 25;

async function requireUserId(ctx: ActionCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity?.subject) throw new ConvexError('User not authenticated');
  return identity.subject;
}

export const getSettings = query({
  handler: async (ctx): Promise<FireflySettings | null> => {
    const { userId } = await getUserIdOrThrow(ctx);
    const finances = await getFinancesForUser(ctx, userId);
    return finances?.firefly ?? null;
  },
});

export const getSettingsForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }): Promise<FireflySettings | null> => {
    const finances = await getFinancesForUser(ctx, userId);
    return finances?.firefly ?? null;
  },
});

export const getSnapshot = action({
  args: {},
  handler: async (ctx): Promise<FireflySnapshot> => {
    const userId = await requireUserId(ctx);
    const settings: FireflySettings | null = await ctx.runQuery(internal.firefly.getSettingsForUser, { userId });
    return await fetchFireflySnapshot(settings?.repoRate ?? null);
  },
});

export const syncNow = action({
  args: { settings: fireflySettingsValidator },
  handler: async (ctx, { settings }): Promise<{ assets: number; liabilities: number; repoRate: RepoRate | null; warnings: string[] }> => {
    const userId = await requireUserId(ctx);
    const snapshot = await fetchFireflySnapshot(settings.repoRate ?? null);
    await applySnapshotForUser(ctx, userId, snapshot, settings);
    return {
      assets: snapshot.assets.length,
      liabilities: snapshot.liabilities.length,
      repoRate: snapshot.repoRate,
      warnings: snapshot.warnings,
    };
  },
});

async function applySnapshotForUser(ctx: ActionCtx, userId: string, snapshot: FireflySnapshot, settings: FireflySettings): Promise<void> {
  const now = Date.now();
  const { assets, liabilities } = buildFinanceEntries(snapshot, settings, now);
  const repoRate = snapshot.repoRate ? { value: snapshot.repoRate.value, asOf: snapshot.repoRate.asOf } : settings.repoRate;
  await ctx.runMutation(internal.firefly.applyEntries, {
    userId,
    assets,
    liabilities,
    settings: { ...settings, ...(repoRate ? { repoRate } : {}), lastSyncedAt: now },
  });
}

/** Replaces the user's Firefly-sourced NW Tracker entries, keeps manual ones, and syncs linked plans. */
export const applyEntries = internalMutation({
  args: {
    userId: v.string(),
    assets: v.array(assetValidator),
    liabilities: v.array(liabilityValidator),
    settings: fireflySettingsValidator,
  },
  handler: async (ctx, { userId, assets, liabilities, settings }) => {
    const finances = await getFinancesForUser(ctx, userId);

    const manualAssets = finances?.assets.filter((a) => !isFireflyFinanceId(a.id)) ?? [];
    const manualLiabilities = finances?.liabilities.filter((l) => !isFireflyFinanceId(l.id)) ?? [];
    const nextAssets = [...manualAssets, ...assets];
    const nextLiabilities = [...manualLiabilities, ...liabilities];

    if (nextAssets.length > MAX_ENTRIES) throw new ConvexError(`Maximum of ${MAX_ENTRIES} assets reached. Exclude some Firefly accounts.`);
    if (nextLiabilities.length > MAX_ENTRIES)
      throw new ConvexError(`Maximum of ${MAX_ENTRIES} liabilities reached. Exclude some Firefly liabilities.`);

    const keptIds = new Set([...assets.map((a) => a.id), ...liabilities.map((l) => l.id)]);
    const removedAssetIds = (finances?.assets ?? []).filter((a) => isFireflyFinanceId(a.id) && !keptIds.has(a.id)).map((a) => a.id);
    const removedLiabilityIds = (finances?.liabilities ?? [])
      .filter((l) => isFireflyFinanceId(l.id) && !keptIds.has(l.id))
      .map((l) => l.id);

    if (finances) {
      await ctx.db.patch(finances._id, { assets: nextAssets, liabilities: nextLiabilities, firefly: settings });
    } else {
      await ctx.db.insert('finances', { userId, assets: nextAssets, liabilities: nextLiabilities, firefly: settings });
    }

    // Sequential: each call patches the same plan documents
    for (const id of removedAssetIds) await unsyncAssetFromPlans(ctx, userId, id);
    for (const id of removedLiabilityIds) await unsyncLiabilityFromPlans(ctx, userId, id);
    for (const asset of assets) await syncAssetToPlans(ctx, userId, asset);
    for (const liability of liabilities) await syncLiabilityToPlans(ctx, userId, liability);
  },
});

export const listAutoSyncSettings = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ userId: string; settings: FireflySettings }[]> => {
    const all = await ctx.db.query('finances').collect();
    return all.filter((f) => f.firefly?.autoSync).map((f) => ({ userId: f.userId, settings: f.firefly! }));
  },
});

export const scheduledSync = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    if (!getFireflyConfig()) return;

    const users: { userId: string; settings: FireflySettings }[] = await ctx.runQuery(internal.firefly.listAutoSyncSettings, {});
    if (users.length === 0) return;

    const lastKnownRepo = users.find((u) => u.settings.repoRate)?.settings.repoRate ?? null;
    const snapshot = await fetchFireflySnapshot(lastKnownRepo);

    for (const { userId, settings } of users) {
      await applySnapshotForUser(ctx, userId, snapshot, settings);
    }
  },
});
