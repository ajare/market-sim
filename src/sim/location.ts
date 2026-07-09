/**
 * Location: a trading hub, and the TerminalType kinds of terminal it can
 * have. Ported from sim/location.py -- see that file's docstring for the
 * full produce/consume/stockpile model this implements.
 */

export type TerminalType = "Port" | "Station" | "Airport" | "Platform";

export interface LocationInit {
  name: string;
  producedCommodities: Record<string, number>;
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  basePrices: Record<string, number>;
  fuelPrice: number;
  terminalTypes: ReadonlySet<TerminalType>;
  fenceFraction?: number;
}

export class Location {
  name: string;
  producedCommodities: Record<string, number>;
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  basePrices: Record<string, number>;
  fuelPrice: number;
  terminalTypes: ReadonlySet<TerminalType>;
  /** Fraction of a commodity's live sell price recovered when stolen goods are fenced here. */
  fenceFraction: number;
  /**
   * The stockpile level a PRODUCED commodity's price is measured against
   * (see referenceStockpile) -- frozen at construction time, since the live
   * `stockpiles` value moves every day via production/consumption/trading.
   */
  private readonly frozenReferenceStockpiles: Record<string, number>;

  constructor(init: LocationInit) {
    this.name = init.name;
    this.producedCommodities = init.producedCommodities;
    this.consumedCommodities = init.consumedCommodities;
    this.stockpiles = init.stockpiles;
    this.minStockpiles = init.minStockpiles;
    this.basePrices = init.basePrices;
    this.fuelPrice = init.fuelPrice;
    this.terminalTypes = init.terminalTypes;
    this.fenceFraction = init.fenceFraction ?? 0.5;

    if (this.terminalTypes.has("Platform") && this.terminalTypes.size > 1) {
      throw new Error(
        `${this.name}: a Platform terminal can't be combined with any other TerminalType, got ` +
          `${[...this.terminalTypes].sort().join(", ")}`,
      );
    }
    const overlap = Object.keys(this.producedCommodities).filter(
      (c) => c in this.consumedCommodities,
    );
    if (overlap.length > 0) {
      throw new Error(
        `${this.name}: a commodity can't be both produced and consumed at the same location, got ` +
          `${overlap.sort().join(", ")}`,
      );
    }
    this.frozenReferenceStockpiles = { ...this.stockpiles };
  }

  /** A Captain can buy here: commodity is produced here and there's stock to sell. */
  canBuy(commodityName: string): boolean {
    return (
      commodityName in this.producedCommodities && (this.stockpiles[commodityName] ?? 0) > 0
    );
  }

  /** A Captain can sell here: commodity is consumed here and the location is running low. */
  canSell(commodityName: string): boolean {
    return (
      commodityName in this.consumedCommodities &&
      (this.stockpiles[commodityName] ?? 0) < (this.minStockpiles[commodityName] ?? 0)
    );
  }

  /**
   * The baseline a commodity's price is measured against: the minimum
   * target for something consumed here, or the frozen starting stockpile
   * for something produced here.
   */
  referenceStockpile(commodityName: string): number {
    if (commodityName in this.consumedCommodities) {
      return this.minStockpiles[commodityName] ?? 0;
    }
    return this.frozenReferenceStockpiles[commodityName] ?? 0;
  }

  /** Apply one day of production/consumption to stockpiles (floored at 0). */
  dailyUpdate(): void {
    for (const commodity of Object.keys(this.producedCommodities)) {
      const rate = this.producedCommodities[commodity];
      this.stockpiles[commodity] = (this.stockpiles[commodity] ?? 0) + rate;
    }
    for (const commodity of Object.keys(this.consumedCommodities)) {
      const rate = this.consumedCommodities[commodity];
      this.stockpiles[commodity] = Math.max(0, (this.stockpiles[commodity] ?? 0) - rate);
    }
  }
}
