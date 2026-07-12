/**
 * Per-run stockpile measurement for the World-tuning CLI (see
 * scripts/tune-world.ts) -- computed entirely from a already-`.run()` World's
 * recorded history (`World.combinedHistory` / each `Market.history`) joined
 * against `Location.minStockpiles`, the same data source
 * `src/sim/analysis.ts`'s `stockpileRatio` reads. No new day-loop
 * instrumentation is needed.
 *
 * Unlike `analysis.ts`'s trailing-window `stockpileRatio` (meant for a live
 * sweep reading recent behavior), this drops an initial WARMUP period instead
 * of taking a trailing window -- a post-hoc report wants the settled,
 * steady-state picture for the whole rest of the run, not just its tail, and
 * the first stretch of any run is dominated by each Location's deliberately
 * off-equilibrium seeded starting stockpile (consumed commodities start at
 * `minStockpiles * consumedStockpileFactor`, not at a running equilibrium).
 */
import type { World } from "../../src/sim/world";
import { marketKey } from "../../src/sim/markets";

/** Every day (after warmup) `stockpile / minStockpile` for one (location, commodity) pair, plus the lengths of every contiguous zero-stockpile run ("episode") within it. */
export interface PairMetrics {
  location: string;
  commodity: string;
  /** stockpile / minStockpile, one entry per post-warmup day this market has a record for. */
  ratios: number[];
  /** Lengths (in days) of every contiguous run of stockpile <= 0, post-warmup. Empty if it never hit zero. */
  episodes: number[];
  zeroDays: number;
}

export interface WorldMetrics {
  /** Count of distinct (Location, commodity) pairs that hit zero stockpile at least once, post-warmup. */
  zeroStockPairCount: number;
  /** Average length of a zero-stockpile episode, across every episode of every pair. 0 if there were none. */
  avgEpisodeLength: number;
  /** World-wide average of stockpile / minStockpile across every (pair, day) post-warmup. NaN if no consumed commodity has a positive minStockpile anywhere. */
  avgRatio: number;
  /** Per-pair breakdown, in `world.locations` order -- used to rank worst offenders (see stage1.ts/stage3.ts). */
  pairs: PairMetrics[];
}

/**
 * Measures every consumed (Location, commodity) pair's SELL market history
 * (mirrors analysis.ts's stockpileRatio's own market lookup), dropping the
 * first `warmupDays` records of each. Requires `world.run(days)` to have
 * already been called with `days > warmupDays` -- a pair whose market has no
 * post-warmup records at all (a run shorter than the warmup) is skipped.
 */
export function computeWorldMetrics(world: World, warmupDays: number): WorldMetrics {
  const pairs: PairMetrics[] = [];

  for (const loc of world.locations) {
    for (const commodity of Object.keys(loc.consumedCommodities)) {
      const market = world.sellMarkets.get(marketKey(loc.name, commodity));
      if (market === undefined) continue;
      const records = market.history.slice(warmupDays);
      if (records.length === 0) continue;

      const minStock = loc.minStockpiles[commodity] ?? 0;
      const ratios: number[] = [];
      const episodes: number[] = [];
      let zeroDays = 0;
      let currentEpisode = 0;

      for (const rec of records) {
        if (minStock > 0) ratios.push(rec.stockpile / minStock);
        if (rec.stockpile <= 0) {
          zeroDays += 1;
          currentEpisode += 1;
        } else if (currentEpisode > 0) {
          episodes.push(currentEpisode);
          currentEpisode = 0;
        }
      }
      if (currentEpisode > 0) episodes.push(currentEpisode);

      pairs.push({ location: loc.name, commodity, ratios, episodes, zeroDays });
    }
  }

  const zeroStockPairCount = pairs.filter((p) => p.zeroDays > 0).length;
  const allEpisodes = pairs.flatMap((p) => p.episodes);
  const avgEpisodeLength = allEpisodes.length > 0 ? allEpisodes.reduce((a, b) => a + b, 0) / allEpisodes.length : 0;
  const allRatios = pairs.flatMap((p) => p.ratios);
  const avgRatio = allRatios.length > 0 ? allRatios.reduce((a, b) => a + b, 0) / allRatios.length : NaN;

  return { zeroStockPairCount, avgEpisodeLength, avgRatio, pairs };
}

/** Population mean of a numeric sample -- 0 (not NaN) for an empty sample, since "no zero-stock episodes at all" should read as a clean 0, not a missing value. */
export function mean(xs: readonly number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
