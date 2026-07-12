/**
 * Multi-seed evaluation of a candidate World JSON, and the lexicographic
 * objective the tuning stages (see stage1.ts/stage2.ts/stage3.ts) use to
 * decide whether a candidate change is an improvement.
 */
import { buildWorldFromJson, type BuildWorldFromJsonOptions } from "../../src/sim/buildWorldFromJson";
import { computeWorldMetrics, mean, type WorldMetrics } from "./metrics";
import type { WorldJson } from "./worldJson";

export interface EvalConfig {
  seeds: number[];
  days: number;
  warmupDays: number;
  numPirateShips: number;
  pirateCashPerShip: number;
  numPoliceShips: number;
  targetShipsPerLocation: number;
}

export interface AggregatedResult {
  zeroStockPairCount: number;
  avgEpisodeLength: number;
  avgRatio: number;
  perSeed: WorldMetrics[];
}

function meanIgnoringNaN(xs: readonly number[]): number {
  const finite = xs.filter((x) => !Number.isNaN(x));
  return finite.length > 0 ? mean(finite) : NaN;
}

/**
 * Builds + runs `worldJson` once per seed in `config.seeds`, SEQUENTIALLY --
 * only one World's module-level geography/routes/commodities can be "live"
 * at a time (buildWorldFromJson/buildWorld reassign worldData.LOCATIONS,
 * routes.ROUTES, etc. wholesale -- see CLAUDE.md's "mutable module-level
 * world state"). Building a second World before the first has finished
 * running would silently swap the first's pathfinding/pricing data out from
 * under it mid-run. Never parallelize or interleave these calls.
 */
export function evaluateWorld(worldJson: WorldJson, config: EvalConfig): AggregatedResult {
  const text = JSON.stringify(worldJson);
  const perSeed: WorldMetrics[] = [];
  for (const seed of config.seeds) {
    const options: BuildWorldFromJsonOptions = {
      seed,
      numPirateShips: config.numPirateShips,
      pirateCashPerShip: config.pirateCashPerShip,
      numPoliceShips: config.numPoliceShips,
      targetShipsPerLocation: config.targetShipsPerLocation,
    };
    const { world } = buildWorldFromJson(text, options);
    world.run(config.days);
    perSeed.push(computeWorldMetrics(world, config.warmupDays));
  }
  return {
    zeroStockPairCount: mean(perSeed.map((m) => m.zeroStockPairCount)),
    avgEpisodeLength: mean(perSeed.map((m) => m.avgEpisodeLength)),
    avgRatio: meanIgnoringNaN(perSeed.map((m) => m.avgRatio)),
    perSeed,
  };
}

/**
 * Lexicographic objective: primarily minimize zeroStockPairCount, then
 * avgEpisodeLength as a tiebreaker -- but a candidate is rejected outright if
 * it would push avgRatio outside [1-tolerance, 1+tolerance] when the baseline
 * was already inside that band (the ratio is a guardrail against
 * overcorrecting into oversupply, not something to independently optimize).
 * If the baseline itself was already outside the band, only require the
 * candidate not move further from 1.0.
 */
export function isImprovement(baseline: AggregatedResult, candidate: AggregatedResult, ratioTolerance: number): boolean {
  const lo = 1 - ratioTolerance;
  const hi = 1 + ratioTolerance;
  const baselineInBand = baseline.avgRatio >= lo && baseline.avgRatio <= hi;
  const candidateInBand = candidate.avgRatio >= lo && candidate.avgRatio <= hi;
  if (baselineInBand && !candidateInBand) return false;
  if (!baselineInBand && !candidateInBand) {
    const baselineDistance = Math.abs(baseline.avgRatio - 1);
    const candidateDistance = Math.abs(candidate.avgRatio - 1);
    if (candidateDistance > baselineDistance) return false;
  }

  if (candidate.zeroStockPairCount !== baseline.zeroStockPairCount) {
    return candidate.zeroStockPairCount < baseline.zeroStockPairCount;
  }
  return candidate.avgEpisodeLength < baseline.avgEpisodeLength;
}

/** Per-(location,commodity) badness, averaged across every seed's own metrics -- ranks Stage 1/3's targeting. */
export interface PairBadness {
  location: string;
  commodity: string;
  avgZeroDays: number;
  avgEpisodeLength: number;
}

/** Ranks every (location, commodity) pair seen across `perSeed` by average zero-stock days (ties broken by average episode length), worst first. */
export function rankWorstPairs(perSeed: readonly WorldMetrics[]): PairBadness[] {
  const byKey = new Map<string, { location: string; commodity: string; zeroDays: number[]; episodeLengths: number[] }>();
  for (const seedMetrics of perSeed) {
    for (const p of seedMetrics.pairs) {
      const key = `${p.location}::${p.commodity}`;
      let entry = byKey.get(key);
      if (entry === undefined) {
        entry = { location: p.location, commodity: p.commodity, zeroDays: [], episodeLengths: [] };
        byKey.set(key, entry);
      }
      entry.zeroDays.push(p.zeroDays);
      entry.episodeLengths.push(mean(p.episodes));
    }
  }
  const ranked: PairBadness[] = [...byKey.values()].map((e) => ({
    location: e.location,
    commodity: e.commodity,
    avgZeroDays: mean(e.zeroDays),
    avgEpisodeLength: mean(e.episodeLengths),
  }));
  ranked.sort((a, b) => b.avgZeroDays - a.avgZeroDays || b.avgEpisodeLength - a.avgEpisodeLength);
  return ranked;
}
