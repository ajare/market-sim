/**
 * Stage 0: world-wide commodity balance. Before any of the targeted local
 * searches (stage1.ts etc.), rescale every commodity's producedCommodities/
 * consumedCommodities modifiers toward the midpoint of its total world
 * production and consumption -- the same rebalancing worldData.ts's
 * generateLocations does for a freshly-generated procedural world (see its
 * Pass 2), just applied here to an already-authored World JSON instead.
 *
 * Applied unconditionally (not accept/reject like the other stages): this is
 * a direct analytical correction toward a well-defined target (supply ==
 * demand), not a heuristic search, so there's no "candidate" to evaluate
 * against a baseline first. The report still shows before/after simulated
 * metrics for transparency.
 *
 * A commodity that's consumed somewhere but produced nowhere can never be
 * balanced (the produce-side scale factor would be a division by zero) --
 * validateEveryConsumedCommodityIsProduced throws immediately in that case,
 * before any simulation runs at all.
 *
 * The mirror case -- produced somewhere but consumed nowhere -- IS fixable
 * (unlike the throw above, there's no division-by-zero forcing a hard
 * failure): a Captain could buy it forever and never have anywhere to sell
 * it (see Location.canSell), so ensureEveryProducedCommodityHasConsumer adds
 * a consumer at the Location nearest that commodity's producers before the
 * balance pass runs, the same way Stage 4 adds a producer for a shortage.
 */
import { evaluateWorld, type AggregatedResult, type EvalConfig } from "./evaluate";
import { cloneWorldJson, type WorldJson, type WorldJsonLocation } from "./worldJson";

export interface CommodityTotals {
  commodity: string;
  /** Sum, across every producing Location, of commodity.productionRate * that Location's producedCommodities modifier. */
  totalProduced: number;
  /** Sum, across every consuming Location, of commodity.consumptionRate * that Location's consumedCommodities modifier. */
  totalConsumed: number;
}

/** Rounds to 4 decimal places -- repeated scaling otherwise leaves float noise in the written-out modifiers. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function distance(a: WorldJsonLocation, b: WorldJsonLocation): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Days of consumption a new consumer's minStockpile target represents -- mirrors worldData.ts's DEFAULT_MIN_STOCKPILE_DAYS. */
const NEW_CONSUMER_MIN_STOCKPILE_DAYS = 14;
/** Multiple of minStockpile a new consumer starts with -- mirrors worldData.ts's DEFAULT_CONSUMED_STOCKPILE_FACTOR. */
const NEW_CONSUMER_STOCKPILE_FACTOR = 2.0;

export interface AddedConsumerChange {
  commodity: string;
  nearestProducerLocation: string;
  newConsumerLocation: string;
}

/** World-wide production/consumption totals for every commodity in worldJson.commodities (0/0 for one nobody produces or consumes at all). */
export function computeCommodityTotals(worldJson: WorldJson): CommodityTotals[] {
  const rates = new Map(worldJson.commodities.map((c) => [c.name, c]));
  const totals = new Map<string, CommodityTotals>();
  for (const name of rates.keys()) totals.set(name, { commodity: name, totalProduced: 0, totalConsumed: 0 });

  for (const loc of worldJson.locations) {
    for (const [commodity, modifier] of Object.entries(loc.producedCommodities)) {
      const rate = rates.get(commodity);
      const entry = totals.get(commodity);
      if (rate === undefined || entry === undefined) continue;
      entry.totalProduced += rate.productionRate * modifier;
    }
    for (const [commodity, modifier] of Object.entries(loc.consumedCommodities)) {
      const rate = rates.get(commodity);
      const entry = totals.get(commodity);
      if (rate === undefined || entry === undefined) continue;
      entry.totalConsumed += rate.consumptionRate * modifier;
    }
  }
  return [...totals.values()];
}

/** Throws if any commodity is consumed by at least one Location but produced by none -- such a commodity can never be balanced (and never satisfied by any fleet, no matter how tuned). */
export function validateEveryConsumedCommodityIsProduced(worldJson: WorldJson): void {
  const unproducible = computeCommodityTotals(worldJson)
    .filter((t) => t.totalConsumed > 0 && t.totalProduced <= 0)
    .map((t) => t.commodity);
  if (unproducible.length > 0) {
    throw new Error(
      `The following commodities are consumed somewhere but produced nowhere in this World: ${unproducible.join(", ")}. ` +
        "Every consumed commodity needs at least one producing Location.",
    );
  }
}

/**
 * For every commodity produced somewhere but consumed nowhere, adds a
 * consumer at the Location nearest that commodity's producers (excluding any
 * Location that already produces or consumes it, same constraint Location's
 * constructor enforces) -- given a neutral modifier of 1 and a
 * minStockpile/stockpile sized off its consumptionRate, matching the defaults
 * a freshly-generated procedural world would use. Mutates `current` in
 * place; returns what it added so the balance pass below picks the newly-
 * consumed commodity up too, and so the report can show it.
 */
function ensureEveryProducedCommodityHasConsumer(
  current: WorldJson,
  totals: CommodityTotals[],
  log: (message: string) => void,
): AddedConsumerChange[] {
  const commodityRates = new Map(current.commodities.map((c) => [c.name, c]));
  const changes: AddedConsumerChange[] = [];

  for (const t of totals) {
    if (t.totalProduced <= 0 || t.totalConsumed > 0) continue;

    const producers = current.locations.filter((l) => t.commodity in l.producedCommodities);
    if (producers.length === 0) continue; // unreachable: totalProduced > 0 implies at least one producer.

    const candidate = current.locations
      .filter((l) => !(t.commodity in l.producedCommodities) && !(t.commodity in l.consumedCommodities))
      .sort(
        (a, b) =>
          Math.min(...producers.map((p) => distance(a, p))) - Math.min(...producers.map((p) => distance(b, p))),
      )[0];
    if (candidate === undefined) {
      log(`Stage 0: ${t.commodity} is produced but consumed nowhere, and no eligible Location is free to add as a consumer -- skipping.`);
      continue;
    }

    const rate = commodityRates.get(t.commodity);
    const minStockpile = round4((rate?.consumptionRate ?? 0) * NEW_CONSUMER_MIN_STOCKPILE_DAYS);
    candidate.consumedCommodities[t.commodity] = 1;
    candidate.minStockpiles[t.commodity] = minStockpile;
    candidate.stockpiles[t.commodity] = round4(minStockpile * NEW_CONSUMER_STOCKPILE_FACTOR);
    if (candidate.basePriceModifiers[t.commodity] === undefined) candidate.basePriceModifiers[t.commodity] = 1;

    const nearestProducer = producers.reduce((a, b) => (distance(candidate, a) <= distance(candidate, b) ? a : b));
    changes.push({ commodity: t.commodity, nearestProducerLocation: nearestProducer.name, newConsumerLocation: candidate.name });
    log(
      `Stage 0: ${t.commodity} was produced but consumed nowhere -- added ${candidate.name} as a consumer ` +
        `(nearest producer: ${nearestProducer.name}).`,
    );
  }

  return changes;
}

export interface Stage0Result {
  worldJson: WorldJson;
  totalsBefore: CommodityTotals[];
  totalsAfter: CommodityTotals[];
  /** Commodities actually rescaled (had both a producer and a consumer somewhere, after addedConsumers filled any gap) -- empty means Stage 0 changed nothing. */
  rescaledCommodities: string[];
  /** Locations added as a first-ever consumer for a produced-but-unconsumed commodity -- see ensureEveryProducedCommodityHasConsumer. */
  addedConsumers: AddedConsumerChange[];
  baseline: AggregatedResult;
  final: AggregatedResult;
}

export function runStage0(worldJson: WorldJson, config: EvalConfig, onProgress?: (message: string) => void): Stage0Result {
  const log = onProgress ?? (() => {});
  validateEveryConsumedCommodityIsProduced(worldJson);

  const totalsBefore = computeCommodityTotals(worldJson);
  const current = cloneWorldJson(worldJson);
  const addedConsumers = ensureEveryProducedCommodityHasConsumer(current, totalsBefore, log);
  const rescaledCommodities: string[] = [];

  for (const t of computeCommodityTotals(current)) {
    // Nothing to balance: a commodity nobody produces was already rejected
    // above, and one nobody consumes has no demand-side target to rescale
    // against -- only reachable here if ensureEveryProducedCommodityHasConsumer
    // couldn't find an eligible Location to add as its consumer.
    if (t.totalProduced <= 0 || t.totalConsumed <= 0) continue;
    rescaledCommodities.push(t.commodity);

    const target = (t.totalProduced + t.totalConsumed) / 2;
    const produceScale = target / t.totalProduced;
    const consumeScale = target / t.totalConsumed;
    log(
      `Stage 0: ${t.commodity} -- produced ${t.totalProduced.toFixed(2)}/day, consumed ${t.totalConsumed.toFixed(2)}/day ` +
        `-> scaling producers x${produceScale.toFixed(3)}, consumers x${consumeScale.toFixed(3)}`,
    );

    for (const loc of current.locations) {
      if (t.commodity in loc.producedCommodities) {
        loc.producedCommodities[t.commodity] = round4(loc.producedCommodities[t.commodity] * produceScale);
      }
      if (t.commodity in loc.consumedCommodities) {
        loc.consumedCommodities[t.commodity] = round4(loc.consumedCommodities[t.commodity] * consumeScale);
      }
    }
  }

  const totalsAfter = computeCommodityTotals(current);
  const baseline = evaluateWorld(worldJson, config);
  const final = evaluateWorld(current, config);

  return { worldJson: current, totalsBefore, totalsAfter, rescaledCommodities, addedConsumers, baseline, final };
}
