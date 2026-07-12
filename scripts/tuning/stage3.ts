/**
 * Stage 3: for pairs still bad after Stages 1-2, swap two Locations'
 * produced-commodity assignments so the needed commodity ends up nearer its
 * consumer -- the farthest current producer of the needed commodity trades
 * away that production to whichever eligible Location is nearest the
 * consumer, in exchange for one of that nearer Location's own produced
 * commodities (so nothing is lost, only relocated). A trial swap is kept
 * only if it's a net improvement across the WHOLE world (it could easily
 * create a new shortage for the commodity given up in exchange) -- rejected
 * swaps are rolled back.
 *
 * Bounded to a handful of trial (candidate Location, commodity given up)
 * combinations per targeted pair, since each trial is a full multi-seed
 * evaluation.
 */
import { evaluateWorld, isImprovement, rankWorstPairs, type AggregatedResult, type EvalConfig } from "./evaluate";
import { cloneWorldJson, type WorldJson, type WorldJsonLocation } from "./worldJson";

const MAX_CANDIDATE_LOCATIONS = 5;
const MAX_COMMODITIES_PER_CANDIDATE = 3;

export interface SwapChange {
  commodity: string;
  fromLocation: string;
  toLocation: string;
  inExchangeFor: string;
}

export interface Stage3Result {
  worldJson: WorldJson;
  baseline: AggregatedResult;
  final: AggregatedResult;
  changes: SwapChange[];
}

function distance(a: WorldJsonLocation, b: WorldJsonLocation): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Moves `commodity`'s produced-commodity entry (modifier/stockpile/basePriceModifier) from `from` to `to`, in place. */
function moveProducedCommodity(from: WorldJsonLocation, to: WorldJsonLocation, commodity: string): void {
  to.producedCommodities[commodity] = from.producedCommodities[commodity];
  to.stockpiles[commodity] = from.stockpiles[commodity];
  to.basePriceModifiers[commodity] = from.basePriceModifiers[commodity] ?? 1;
  delete from.producedCommodities[commodity];
  delete from.stockpiles[commodity];
  delete from.basePriceModifiers[commodity];
}

export function runStage3(
  worldJson: WorldJson,
  config: EvalConfig,
  ratioTolerance: number,
  topN: number,
  onProgress?: (message: string) => void,
): Stage3Result {
  const log = onProgress ?? (() => {});
  let current = cloneWorldJson(worldJson);
  let baseline = evaluateWorld(current, config);
  const initialBaseline = baseline;
  const changes: SwapChange[] = [];
  const attempted = new Set<string>();

  // Bounded by pairs ATTEMPTED, not accepted -- same reasoning as stage1.ts.
  while (attempted.size < topN) {
    const worst = rankWorstPairs(baseline.perSeed).find(
      (p) => p.avgZeroDays > 0 && !attempted.has(`${p.location}::${p.commodity}`),
    );
    if (worst === undefined) break;
    attempted.add(`${worst.location}::${worst.commodity}`);

    const consumer = current.locations.find((l) => l.name === worst.location);
    if (consumer === undefined) continue;
    const commodity = worst.commodity;

    const producers = current.locations.filter((l) => commodity in l.producedCommodities);
    if (producers.length === 0) {
      log(`Stage 3: ${worst.location} / ${commodity} has no producer anywhere -- skipping.`);
      continue;
    }
    const farthest = producers.reduce((a, b) => (distance(consumer, a) >= distance(consumer, b) ? a : b));

    const candidates = current.locations
      .filter((l) => l.name !== consumer.name && l.name !== farthest.name)
      .filter((l) => !(commodity in l.producedCommodities) && !(commodity in l.consumedCommodities))
      .filter((l) => Object.keys(l.producedCommodities).length > 0)
      .sort((a, b) => distance(consumer, a) - distance(consumer, b))
      .slice(0, MAX_CANDIDATE_LOCATIONS);

    log(`Stage 3: ${worst.location} / ${commodity} -- farthest producer ${farthest.name}, ${candidates.length} candidate(s) to try.`);

    let applied = false;
    for (const candidate of candidates) {
      const swappable = Object.keys(candidate.producedCommodities).slice(0, MAX_COMMODITIES_PER_CANDIDATE);
      for (const givenUp of swappable) {
        if (givenUp in farthest.consumedCommodities || givenUp in farthest.producedCommodities) continue;

        const trial = cloneWorldJson(current);
        const trialFarthest = trial.locations.find((l) => l.name === farthest.name)!;
        const trialCandidate = trial.locations.find((l) => l.name === candidate.name)!;
        moveProducedCommodity(trialFarthest, trialCandidate, commodity);
        moveProducedCommodity(trialCandidate, trialFarthest, givenUp);

        const trialResult = evaluateWorld(trial, config);
        if (isImprovement(baseline, trialResult, ratioTolerance)) {
          current = trial;
          baseline = trialResult;
          changes.push({ commodity, fromLocation: farthest.name, toLocation: candidate.name, inExchangeFor: givenUp });
          log(`  -> swapped: ${candidate.name} now produces ${commodity} (was ${farthest.name}'s), gave up ${givenUp} to ${farthest.name}`);
          applied = true;
          break;
        }
      }
      if (applied) break;
    }
    if (!applied) log(`  -> no improving swap found for ${worst.location} / ${commodity}`);
  }

  return { worldJson: current, baseline: initialBaseline, final: baseline, changes };
}
