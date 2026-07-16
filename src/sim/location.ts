/**
 * Location: a trading hub, and the TerminalType kinds of terminal it can
 * have. Ported from sim/location.py -- see that file's docstring for the
 * full produce/consume/stockpile model this implements.
 */
import {
  CONTRACT_BASE_FEE_RATE, CONTRACT_FEE_ESCALATION_BASE, CONTRACT_QUANTITY_MULTIPLIER,
  CONTRACT_PIRATE_FEE_BOOST_PER_SHIP, MAX_CONTRACT_PIRATE_FEE_BOOST,
  DEFAULT_CONTRACT_EXPIRY_DAYS, contractKey,
  type BulletinBoard, type Contract, type TenderContractsOptions,
} from "./contracts";
import type { PoliticalEntity } from "./politicalEntity";
import { round2 } from "./utils";
import { DEFAULT_BASE_CONSUMPTION_RATE, DEFAULT_BASE_PRICE, DEFAULT_BASE_PRODUCTION_RATE } from "./commodity";
// Deferred (not destructured) import -- worldData.ts imports Location, so this
// binding is read lazily via the COMMODITIES getter below, never at this
// module's own top-level evaluation time.
import * as worldData from "./worldData";
// Imported AND re-exported so every existing `from "./location"` import of
// TerminalType keeps working -- the type itself now lives in @market-sim/shared.
import type { TerminalType } from "@market-sim/shared/terminal";
export type { TerminalType };
import type { Chieftain } from "./chieftain";
// Imported AND re-exported so every existing `from "./location"` import of
// SettlementType keeps working -- the type itself now lives in @market-sim/shared
// (shared with the editor, see editor/src/types.ts).
import type { SettlementType } from "@market-sim/shared/settlement";
export type { SettlementType };

/** Default multiple of minStockpiles at which a Contract is proactively tendered -- see Location.contractThresholdFraction / needsContractRestock. */
export const DEFAULT_CONTRACT_THRESHOLD_FRACTION = 1.5;

/** Discount applied to a produced commodity's selling price once its stockpile has sat at maxStockpile for more than MAX_STOCKPILE_DISCOUNT_STREAK_DAYS days -- see Location.updateDiscount. */
export const MAX_STOCKPILE_DISCOUNT = 0.2;
/** Consecutive days a produced commodity's stockpile must sit at (or below, to remove) maxStockpile before its discount toggles -- see Location.updateDiscount. */
export const MAX_STOCKPILE_DISCOUNT_STREAK_DAYS = 3;

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
  /** Settlement scale -- defaults to "Town" so every existing Location (none of which pass this) keeps its current classification/behavior. */
  settlementType?: SettlementType;
  /** This Location's personal ruler, if any (e.g. a native village's chieftain) -- see the class field's own doc comment for the ruler/PoliticalEntity fallback chain. */
  ruler?: Chieftain | null;
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
  /**
   * Per-produced-commodity discount, as a fraction of the final price this
   * Location sells that commodity for -- 0 (no discount) for every produced
   * commodity when a World is created or loaded. See discount()/setDiscount().
   */
  discounts: Record<string, number>;
  /** Fraction of a commodity's live sell price recovered when stolen goods are fenced here. */
  fenceFraction: number;
  /** Multiple of minStockpiles at which a Contract is proactively tendered -- see needsContractRestock. */
  contractThresholdFraction: number;
  /** The PoliticalEntity this Location belongs to, if any. Set by PoliticalEntity's constructor, not this one. */
  politicalEntity: PoliticalEntity | null = null;
  /** Settlement scale (Native village/Settlement/Town/Outpost) -- orthogonal to terminalTypes (what transport can connect here), purely a scale/presentation classification. */
  settlementType: SettlementType;
  /**
   * This Location's personal ruler, if any -- e.g. a native village's
   * chieftain. Diplomacy decisions (passage tax, gifts, etc.) read
   * `location.ruler ?? location.politicalEntity`: a present ruler's own
   * authority takes precedence over the owning PoliticalEntity (native rule
   * doesn't work like Western institutional politics -- see
   * doc/ExploreGameIntegration.md). Null for every Location without a
   * personally-ruling ally/chieftain (i.e. every Location today).
   */
  ruler: Chieftain | null;
  private _ownCash: number;
  /**
   * The stockpile level a PRODUCED commodity's price is measured against
   * (see referenceStockpile) -- frozen at construction time, since the live
   * `stockpiles` value moves every day via production/consumption/trading.
   */
  private readonly frozenReferenceStockpiles: Record<string, number>;
  /** Consecutive days (so far) a produced commodity's stockpile has sat at maxStockpile -- see updateDiscount. */
  private readonly daysAtMaxStockpile: Record<string, number> = {};
  /** Consecutive days (so far) a produced commodity's stockpile has sat below maxStockpile -- see updateDiscount. */
  private readonly daysBelowMaxStockpile: Record<string, number> = {};

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
    this.discounts = Object.fromEntries(Object.keys(this.producedCommodities).map((c) => [c, 0]));
    this.fenceFraction = init.fenceFraction ?? 0.5;
    this._ownCash = init.cash ?? 10_000_000_000;
    this.contractThresholdFraction = init.contractThresholdFraction ?? DEFAULT_CONTRACT_THRESHOLD_FRACTION;
    this.settlementType = init.settlementType ?? "Town";
    this.ruler = init.ruler ?? null;

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

  /**
   * The ceiling a PRODUCED commodity's stockpile is allowed to reach: twice
   * its frozen starting level (see frozenReferenceStockpiles). Production
   * halts for a day once the stockpile is at or above this.
   */
  maxStockpile(commodityName: string): number {
    return (this.frozenReferenceStockpiles[commodityName] ?? 0) * 2;
  }

  /** This Location's current discount on commodityName's selling price (0 if unset/not produced here). */
  discount(commodityName: string): number {
    return this.discounts[commodityName] ?? 0;
  }

  /**
   * Tracks how long commodityName's stockpile has sat at (vs below)
   * maxStockpile and toggles its discount accordingly: more than
   * MAX_STOCKPILE_DISCOUNT_STREAK_DAYS consecutive days at max applies
   * MAX_STOCKPILE_DISCOUNT, and the same number of consecutive days back
   * below max removes it. Called once per simulated day from dailyUpdate,
   * after that day's production has been applied.
   */
  private updateDiscount(commodityName: string): void {
    const max = this.maxStockpile(commodityName);
    const current = this.stockpiles[commodityName] ?? 0;
    if (max > 0 && current >= max) {
      this.daysBelowMaxStockpile[commodityName] = 0;
      const streak = (this.daysAtMaxStockpile[commodityName] ?? 0) + 1;
      this.daysAtMaxStockpile[commodityName] = streak;
      if (streak > MAX_STOCKPILE_DISCOUNT_STREAK_DAYS) {
        this.discounts[commodityName] = MAX_STOCKPILE_DISCOUNT;
      }
    } else {
      this.daysAtMaxStockpile[commodityName] = 0;
      const streak = (this.daysBelowMaxStockpile[commodityName] ?? 0) + 1;
      this.daysBelowMaxStockpile[commodityName] = streak;
      if (streak > MAX_STOCKPILE_DISCOUNT_STREAK_DAYS) {
        this.discounts[commodityName] = 0;
      }
    }
  }

  /** Apply one day of production/consumption to stockpiles (floored at 0). */
  dailyUpdate(): void {
    for (const commodity of Object.keys(this.producedCommodities)) {
      const current = this.stockpiles[commodity] ?? 0;
      const max = this.maxStockpile(commodity);
      if (current < max) {
        this.stockpiles[commodity] = Math.min(max, current + this.productionRate(commodity));
      }
      this.updateDiscount(commodity);
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
