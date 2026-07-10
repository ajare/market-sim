import type { MarketRecord } from "../sim/markets";

/** Pirate discount/premium baked into a MarketRecord's price (see Market.pirateMultiplier / World.runDay). Null when there's no pirate effect to call out. */
export function pirateNote(rec: MarketRecord | undefined): string | null {
  if (rec === undefined || rec.pirateCount === 0) return null;
  const pct = Math.round(Math.abs(rec.pirateMultiplier - 1) * 100);
  const sign = rec.pirateMultiplier < 1 ? "-" : "+";
  return `${rec.pirateCount} pirates: ${sign}${pct}%`;
}
