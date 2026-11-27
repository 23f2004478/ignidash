import { v } from 'convex/values';

export const loanRateRuleValidator = v.union(
  v.object({ mode: v.literal('repoLinked'), spread: v.number() }),
  v.object({ mode: v.literal('fixed'), apr: v.number() })
);

/** Per-user Firefly III connector settings, stored on the finances document */
export const fireflySettingsValidator = v.object({
  excludedIds: v.array(v.string()),
  balanceOverrides: v.record(v.string(), v.number()),
  loanRates: v.record(v.string(), loanRateRuleValidator),
  autoSync: v.boolean(),
  repoRate: v.optional(v.object({ value: v.number(), asOf: v.number() })),
  lastSyncedAt: v.optional(v.number()),
});
