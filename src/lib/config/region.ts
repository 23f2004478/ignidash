/**
 * Region configuration for this fork.
 *
 * One switch decides the currency display and which tax system the simulation
 * engine uses. Upstream Ignidash is US-only; this fork defaults to India.
 *
 * The calc classes take `taxRegion` as a parameter that defaults to 'US', so
 * upstream unit tests keep testing the US path. Only the simulation engine and
 * the formatters read REGION_CONFIG.
 */

export type TaxRegion = 'US' | 'IN';

export interface RegionConfig {
  taxRegion: TaxRegion;
  currency: string;
  locale: string;
  symbol: string;
  /** 'indian' compacts to k / L (lakh) / Cr (crore); 'western' to k / M / B */
  compactUnits: 'indian' | 'western';
}

export const REGION_CONFIGS: Record<TaxRegion, RegionConfig> = {
  US: { taxRegion: 'US', currency: 'USD', locale: 'en-US', symbol: '$', compactUnits: 'western' },
  IN: { taxRegion: 'IN', currency: 'INR', locale: 'en-IN', symbol: '₹', compactUnits: 'indian' },
};

export const REGION_CONFIG: RegionConfig = REGION_CONFIGS.IN;
