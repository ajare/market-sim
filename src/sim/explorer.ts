/**
 * Explorer: the expedition leader (exploration game mode) -- Captain's
 * counterpart for a PorterParty. Extends Person directly (not Sailor) --
 * Captain's Sailor baggage (wage/rank/piracy) doesn't apply here, and an
 * Explorer's own arrival-triggered decisions have nowhere to hook into
 * Captain's private arrive()/act() -- but trades under the SAME rules as a
 * Ship (price impact, capacity/cash limits -- see tradingAgent.ts, shared
 * with Captain) and, once wrapped in an `aiControlled` ExpeditionParty (see
 * faction.ts), can plan and execute its own trades autonomously the same way
 * Company.directFleet drives idle Ships. A player-controlled Explorer's
 * movement stays exactly as designed in EXP-5: one player-picked leg at a
 * time (departFor), never autonomous route planning -- only an
 * aiControlled party's own directFleet ever calls findBestLocalRoute/
 * executeTradeDirective.
 */
import { Person, type PersonInit } from "./person";
import type { PorterParty } from "./transport";
import type { CargoItem } from "./transport";
import type { Route } from "./routes";
import { routeTravelDays } from "./routes";
import type { Market } from "./markets";
import { COMMODITIES, getLocation } from "./worldData";
import { DEFAULT_WEIGHT_PER_UNIT } from "./commodity";
import type { ShipLogEntry } from "./log";
import type { TradeLogEntry } from "./captain";
import type { Location } from "./location";
import type { World } from "./world";
import type { ExpeditionParty } from "./faction";
import { buildPassageTaxDecision, autoResolveDecision } from "./decisions";
import { primeRouteGraphCache } from "./pathfinding";
import {
  findBestBundle, reverifyBundle, applyPurchases, routeEconomicsFromPath, buySingleCommodity, sellSingleCommodity,
  sellCargoShared, type TradeDirective, type TripCostParams,
} from "./tradingAgent";
import { round2 } from "./utils";

export interface ExplorerInit extends Omit<PersonInit, "location" | "transport" | "dailyWage"> {
  homeLocation: Location;
  transport: PorterParty;
  startingCash?: number;
  priceImpact?: number;
  minDailyReturnPct?: number;
}

export class Explorer extends Person {
  cash: number;
  /** Node name the party is currently travelling toward -- null while AtLocation (not travelling). */
  destination: string | null = null;
  /** Days left on the current single leg -- see departFor/tick. Hop-by-hop atomic, same as Captain: no interim position tracked mid-leg. */
  daysRemaining = 0;
  shipLog: ShipLogEntry[] = [];
  tradeLog: TradeLogEntry[] = [];
  realizedProfit = 0;
  /** Same meaning as CaptainInit's -- how strongly a single trade moves this market's price. */
  priceImpact: number;
  /** Same meaning as Captain's -- the minimum daily-return threshold `findBestLocalRoute` requires before an aiControlled party will commit to a bundle. Irrelevant to the player's own manual buy/sell, which always succeeds if affordable/available. */
  minDailyReturnPct: number;
  /** The ExpeditionParty managing this Explorer -- set by ExpeditionParty's constructor (mirrors Captain.company). Null only for an Explorer never wrapped in one (shouldn't happen once constructed by buildWorldFromJson/tests, but not assumed non-null here the way Captain assumes a Faction). */
  company: ExpeditionParty | null = null;

  constructor(init: ExplorerInit) {
    super({ ...init, dailyWage: 0, location: null, transport: null });
    this.cash = init.startingCash ?? 0;
    this.priceImpact = init.priceImpact ?? 0.01;
    this.minDailyReturnPct = init.minDailyReturnPct ?? 0.02;
    // An Explorer always commands its PorterParty from the moment it exists
    // -- board it immediately rather than requiring a separate call (Person's
    // AT/ON invariant: boardTransport clears `location`, matching how a
    // Captain is always crewing its Transport too).
    init.transport.arriveAt(init.homeLocation);
    this.boardTransport(init.transport);
  }

  /** The PorterParty this Explorer commands. Narrowing accessor -- `transport` is always a PorterParty for an Explorer, set at construction and never reassigned. */
  get porterParty(): PorterParty {
    return this.transport as PorterParty;
  }

  /** Name of the node this Explorer is currently AT (mirrors Captain.locationName) -- always defined once constructed, since an Explorer always has a live, placed PorterParty. */
  get locationName(): string {
    return this.porterParty.currentNode!;
  }

  /** Proxies `this.transport.cargo` -- same pattern as Captain.cargo (cargo lives on the Transport, not whoever's crewing it). */
  get cargo() {
    return this.porterParty.cargo;
  }
  set cargo(value) {
    this.porterParty.cargo = value;
  }

  /** Whether this Explorer's ExpeditionParty trades/moves autonomously (see faction.ts's ExpeditionParty.directFleet) -- false (player-controlled, the only mode that existed before Round B) if unset or not yet wrapped in a party. */
  get aiControlled(): boolean {
    return this.company?.aiControlled ?? false;
  }

  /**
   * Player-picked single leg -- sets daysRemaining/destination from `route`
   * directly. Deliberately NOT an autonomous multi-hop planner for the
   * player: the caller (UI, or an aiControlled party's own directFleet via
   * executeTradeDirective) is responsible for choosing which viable outgoing
   * route to use -- see doc/ExploreGameIntegration.md's "Leg-choice event is
   * optional, not forced" decision. No-op if already travelling.
   */
  departFor(route: Route): void {
    if (this.destination !== null) return;
    const nextNode = route.origin === this.locationName ? route.destination : route.origin;
    this.destination = nextNode;
    this.daysRemaining = routeTravelDays(route, this.porterParty.speedUnitsPerDay);
  }

  /**
   * Advances one simulated day: decrements daysRemaining while travelling,
   * arrives once it hits zero, then (aiControlled only -- a player-controlled
   * party still sells via the manual "Sell" button) immediately tries to
   * sell whatever it's carrying. No-op while AtLocation with no cargo and
   * nothing already travelling.
   */
  tick(day: number, world: World): void {
    if (this.destination !== null) {
      this.daysRemaining -= 1;
      if (this.daysRemaining > 0) return;
      this.arrive(world);
    }
    if (this.aiControlled && this.cargo !== null) {
      this.sellCargoIfPossible(day, world.sellMarkets);
    }
  }

  /**
   * Arrives at `destination`, then -- if it's a Native village -- triggers
   * the passage-tax negotiation before any trading is possible, per
   * doc/ExploreGameIntegration.md's "Triggers on arrival, before any
   * trading" decision. A player-controlled Explorer pauses the simulation
   * for it (`world.pendingDecision`, guarded since World.runDay already
   * refuses to tick anything while one is pending -- this should never
   * actually collide). An aiControlled one resolves it immediately instead
   * (see decisions.autoResolveDecision) and never touches
   * `world.pendingDecision` at all -- this is what lets more than one
   * Explorer exist in the same World without one's arrival silently
   * clobbering another's still-pending decision (the global slot is only
   * ever contended for by player-controlled parties, of which there's
   * meant to be at most one).
   */
  private arrive(world: World): void {
    const location = getLocation(this.destination!);
    if (location !== undefined) this.porterParty.arriveAt(location);
    this.destination = null;
    if (location !== undefined && location.settlementType === "Native village") {
      const decision = buildPassageTaxDecision(this, location);
      if (this.aiControlled) {
        autoResolveDecision(decision);
      } else if (world.pendingDecision === null) {
        world.pendingDecision = decision;
      }
    }
  }

  /** Weight currently occupied in the party's cargo, per-commodity weightPerUnit (falls back to DEFAULT_WEIGHT_PER_UNIT for an unregistered commodity). */
  private usedCapacity(): number {
    const items = this.cargo?.items ?? [];
    let total = 0;
    for (const item of items) {
      const weight = COMMODITIES[item.commodity]?.weightPerUnit ?? DEFAULT_WEIGHT_PER_UNIT;
      total += item.quantity * weight;
    }
    return total;
  }

  /** Merges `quantity` of `commodity` into the party's cargo -- combines into an existing open-market item for the same commodity (weighted-average cost basis) if one's already aboard, same per-commodity accumulation the old inventory map gave for free. Creates a fresh (zero trip-economics) CargoState if the party wasn't carrying anything at all. */
  private addToCargo(commodity: string, quantity: number, unitCost: number): void {
    const cargo = this.cargo ?? {
      items: [], origin: this.locationName, destination: this.locationName, distance: 0, routeType: "none",
      travelDays: 0, fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: 0, departureDay: 0,
    };
    const existing = cargo.items.find((i) => i.commodity === commodity && i.contract === null);
    if (existing !== undefined) {
      const totalQuantity = existing.quantity + quantity;
      existing.unitCost = (existing.unitCost * existing.quantity + unitCost * quantity) / totalQuantity;
      existing.quantity = totalQuantity;
    } else {
      cargo.items.push({ commodity, quantity, unitCost, contract: null });
    }
    this.cargo = cargo;
  }

  /** Removes up to `quantity` of `commodity` from the party's cargo (oldest/only lot first -- items are never split by cost basis beyond the single merged lot addToCargo maintains). Public, not just Explorer's own buy/sell: decisions.ts's gift-giving choice also needs to hand over goods from cargo. No-op past whatever's actually held. */
  removeFromCargo(commodity: string, quantity: number): void {
    if (this.cargo === null) return;
    let remaining = quantity;
    const items: CargoItem[] = [];
    for (const item of this.cargo.items) {
      if (item.commodity === commodity && item.contract === null && remaining > 0) {
        const take = Math.min(remaining, item.quantity);
        remaining -= take;
        const leftover = item.quantity - take;
        if (leftover > 0) items.push({ ...item, quantity: leftover });
      } else {
        items.push(item);
      }
    }
    this.cargo = items.length > 0 ? { ...this.cargo, items } : null;
  }

  /** How much open-market `commodity` this party is currently carrying (0 if none). */
  heldQuantity(commodity: string): number {
    return (this.cargo?.items ?? [])
      .filter((i) => i.commodity === commodity && i.contract === null)
      .reduce((sum, i) => sum + i.quantity, 0);
  }

  /**
   * Buys `quantity` of `commodity` from `market` (the current location's buy
   * market -- see world.buyMarkets), capped by cash, the market's available
   * quantity, and remaining cargo weight capacity -- same underlying
   * economics as a Ship's trade (see tradingAgent.ts's buySingleCommodity:
   * real price impact, no free lunches), just a single freeform trade
   * independent of departing anywhere, which Captain has no equivalent of
   * (it only ever trades as part of a directed voyage). Returns the quantity
   * actually bought (0 if nothing could be bought).
   */
  buy(commodity: string, quantity: number, market: Market): number {
    const weight = COMMODITIES[commodity]?.weightPerUnit ?? DEFAULT_WEIGHT_PER_UNIT;
    const remainingWeightCapacity = Math.max(0, this.porterParty.cargoCapacity - this.usedCapacity());
    const remainingUnits = weight > 0 ? remainingWeightCapacity / weight : Infinity;
    const { quantity: bought, cost } = buySingleCommodity(quantity, market, this.cash, remainingUnits, this.priceImpact);
    if (bought <= 0) return 0;
    this.cash -= cost;
    this.addToCargo(commodity, bought, cost / bought);
    return bought;
  }

  /**
   * Sells `quantity` of `commodity` into `market` (the current location's
   * sell market -- see world.sellMarkets), capped by how much of it the
   * party is actually carrying. Same "single freeform trade" scope as buy()
   * above. Returns the quantity actually sold (0 if nothing could be sold).
   */
  sell(commodity: string, quantity: number, market: Market): number {
    const held = this.heldQuantity(commodity);
    const { quantity: sold, proceeds } = sellSingleCommodity(quantity, held, market, this.priceImpact);
    if (sold <= 0) return 0;
    this.cash += proceeds;
    this.removeFromCargo(commodity, sold);
    return sold;
  }

  /** This Explorer's trip-cost inputs for the shared tradingAgent.ts functions -- always zero, since a PorterParty burns no fuel, pays no crew, and has no fixed shipment fee. */
  private costParams(): TripCostParams {
    return { fuelConsumptionRate: 0, fixedShipmentCost: 0, dailyCrewCost: 0, speedFn: () => this.porterParty.speedUnitsPerDay };
  }

  /** The single Trail Route directly connecting this Explorer's current node to `destination`, or null if none exists -- an aiControlled party only ever considers direct hops, matching the player's own single-leg movement model (see this class's own doc comment). */
  private directRouteTo(destination: string): Route | null {
    const adjacency = primeRouteGraphCache();
    const neighbors = adjacency.get(this.locationName) ?? [];
    return neighbors.find(
      (r) => r.routeType === "Trail" && this.porterParty.canUseRoute(r) &&
        (r.origin === this.locationName ? r.destination : r.origin) === destination,
    ) ?? null;
  }

  /**
   * Autonomous route/cargo planning for an aiControlled ExpeditionParty --
   * the Explorer-side counterpart to Captain.findBestLocalRoute, sharing the
   * same destination-first knapsack (tradingAgent.ts's findBestBundle) but
   * restricted to direct Trail neighbors only (no multi-hop continuation --
   * this class was never built to travel more than one leg atomically, see
   * departFor). Called only by ExpeditionParty.directFleet, never by the
   * player's manual UI.
   */
  findBestLocalRoute(
    buyMarkets: Map<string, Market>, sellMarkets: Map<string, Market>, commodities: string[], closedLocations: ReadonlySet<string>,
  ): TradeDirective | null {
    return findBestBundle(
      this.locationName, this.cash, this.porterParty.cargoCapacity, this.porterParty,
      buyMarkets, sellMarkets, commodities, closedLocations, new Set(), this.minDailyReturnPct,
      0, this.costParams(), () => null,
      (destination) => {
        const route = this.directRouteTo(destination);
        return route === null ? null : [route];
      },
    );
  }

  /**
   * Executes a bundle from findBestLocalRoute: re-verifies/buys via the same
   * shared tradingAgent.ts functions Captain's executeLocalRoute uses, then
   * departs along the single direct leg via departFor -- no leavePort
   * equivalent needed (no multi-hop continuation, no fuel to refuel
   * mid-transit).
   */
  executeTradeDirective(
    directive: TradeDirective, day: number, buyMarkets: Map<string, Market>, sellMarkets: Map<string, Market>,
  ): void {
    const { destination } = directive;
    const route = this.directRouteTo(destination);
    if (route === null) return;

    const executed = reverifyBundle(
      this.locationName, directive.items, destination, this.porterParty.cargoCapacity, this.cash, buyMarkets, sellMarkets,
    );
    if (executed.length === 0) return;

    const econ = routeEconomicsFromPath(
      [route], this.locationName,
      executed.map((e) => ({ commodity: e.commodity, quantity: e.quantity, buyPrice: e.buyPrice, sellPriceEstimate: e.sellPriceEstimate })),
      0, buyMarkets, this.porterParty, this.costParams(), () => null,
    );
    if (econ.expectedProfit <= 0 || econ.dailyReturnPct < this.minDailyReturnPct) return;
    if (econ.totalCost > this.cash) return;

    const { cargoItems, goodsCost } = applyPurchases(executed, this.priceImpact);
    this.cash -= goodsCost;

    executed.forEach((e) => {
      this.tradeLog.push({
        day, action: "BUY", commodity: e.commodity, location: this.locationName, destination,
        quantity: round2(e.quantity), price: round2(e.buyPrice), distance: econ.distance, routeType: econ.routeType,
        travelDays: econ.travelDays, fuelPrice: null, fuelUnitsConsumed: null, fuelCostPaid: 0, profit: null,
      });
    });

    this.cargo = {
      items: cargoItems, origin: this.locationName, destination, distance: econ.distance, routeType: econ.routeType,
      travelDays: econ.travelDays, fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: goodsCost, departureDay: day,
    };

    this.departFor(route);
  }

  /** aiControlled-only sell-on-arrival -- shares sellCargoShared with Captain (same per-item, overhead-apportioned economics; overhead is always 0 here, since a PorterParty's cargo.totalCost is pure goods cost). Explorer's cargo never carries a contract-bound item, so remainingItems here is only ever non-empty when a market was closed/unavailable. */
  private sellCargoIfPossible(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    const cargo = this.cargo;
    const { realizedProfitDelta, proceeds, entries, remainingItems } = sellCargoShared(this.locationName, cargo, sellMarkets, this.priceImpact);
    this.cash += proceeds;
    this.realizedProfit += realizedProfitDelta;
    for (const entry of entries) {
      this.tradeLog.push({
        day, action: "SELL", commodity: entry.commodity, location: this.locationName, destination: null,
        quantity: entry.quantity, price: entry.price, distance: cargo.distance, routeType: cargo.routeType,
        travelDays: cargo.travelDays, fuelPrice: null, fuelUnitsConsumed: null, fuelCostPaid: 0, profit: entry.profit,
      });
    }
    this.cargo = remainingItems.length > 0 ? { ...cargo, items: remainingItems } : null;
  }
}
