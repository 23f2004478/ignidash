# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Fork: India adaptation (read first)

This is a fork of schelskedevco/ignidash adapted for India. `origin` is the fork, `upstream` the original.

- **One switch:** `src/lib/config/region.ts` (`REGION_CONFIG`, default `IN`). It drives currency display
  (INR, en-IN grouping, compact k / L / Cr) and the tax system the engine uses.
- **Calc classes take `taxRegion`, defaulting to `'US'`** (`TaxProcessor`, `Incomes`, `Income`), so upstream unit
  tests keep testing the US path. Only `simulation-engine.ts` and `number-formatters.ts` read `REGION_CONFIG`.
  `simulation-engine.test.ts` pins US with `vi.mock`.
- **India tax:** `src/lib/calc/tax-data/india-new-regime.ts` plus `TaxProcessor.processIndia`. New regime slabs,
  75k standard deduction, 87A rebate with marginal relief, surcharge, 4% cess, 112A equity gains at 12.5% over
  1.25L, dividends at slab. Payroll levy is Karnataka professional tax (Rs 200/month) in place of FICA. Output
  reuses the US-shaped fields (`federalIncomeTaxes` carries Indian income tax), so charts work unchanged.
  Tests: `src/lib/calc/taxes-india.test.ts`.
- **Firefly III connector:** `convex/firefly.ts` (actions `getSnapshot`, `syncNow`; daily cron `scheduledSync`),
  `convex/utils/firefly_client.ts` (Firefly API + RBI repo rate fetch), `convex/utils/firefly_mapping.ts` (pure
  mapping, shared with the UI; tests beside it). UI: `src/app/dashboard/components/firefly/` (sync dialog from the NW
  Tracker header, plan-seed dialog from the Plans header). Firefly entries live in the NW Tracker with ids
  `firefly-asset-N` / `firefly-liability-N`, so existing plan sync carries balances (and, new, liability `apr`) into
  linked plan accounts and debts. Per-user settings (exclusions, balance overrides, loan rate rules, auto sync) sit on
  `finances.firefly`. Repo-linked loans store a spread; rate = live RBI repo + spread on every sync. Config:
  `FIREFLY_URL`, `FIREFLY_TOKEN` (Convex env; forwarded by `scripts/convex-init.sh`). `convex/_generated/api.d.ts` was
  extended by hand for the new modules; `npx convex dev` regenerates the same listing.
- **Not done yet:** UI labels still say Federal / FICA / NIIT; US account types (401k, Roth, HSA) and RMDs still
  show; no old regime, HRA, 80C, EPF/NPS account types.
- Keep the diff against upstream small and contained so `git merge upstream/main` stays easy.

## Project Overview

Ignidash is an open-source personal financial planning app (AGPL-3.0). It runs Monte Carlo simulations, historical backtesting, US tax estimation, and AI chat/insights for retirement planning.

## Tech Stack

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- **Backend:** Convex (serverless DB + functions)
- **Auth:** Better-Auth with Convex integration + Google OAuth
- **Payments:** Stripe
- **AI:** Azure OpenAI (streaming chat + insights)
- **State:** Zustand 5 (with Immer, persist, devtools)
- **Forms:** React Hook Form + Zod 4 validation
- **Charts:** Recharts 3
- **Analytics:** PostHog

## Commands

```bash
npm run dev              # Next.js dev server
npm run dev:convex       # Convex dev against the selected deployment (run alongside dev; first run `npx convex deployment select local`)
npm run build            # Production build
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format all
npm run typecheck        # TypeScript check (tsc --noEmit)

# Testing
npm run test             # Vitest watch mode
npm run test:once        # Vitest single run
npm run test:once -- src/lib/calc/__tests__/taxes.test.ts  # Run single test file
npm run test:coverage    # Coverage report
npm run test:e2e         # Playwright e2e tests
```

## Pre-commit Hooks

Husky runs `lint-staged` on commit, which auto-runs `eslint --fix` + `prettier --write` on staged `.js/.jsx/.ts/.tsx` files and `prettier --write` on `.json/.md/.css`. Files in `convex/_generated/` are excluded.

## Path Aliases

- `@/*` → `src/*`
- `@/convex/*` → `convex/*`

## Architecture

### Routing (Next.js App Router)

- `src/app/(auth)/` — Sign in/up, password reset (public)
- `src/app/(marketing)/` — Home, pricing, about (public)
- `src/app/(legal)/` — Privacy, terms (public)
- `src/app/dashboard/` — Protected area: simulator, insights, compare
- `src/app/dashboard/simulator/[planId]/` — Main simulator view per plan
- `src/app/api/auth/` — Better-Auth API endpoints

### Convex Backend (`convex/`)

All server functions (queries, mutations, actions) live here. Key files:

- `plans.ts`, `account.ts`, `income.ts`, `expense.ts`, `debt.ts` — CRUD for financial entities
- `messages.ts`, `conversations.ts` — AI chat
- `insights.ts` — AI-generated insights
- `http.ts` — HTTP endpoints (Stripe webhooks)
- `utils/auth_utils.ts` — `getUserIdOrThrow(ctx)` for auth in every query/mutation
- `utils/sys_prompt_utils.ts` — Dynamic AI system prompt from plan data
- `validators/` — Input validators for Convex functions
- `_generated/` — Auto-generated types and API (do not edit)
- `betterAuth/_generated/` — Auto-generated auth types (do not edit)

### Simulation Engine (`src/lib/calc/`)

The core financial simulator runs month-by-month loops producing yearly `SimulationDataPoint`s:

- `simulation-engine.ts` — `FinancialSimulationEngine` orchestrates the loop
- `portfolio.ts`, `account.ts`, `incomes.ts`, `expenses.ts`, `taxes.ts`, `debts.ts` — Per-domain calculation modules
- `returns-providers/` — Strategy pattern: `FixedReturnsProvider`, `StochasticReturnsProvider`, `LcgHistoricalBacktestReturnsProvider`
- `data-extractors/` — Extract chart data, table data, key metrics from simulation results
- `__tests__/` — Unit tests for the engine

### Web Workers (`src/lib/workers/`)

Heavy simulation work runs off-main-thread via Comlink:

- `simulation-worker-api.ts` — Worker pool management
- `simulation.worker.ts` — Runs individual simulations
- `merge-worker-api.ts` / `merge.worker.ts` — Aggregates multi-simulation results

### State Management (`src/lib/stores/simulator-store.ts`)

Single Zustand store (`useSimulatorStore`) with slices: `results`, `preferences`, `chat`, `insights`, `nux`, `numbers`. Uses Immer middleware for mutable updates. Only `preferences` and `nux` are persisted to localStorage.

### Data Flow Pattern

1. Convex queries fetched via hooks in `src/hooks/use-convex-data.ts` (wraps `useQuery`)
2. Data transformed from Convex documents → Zod types via `src/lib/utils/convex-to-zod-transformers.ts`
3. Zod-validated inputs fed into simulation engine
4. Results extracted by data extractors into chart/table/metric data
5. SWR used for derived data caching (multi-simulation analysis)

### Schemas & Validation (`src/lib/schemas/`)

- `inputs/simulator-schema.ts` — Root `SimulatorInputs` type composing all sub-schemas
- `inputs/` — Per-domain form schemas (income, account, expense, etc.)
- `finances/` — Financial object schemas
- `tables/` — Table row schemas

### Hooks (`src/hooks/`)

~25 custom hooks. Key ones:

- `use-convex-data.ts` — All Convex query hooks (`usePlanData`, `useIncomesData`, etc.)
- `use-results-state.ts` — Simulation results state
- `use-regen-simulation.ts` — Trigger simulation re-runs
- `use-chart-*.ts` — Chart data extraction hooks

### Components

- `src/components/ui/` — shadcn/ui components
- `src/components/catalyst/` — Catalyst UI library (custom form/table components)
- `src/components/layout/sidebar/` — Desktop and mobile sidebars
- `src/components/providers/` — Theme provider

### Currency Formatting

Centralized in `src/lib/config/currency.ts` and `src/lib/utils/format-currency.ts`:

- `formatCurrency(amount, {cents?})` — Full display ($1,234,567)
- `formatCompactCurrency(amount, digits)` — Compact ($1.5M, $200k)
- `getCurrencySymbol()` — Returns '$'
- `formatCurrencyPlaceholder(amount)` — Form placeholders

`formatNumber` in `src/lib/utils.ts` is only for non-currency values (percentages, plain numbers).

## Code Style

- Prettier: single quotes, semicolons, trailing commas (ES5), 140 char width, Tailwind class sorting
- ESLint: flat config (ESLint 9), extends `next/core-web-vitals` + `next/typescript` + `prettier`
- Unused variables: underscore prefix allowed (e.g., `_unused`)
- All components are `'use client'` unless explicitly server components

Native (systemd, no Docker) hosting on a private-network box: see HOSTING-NATIVE.md.
