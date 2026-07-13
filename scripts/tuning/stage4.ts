/**
 * Stage 4: final deterministic cleanup -- for every (Location, commodity)
 * pair that still records ANY zero-stock day after Stage 3, add production
 * of that commodity at the nearest Location that doesn't already produce
 * (or consume -- Location's constructor forbids both at once) it, then
 * rescale every producer's modifier -- the new one included -- so the
 * commodity's world-wide total produced amount is unchanged: this only
 * relocates supply nearer the shortage, it never inflates it. Every producer
 * (old and new alike) ends up with an equal 1/(n+1) share of the ORIGINAL
 * n-producer total, which is the simplest split that preserves the total
 * exactly without favoring any one producer.
 *
 * Applied unconditionally per pair (not accept/reject like Stages 1-3): a
 * total-preserving addition can't create a new shortage elsewhere for this
 * commodity, so there's no candidate to weigh against a baseline -- same
 * reasoning as Stage 0. The report still shows before/after simulated
 * metrics for transparency.
 *
 * Every (location, commodity) pair with any zero-stock days is targeted --
 * not just the topN worst like Stages 1/3 -- since this step is O(1)
 * analytical work per pair (no trial re-simulation), unlike those stages'
 * expensive multi-seed trials.
 */
import { evaluateWorld, rankWorstPairs, type AggregatedResult, type EvalConfig } from "./evaluate";
import { cloneWorldJson, type WorldJson, type WorldJsonLocation } from "./worldJson";

/** Days of production held as a new producer's starting stockpile buffer -- the midpoint of worldData.ts's generateLocations' own 10-25 day range for a freshly-generated producer. */
const NEW_PRODUCER_STOCKPILE_DAYS = 15;

export interface AddProducerChange {
  commodity: string;
  consumerLocation: string;
  newProducerLocation: string;
  producerModifier: number;
  rebalancedProducers: string[];
}

export interface Stage4Result {
  worldJson: WorldJson;
  baseline: AggregatedResult;
  final: AggregatedResult;
  changes: AddProducerChange[];
}

/** Rounds to 4 decimal places -- matches Stage 0/1's own rounding, keeping repeated rescaling from leaving float noise in the written-out modifiers. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function distance(a: WorldJsonLocation, b: WorldJsonLocation): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mean(xs: readonly number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function runStage4(
  worldJson: WorldJson,
  config: EvalConfig,
  onProgress?: (message: string) => void,
): Stage4Result {
  const log = onProgress ?? (() => {});
  const current = cloneWorldJson(worldJson);
  const baseline = evaluateWorld(current, config);
  const changes: AddProducerChange[] = [];
  const commodityRates = new Map(current.commodities.map((c) => [c.name, c]));

  const zeroDayPairs = rankWorstPairs(baseline.perSeed).filter((p) => p.avgZeroDays > 0);
  if (zeroDayPairs.length === 0) {
    log("Stage 4: no (Location, commodity) pair has any zero-stock days -- nothing to do.");
    return { worldJson: current, baseline, final: baseline, changes };
  }

  for (const pair of zeroDayPairs) {
    const consumer = current.locations.find((l) => l.name === pair.location);
    if (consumer === undefined) continue;
    const commodity = pair.commodity;

    const candidate = current.locations
      .filter((l) => l.name !== consumer.name)
      .filter((l) => !(commodity in l.producedCommodities) && !(commodity in l.consumedCommodities))
      .sort((a, b) => distance(consumer, a) - distance(consumer, b))[0];
    if (candidate === undefined) {
      log(`Stage 4: ${pair.location} / ${commodity} -- no eligible nearby Location to add as a producer, skipping.`);
      continue;
    }

    const producers = current.locations.filter((l) => commodity in l.producedCommodities);
    const rate = commodityRates.get(commodity);

    if (producers.length === 0) {
      // Nothing to rebalance against -- Stage 0 already guarantees every
      // CONSUMED commodity has a producer somewhere, so this is unreachable
      // in practice, but give the new producer a neutral modifier rather
      // than throw.
      candidate.producedCommodities[commodity] = 1;
      candidate.basePriceModifiers[commodity] = 1;
      candidate.stockpiles[commodity] = rate !== undefined ? round4(rate.productionRate * NEW_PRODUCER_STOCKPILE_DAYS) : 0;
      changes.push({
        commodity, consumerLocation: pair.location, newProducerLocation: candidate.name,
        producerModifier: 1, rebalancedProducers: [],
      });
      log(`Stage 4: ${pair.location} / ${commodity} had no producer anywhere -- added ${candidate.name} as its first producer.`);
      continue;
    }

    // Every producer (old and new) ends up with an equal 1/(n+1) share of
    // the ORIGINAL n-producer total, so the total is exactly preserved.
    const originalSum = producers.reduce((sum, p) => sum + p.producedCommodities[commodity], 0);
    const share = round4(originalSum / (producers.length + 1));
    const scale = producers.length / (producers.length + 1);
    for (const p of producers) {
      p.producedCommodities[commodity] = round4(p.producedCommodities[commodity] * scale);
    }
    candidate.producedCommodities[commodity] = share;
    candidate.basePriceModifiers[commodity] = round4(
      mean(producers.map((p) => p.basePriceModifiers[commodity] ?? 1)),
    );
    candidate.stockpiles[commodity] =
      rate !== undefined ? round4(rate.productionRate * share * NEW_PRODUCER_STOCKPILE_DAYS) : 0;

    changes.push({
      commodity, consumerLocation: pair.location, newProducerLocation: candidate.name,
      producerModifier: share, rebalancedProducers: producers.map((p) => p.name),
    });
    log(
      `Stage 4: ${pair.location} / ${commodity} -- added ${candidate.name} as a producer (modifier ${share}), ` +
        `rebalanced ${producers.length} existing producer(s) to hold the world-wide total steady.`,
    );
  }

  const final = evaluateWorld(current, config);
  return { worldJson: current, baseline, final, changes };
}
