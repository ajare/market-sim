/**
 * Per-(location, commodity, side) Market: stockpile-driven pricing and the
 * day-to-day price update. Ported from sim/markets.py.
 */
import { COMMODITIES } from "./worldData";
import { DEFAULT_PRICE_SENSITIVITY, DEFAULT_DEFICIT_PRICE_BOOST } from "./commodity";
import { MarketEvent } from "./events";
import type { Location } from "./location";
import { randRandom, randChoice, randGauss } from "./simRandom";

export type MarketSide = "buy" | "sell";

/** Composite key standing in for Python's `(location, commodity)` tuple dict key. */
export function marketKey(location: string, commodity: string): string {
  return `${location}::${commodity}`;
}

export interface MarketRecord {
  day: number;
  location: string;
  commodity: string;
  side: MarketSide;
  price: number;
  stockpile: number;
  referenceStockpile: number;
  volumeTraded: number;
  demandMultiplier: number;
  supplyMultiplier: number;
  activeEvents: string;
  newEvent: string;
  closed: boolean;
}

export class Market {
  commodityName: string;
  locationName: string;
  location: Location;
  side: MarketSide;
  price: number;
  basePrice: number;
  eventProbability: number;
  fixedPrice: boolean;
  activeEvents: MarketEvent[] = [];
  history: MarketRecord[] = [];
  lastTriggeredEvent: MarketEvent | null = null;
  private volumeTradedToday = 0.0;

  constructor(
    commodityName: string,
    locationName: string,
    location: Location,
    startingPrice: number,
    basePrice: number,
    side: MarketSide,
    eventProbability: number = 0.1,
    fixedPrice: boolean = false,
  ) {
    this.commodityName = commodityName;
    this.locationName = locationName;
    this.location = location;
    this.side = side;
    this.price = startingPrice;
    this.basePrice = basePrice;
    this.eventProbability = eventProbability;
    this.fixedPrice = fixedPrice;
  }

  get isAvailable(): boolean {
    if (this.fixedPrice) return true;
    return this.side === "buy"
      ? this.location.canBuy(this.commodityName)
      : this.location.canSell(this.commodityName);
  }

  get availableQuantity(): number {
    if (this.side === "buy" && !this.fixedPrice) {
      return this.location.stockpiles[this.commodityName] ?? 0.0;
    }
    return Infinity;
  }

  applyTrade(quantity: number): void {
    if (this.fixedPrice) return;
    if (this.side === "buy") {
      this.location.stockpiles[this.commodityName] = Math.max(
        0.0,
        (this.location.stockpiles[this.commodityName] ?? 0.0) - quantity,
      );
    } else {
      this.location.stockpiles[this.commodityName] =
        (this.location.stockpiles[this.commodityName] ?? 0.0) + quantity;
    }
    this.volumeTradedToday += quantity;
  }

  private currentMultipliers(): [number, number] {
    let demandMult = 1.0;
    let supplyMult = 1.0;
    for (const event of this.activeEvents) {
      demandMult *= event.demandMultiplier;
      supplyMult *= event.supplyMultiplier;
    }
    return [demandMult, supplyMult];
  }

  applyEvent(event: MarketEvent): void {
    if (this.fixedPrice) return;
    this.activeEvents.push(event);
  }

  private maybeTriggerLocalEvent(): MarketEvent | null {
    if (randRandom() >= this.eventProbability) return null;
    const commodity = COMMODITIES[this.commodityName];
    if (commodity === undefined || commodity.eventTemplates.length === 0) return null;
    const template = randChoice(commodity.eventTemplates);
    const event = new MarketEvent({ ...template, location: this.locationName, commodity: this.commodityName });
    this.applyEvent(event);
    return event;
  }

  private updateEvents(): void {
    this.activeEvents = this.activeEvents.filter((e) => e.tick());
  }

  private stockpilePrice(): number {
    const reference = this.location.referenceStockpile(this.commodityName);
    if (reference <= 0) return this.basePrice;
    const current = this.location.stockpiles[this.commodityName] ?? 0.0;
    const deviation = Math.max(-2.0, Math.min(2.0, (reference - current) / reference));
    const commodity = COMMODITIES[this.commodityName];
    let sensitivity = commodity !== undefined ? commodity.priceSensitivity : DEFAULT_PRICE_SENSITIVITY;
    if (deviation > 0 && this.side === "sell") {
      const boost = commodity !== undefined ? commodity.deficitPriceBoost : DEFAULT_DEFICIT_PRICE_BOOST;
      sensitivity *= boost;
    }
    return Math.max(0.5, this.basePrice * (1 + sensitivity * deviation));
  }

  simulateDay(day: number, isOpen: boolean = true): MarketRecord {
    this.lastTriggeredEvent = null;

    if (this.fixedPrice) {
      const record: MarketRecord = {
        day,
        location: this.locationName,
        commodity: this.commodityName,
        side: this.side,
        price: round2(this.price),
        stockpile: 0.0,
        referenceStockpile: 0.0,
        volumeTraded: round2(this.volumeTradedToday),
        demandMultiplier: 0.0,
        supplyMultiplier: 0.0,
        activeEvents: "",
        newEvent: "",
        closed: !isOpen,
      };
      this.history.push(record);
      this.volumeTradedToday = 0.0;
      return record;
    }

    if (!isOpen) {
      const record: MarketRecord = {
        day,
        location: this.locationName,
        commodity: this.commodityName,
        side: this.side,
        price: round2(this.price),
        stockpile: round2(this.location.stockpiles[this.commodityName] ?? 0.0),
        referenceStockpile: round2(this.location.referenceStockpile(this.commodityName)),
        volumeTraded: round2(this.volumeTradedToday),
        demandMultiplier: 0.0,
        supplyMultiplier: 0.0,
        activeEvents: this.activeEvents.map((e) => e.name).join(", "),
        newEvent: "",
        closed: true,
      };
      this.history.push(record);
      this.updateEvents();
      this.volumeTradedToday = 0.0;
      return record;
    }

    const triggeredEvent = this.maybeTriggerLocalEvent();
    if (triggeredEvent !== null) {
      triggeredEvent.day = day;
      this.lastTriggeredEvent = triggeredEvent;
    }
    const [demandMult, supplyMult] = this.currentMultipliers();

    let newPrice = this.stockpilePrice() * (demandMult / supplyMult);
    const noise = randGauss(0, 0.01);
    newPrice *= 1 + noise;
    newPrice = Math.max(0.5, newPrice);

    const record: MarketRecord = {
      day,
      location: this.locationName,
      commodity: this.commodityName,
      side: this.side,
      price: round2(this.price),
      stockpile: round2(this.location.stockpiles[this.commodityName] ?? 0.0),
      referenceStockpile: round2(this.location.referenceStockpile(this.commodityName)),
      volumeTraded: round2(this.volumeTradedToday),
      demandMultiplier: round2(demandMult),
      supplyMultiplier: round2(supplyMult),
      activeEvents: this.activeEvents.map((e) => e.name).join(", "),
      newEvent: triggeredEvent !== null ? triggeredEvent.name : "",
      closed: false,
    };
    this.history.push(record);

    this.price = newPrice;
    this.updateEvents();
    this.volumeTradedToday = 0.0;

    return record;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
