/**
 * Reusable measurement helpers for tuning sweeps.
 *
 * The headline metric -- average stockpile as a multiple of each consumed
 * commodity's minimum-stockpile target -- is a HIGH-VARIANCE, seed-sensitive
 * estimator, and treating a single run's number as a capacity/ratio signal is
 * the trap this module exists to avoid. The chaos was diagnosed directly:
 *
 *   - Holding the fleet fixed and varying ONLY the World dynamics seed swings
 *     the metric by ~0.22 (SD ~0.05) over a dozen samples.
 *   - Varying the fleet size at a fixed seed swings it by ~0.22 too -- i.e.
 *     changing the fleet is statistically indistinguishable from changing the
 *     seed, because fleet size reschedules the single shared RNG stream
 *     (per-faction/per-captain event rolls + the daily act-order shuffle),
 *     which shifts every downstream market event, closure, and price-noise
 *     draw for the rest of the run.
 *   - Averaging 5+ seeds per point collapses the jaggedness and reveals the
 *     smooth underlying trend.
 *
 * Conclusion: never tune off a lone run at fine resolution. Use
 * averageStockpileRatio() to get mean +/- SD across seeds instead.
 */
import { buildWorld, type BuildWorldOptions } from "./buildWorld";
import type { World } from "./world";

export interface Stats {
  mean: number;
  sd: number;
  min: number;
  max: number;
  n: number;
}

/** Population mean/SD/min/max of a sample. */
export function stats(xs: number[]): Stats {
  const n = xs.length;
  if (n === 0) return { mean: NaN, sd: NaN, min: NaN, max: NaN, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, sd, min: Math.min(...xs), max: Math.max(...xs), n };
}

/**
 * Average stockpile / minimum-stockpile target over the last `windowDays`
 * days, across every consumed (location, commodity) sell market. 1.0 means
 * stock sits right at its minimum target on average; < 1 is a running
 * deficit, > 1 a surplus. Requires the world to have already been run.
 */
export function stockpileRatio(world: World, windowDays = 30): number {
  let total = 0;
  let count = 0;
  for (const loc of world.locations) {
    for (const commodity of Object.keys(loc.consumedCommodities)) {
      const market = world.sellMarkets.get(`${loc.name}::${commodity}`);
      if (market === undefined) continue;
      const minStock = loc.minStockpiles[commodity] ?? 0;
      if (minStock <= 0) continue;
      for (const rec of market.history.slice(-windowDays)) {
        total += rec.stockpile / minStock;
        count += 1;
      }
    }
  }
  return count > 0 ? total / count : NaN;
}

export interface AverageStockpileRatioOptions {
  /** Dynamics seeds to average over. One run per seed. */
  seeds: number[];
  /** Simulated days per run. Default 90. */
  days?: number;
  /** Trailing-day window the metric averages over. Default 30. */
  windowDays?: number;
  /** Route-distance cap passed to buildWorld. Default 3000. */
  maxRouteDistance?: number;
  /** buildWorld overrides other than `seed` (which this function supplies per run). */
  build?: Omit<BuildWorldOptions, "seed">;
}

/**
 * Build + run the world once per seed and return each run's stockpile ratio
 * plus their mean/SD -- the noise-aware way to read the metric. This is the
 * fix for single-run tuning: report `stats.mean` +/- `stats.sd`, not one
 * point.
 */
export function averageStockpileRatio(options: AverageStockpileRatioOptions): { ratios: number[]; stats: Stats } {
  const { seeds, days = 90, windowDays = 30, maxRouteDistance = 3000, build = {} } = options;
  const ratios: number[] = [];
  for (const seed of seeds) {
    const { world } = buildWorld(maxRouteDistance, { ...build, seed });
    world.run(days);
    ratios.push(stockpileRatio(world, windowDays));
  }
  return { ratios, stats: stats(ratios) };
}
