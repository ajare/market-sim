/**
 * Location: a trading hub, and the TerminalType kinds of terminal it can
 * have. Ported from sim/location.py -- see that file's docstring for the
 * full produce/consume/stockpile model this implements.
 */
import {
  CONTRACT_BASE_FEE_RATE, CONTRACT_FEE_ESCALATION_BASE, CONTRACT_QUANTITY_MULTIPLIER,
  CONTRACT_PIRATE_FEE_BOOST_PER_SHIP, MAX_CONTRACT_PIRATE_FEE_BOOST,
  DEFAULT_CONTRACT_EXPIRY_DAYS, contractKey, round2,
  type BulletinBoard, type Contract, type TenderContractsOptions,
} from "./contracts";
import type { PoliticalEntity } from "./politicalEntity";
import { DEFAULT_BASE_CONSUMPTION_RATE, DEFAULT_BASE_PRICE, DEFAULT_BASE_PRODUCTION_RATE } from "./commodity";
// Deferred (not destructured) import -- worldData.ts imports Location, so this
// binding is read lazily via the COMMODITIES getter below, never at this
// module's own top-level evaluation time.
import * as worldData from "./worldData";

export type TerminalType =
  | "Port" | "Wagon yard" | "Airport" | "Platform" | "Spaceport" | "TransitDepot" | "Station";

/** Default multiple of minStockpiles at which a Contract is proactively tendered -- see Location.contractThresholdFraction / needsContractRestock. */
export const DEFAULT_CONTRACT_THRESHOLD_FRACTION = 1.5;

/** Posts Contracts to a BulletinBoard -- see Location.tenderContracts for the only current implementation. */
export class ContractIssuer {
  protected postContract(board: BulletinBoard, contract: Contract): void {
    board.post(contract);
  }
}

export interface LocationInit {
  name: string;
  /** commodity name -> production rate MODIFIER (default 1.0), scaling Commodity.baseProductionRate -- see Location.productionRate. */
  producedCommodities: Record<string, number>;
  /** commodity name -> consumption rate MODIFIER (default 1.0), scaling Commodity.baseConsumptionRate -- see Location.consumptionRate. */
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  /** commodity name -> price MODIFIER (default 1.0), scaling Commodity.basePrice -- see Location.basePrice. */
  basePriceModifiers: Record<string, number>;
  fuelPrice: number;
  terminalTypes: ReadonlySet<TerminalType>;
  fenceFraction?: number;
  /** Starting cash, used only if this Location never joins a PoliticalEntity. Defaults to 10 billion -- see Location.cash. */
  cash?: number;
  /** Contract-tendering threshold, as a multiple of minStockpiles. Defaults to DEFAULT_CONTRACT_THRESHOLD_FRACTION -- see needsContractRestock. */
  contractThresholdFraction?: number;
}

export class Location extends ContractIssuer {
  name: string;
  producedCommodities: Record<string, number>;
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  basePriceModifiers: Record<string, number>;
  fuelPrice: number;
  terminalTypes: ReadonlySet<TerminalType>;
  /** Fraction of a commodity's live sell price recovered when stolen goods are fenced here. */
  fenceFraction: number;
  /** Multiple of minStockpiles at which a Contract is proactively tendered -- see needsContractRestock. */
  contractThresholdFraction: number;
  /** The PoliticalEntity this Location belongs to, if any. Set by PoliticalEntity's constructor, not this one. */
  politicalEntity: PoliticalEntity | null = null;
  private _ownCash: number;
  /**
   * The stockpile level a PRODUCED commodity's price is measured against
   * (see referenceStockpile) -- frozen at construction time, since the live
   * `stockpiles` value moves every day via production/consumption/trading.
   */
  private readonly frozenReferenceStockpiles: Record<string, number>;

  constructor(init: LocationInit) {
    super();
    this.name = init.name;
    this.producedCommodities = init.producedCommodities;
    this.consumedCommodities = init.consumedCommodities;
    this.stockpiles = init.stockpiles;
    this.minStockpiles = init.minStockpiles;
    this.basePriceModifiers = init.basePriceModifiers;
    this.fuelPrice = init.fuelPrice;
    this.terminalTypes = init.terminalTypes;
    this.fenceFraction = init.fenceFraction ?? 0.5;
    this._ownCash = init.cash ?? 10_000_000_000;
    this.contractThresholdFraction = init.contractThresholdFraction ?? DEFAULT_CONTRACT_THRESHOLD_FRACTION;

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

  /**
   * Cash that funds this Location's side of every trade (buy and sell) and
   * its Contract deliveries -- previously an unlimited pool, now finite so a
   * Location can go broke and stop tendering new Contracts. A Location
   * doesn't keep its own balance once it belongs to a PoliticalEntity:
   * reads/writes redirect to that PoliticalEntity's `cash` (mirrors
   * `Captain.cash`'s pooling-vs-own-balance split against a `Faction`); a
   * standalone Location with no PoliticalEntity (e.g. in a hand-built test
   * world) just uses its own.
   */
  get cash(): number {
    if (this.politicalEntity !== null) return this.politicalEntity.cash;
    return this._ownCash;
  }

  set cash(value: number) {
    if (this.politicalEntity !== null) {
      this.politicalEntity.cash = value;
    } else {
      this._ownCash = value;
    }
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

  /** Whether a fresh supply Contract should be tendered for this commodity -- stockpile at or below contractThresholdFraction times its minimum target (proactive, not just an actual deficit like canSell). */
  needsContractRestock(commodityName: string): boolean {
    return (
      commodityName in this.consumedCommodities &&
      (this.stockpiles[commodityName] ?? 0) <=
        (this.minStockpiles[commodityName] ?? 0) * this.contractThresholdFraction
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

  /**
   * This Location's actual units/day production rate for commodityName: the
   * commodity's world-wide baseProductionRate times this Location's own
   * modifier (defaults to 1.0 if the commodity isn't in producedCommodities
   * at all, or falls back to DEFAULT_BASE_PRODUCTION_RATE if the commodity
   * has no registry entry at all -- e.g. a custom world introducing a
   * commodity never registered in worldData.COMMODITIES).
   */
  productionRate(commodityName: string): number {
    const modifier = this.producedCommodities[commodityName] ?? 1.0;
    const commodity = worldData.COMMODITIES[commodityName];
    const baseRate = commodity !== undefined ? commodity.baseProductionRate : DEFAULT_BASE_PRODUCTION_RATE;
    return baseRate * modifier;
  }

  /** This Location's actual units/day consumption rate for commodityName -- mirrors productionRate. */
  consumptionRate(commodityName: string): number {
    const modifier = this.consumedCommodities[commodityName] ?? 1.0;
    const commodity = worldData.COMMODITIES[commodityName];
    const baseRate = commodity !== undefined ? commodity.baseConsumptionRate : DEFAULT_BASE_CONSUMPTION_RATE;
    return baseRate * modifier;
  }

  /**
   * This Location's actual reference price for commodityName: the
   * commodity's world-wide basePrice times this Location's own modifier
   * (defaults to 1.0 if the commodity isn't in basePriceModifiers at all, or
   * falls back to DEFAULT_BASE_PRICE if the commodity has no registry entry
   * at all -- mirrors productionRate/consumptionRate's same fallback).
   */
  basePrice(commodityName: string): number {
    const modifier = this.basePriceModifiers[commodityName] ?? 1.0;
    const commodity = worldData.COMMODITIES[commodityName];
    const base = commodity !== undefined ? commodity.basePrice : DEFAULT_BASE_PRICE;
    return base * modifier;
  }

  /** Apply one day of production/consumption to stockpiles (floored at 0). */
  dailyUpdate(): void {
    for (const commodity of Object.keys(this.producedCommodities)) {
      this.stockpiles[commodity] = (this.stockpiles[commodity] ?? 0) + this.productionRate(commodity);
    }
    for (const commodity of Object.keys(this.consumedCommodities)) {
      this.stockpiles[commodity] = Math.max(0, (this.stockpiles[commodity] ?? 0) - this.consumptionRate(commodity));
    }
  }

  /**
   * Post a fresh one-shot Contract for every consumed commodity that
   * currently needs restocking (`needsContractRestock`), isn't already
   * covered by an active contract (`activeContractKeys`, built by World from
   * both the BulletinBoard and every ContractFulfiller's accepted-but-
   * unfulfilled contracts -- see World.runDay), and while this Location
   * isn't broke (`cash <= 0`). `quantity` is this Location's own
   * minimum-stockpile target times `quantityMultiplier`. `deliveryFee` is
   * `baseFeeRate` of goods value, scaled up by an exponential urgency curve
   * based on how far *below* (not above) the minimum the current stockpile
   * actually is -- flat `baseFeeRate` anywhere in the proactive 100%-150%
   * zone, ramping toward `baseFeeRate * feeEscalationBase` as stock
   * approaches zero -- then further boosted by `pirateCount` pirate ships
   * currently sitting at this Location (see CONTRACT_PIRATE_FEE_BOOST_PER_SHIP),
   * a risk premium baked in once at tender time since deliveryFee is
   * otherwise fixed. Called at the very start of each simulated day (see
   * World.runDay), before Factions act, against whatever
   * `BulletinBoard.prune` left open.
   */
  tenderContracts(
    day: number,
    board: BulletinBoard,
    activeContractKeys: ReadonlySet<string>,
    options: TenderContractsOptions = {},
    pirateCount: number = 0,
  ): void {
    if (this.cash <= 0) return;
    const {
      expiryDays = DEFAULT_CONTRACT_EXPIRY_DAYS,
      baseFeeRate = CONTRACT_BASE_FEE_RATE,
      feeEscalationBase = CONTRACT_FEE_ESCALATION_BASE,
      quantityMultiplier = CONTRACT_QUANTITY_MULTIPLIER,
      pirateFeeBoostPerShip = CONTRACT_PIRATE_FEE_BOOST_PER_SHIP,
      maxContractPirateFeeBoost = MAX_CONTRACT_PIRATE_FEE_BOOST,
    } = options;
    const pirateBoost = 1 + Math.min(maxContractPirateFeeBoost, Math.max(0, pirateCount) * pirateFeeBoostPerShip);

    for (const commodity of Object.keys(this.consumedCommodities)) {
      if (activeContractKeys.has(contractKey(this.name, commodity))) continue;
      if (!this.needsContractRestock(commodity)) continue;

      const minQuantity = this.minStockpiles[commodity] ?? 0;
      if (minQuantity <= 0) continue;
      const quantity = minQuantity * quantityMultiplier;

      const stock = this.stockpiles[commodity] ?? 0;
      const deficitRatio = Math.max(0, Math.min(1, (minQuantity - stock) / minQuantity));
      const feeMultiplier = feeEscalationBase ** deficitRatio;

      const basePrice = this.basePrice(commodity);
      const deliveryFee = round2(quantity * basePrice * baseFeeRate * feeMultiplier * pirateBoost);

      const contract: Contract = {
        location: this.name,
        commodity,
        type: "Commodity",
        quantity,
        deliveryFee,
        fulfiller: null,
        inFlightCaptain: null,
        fulfilled: false,
        cancelled: false,
        beginDay: day,
        expiryDay: day + expiryDays,
      };
      this.postContract(board, contract);
    }
  }
}
