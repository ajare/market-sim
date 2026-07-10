/**
 * Per-(location, commodity, side) Market: stockpile-driven pricing and the
 * day-to-day price update. Ported from sim/markets.py.
 */
import { COMMODITIES } from "./worldData";
import { DEFAULT_PRICE_SENSITIVITY, DEFAULT_DEFICIT_PRICE_BOOST, DEFAULT_EXCESS_PRICE_BOOST } from "./commodity";
import { MarketEvent } from "./events";
import type { Location } from "./location";
import { randRandom, randChoice, randGauss } from "./simRandom";

export type MarketSide = "buy" | "sell";

/**
 * Per-pirate-ship price effect at a Location: each pirate ship currently
 * AtLocation nudges buy prices down and sell prices up by this fraction,
 * capped at MAX_PIRATE_PRICE_EFFECT -- a busier pirate anchorage scares off
 * competing buyers (cheaper to buy) and competing sellers (more profitable
 * to sell), same direction a real risk premium would push local trade.
 */
export const PIRATE_PRICE_EFFECT_PER_SHIP = 0.03;
export const MAX_PIRATE_PRICE_EFFECT = 0.5;

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
  pirateCount: number;
  pirateMultiplier: number;
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
    eventProbability: number = 0.01,
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

  /** 1 - effect on the buy side (cheaper), 1 + effect on the sell side (more profitable) -- see PIRATE_PRICE_EFFECT_PER_SHIP. */
  private pirateMultiplier(pirateCount: number): number {
    if (pirateCount <= 0) return 1;
    const effect = Math.min(MAX_PIRATE_PRICE_EFFECT, pirateCount * PIRATE_PRICE_EFFECT_PER_SHIP);
    return this.side === "buy" ? 1 - effect : 1 + effect;
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
    // Consumer deficit boost (sell markets): the boost kicks in early, once
    // stock falls below 1.3x the reference level, not just once it's a true
    // deficit (below 1x). boostProgress is 0 right at that 1.3x threshold and
    // rises to 1 as the stockpile is drawn down to zero, so raising the boost
    // to that power ramps sensitivity up an exponential curve -- flat (no
    // boost) at 1.3x the reference, full deficitPriceBoost only once truly out
    // of stock. Deviation is positive here, so a higher sensitivity means a
    // higher buy-price -- luring traders to deliver into the shortage.
    const deficitThreshold = 1.3 * reference;
    if (current < deficitThreshold && this.side === "sell") {
      const boostProgress = Math.max(0, Math.min(1, (deficitThreshold - current) / deficitThreshold));
      const boost = commodity !== undefined ? commodity.deficitPriceBoost : DEFAULT_DEFICIT_PRICE_BOOST;
      sensitivity *= Math.pow(boost, boostProgress);
    }

    // Producer excess boost (buy markets): the mirror of the deficit boost.
    // As a producer's stock climbs ABOVE its reference (normal) level, drop
    // the sell-price along an exponential curve so traders are drawn to buy up
    // the surplus. excessProgress is 0 right at the reference and rises to 1 as
    // stock reaches 3x the reference -- the point the deviation itself
    // saturates at -2. Deviation is negative here, so a higher sensitivity
    // means a lower (steeper-discounted) buy-price.
    const excessCeiling = 3 * reference;
    if (current > reference && this.side === "buy") {
      const excessProgress = Math.min(1, (current - reference) / (excessCeiling - reference));
      const boost = commodity !== undefined ? commodity.excessPriceBoost : DEFAULT_EXCESS_PRICE_BOOST;
      sensitivity *= Math.pow(boost, excessProgress);
    }
    return Math.max(0.5, this.basePrice * (1 + sensitivity * deviation));
  }

  simulateDay(day: number, isOpen: boolean = true, pirateCount: number = 0): MarketRecord {
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
        pirateCount: 0,
        pirateMultiplier: 1.0,
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
        pirateCount: 0,
        pirateMultiplier: 1.0,
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
    const pirateMult = this.pirateMultiplier(pirateCount);

    let newPrice = this.stockpilePrice() * (demandMult / supplyMult) * pirateMult;
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
      pirateCount,
      pirateMultiplier: round2(pirateMult),
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
