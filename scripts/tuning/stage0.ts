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
 */
import { evaluateWorld, type AggregatedResult, type EvalConfig } from "./evaluate";
import { cloneWorldJson, type WorldJson } from "./worldJson";

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

export interface Stage0Result {
  worldJson: WorldJson;
  totalsBefore: CommodityTotals[];
  totalsAfter: CommodityTotals[];
  /** Commodities actually rescaled (had both a producer and a consumer somewhere) -- empty means Stage 0 changed nothing. */
  rescaledCommodities: string[];
  baseline: AggregatedResult;
  final: AggregatedResult;
}

export function runStage0(worldJson: WorldJson, config: EvalConfig, onProgress?: (message: string) => void): Stage0Result {
  const log = onProgress ?? (() => {});
  validateEveryConsumedCommodityIsProduced(worldJson);

  const totalsBefore = computeCommodityTotals(worldJson);
  const current = cloneWorldJson(worldJson);
  const rescaledCommodities: string[] = [];

  for (const t of totalsBefore) {
    // Nothing to balance: a commodity nobody consumes (pure export, or
    // simply unused) has no demand-side target to rescale against, and one
    // nobody produces was already rejected above.
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

  return { worldJson: current, totalsBefore, totalsAfter, rescaledCommodities, baseline, final };
}
