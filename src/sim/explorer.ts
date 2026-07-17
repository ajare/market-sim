/**
 * Explorer: the expedition leader (exploration game mode) -- Captain's
 * counterpart for a PorterParty. Extends Person directly (not Sailor) --
 * Captain's Sailor baggage (wage/rank/piracy) doesn't apply here, and an
 * Explorer's own arrival-triggered decisions have nowhere to hook into
 * Captain's private arrive()/act(). Its manual buy/sell trade under the SAME
 * rules as a Ship (price impact, capacity/cash limits -- see tradingAgent.ts,
 * shared with Captain), but an `aiControlled` ExpeditionParty (see faction.ts)
 * has a different motive than Company's profit-seeking ships: it wanders to a
 * uniformly random neighbor (never chosen for profit) and, before picking
 * that destination, restocks gift-worthy goods purely out of necessity -- to
 * have something to offer whichever Chieftain it meets next -- via
 * restockGiftsIfNeeded, not findBestLocalRoute/planTradeTo (still present,
 * still functional, just unused by this default AI; see ExpeditionParty.direct
 * for why). A player-controlled Explorer's movement stays exactly as designed
 * in EXP-5: one player-picked leg at a time (departFor), never autonomous
 * route planning.
 */
import { Person, type PersonInit } from "./person";
import type { PorterParty } from "./transport";
import type { CargoItem } from "./transport";
import type { Route } from "./routes";
import { routeTravelDays } from "./routes";
import { marketKey, type Market } from "./markets";
import { COMMODITIES, getLocation } from "./worldData";
import { DEFAULT_WEIGHT_PER_UNIT } from "./commodity";
import type { ShipLogEntry } from "./log";
import type { TradeLogEntry } from "./captain";
import type { Location } from "./location";
import type { World } from "./world";
import type { ExpeditionParty } from "./faction";
import { buildPassageTaxDecision, autoResolveDecision, GIFT_QUANTITY_OFFERED } from "./decisions";
import { primeRouteGraphCache } from "./pathfinding";
import {
  findBestBundle, allocateBundleForDestination, reverifyBundle, applyPurchases, routeEconomicsFromPath,
  buySingleCommodity, sellSingleCommodity, type TradeDirective, type TripCostParams, type Leader,
} from "./tradingAgent";
import { round2 } from "./utils";

export interface ExplorerInit extends Omit<PersonInit, "location" | "transport" | "dailyWage"> {
  homeLocation: Location;
  transport: PorterParty;
  startingCash?: number;
  priceImpact?: number;
  minDailyReturnPct?: number;
}

export class Explorer extends Person implements Leader {
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
  /** The ExpeditionParty managing this Explorer -- set by ExpeditionParty's constructor (mirrors Captain.company). Null only for an Explorer never wrapped in one (shouldn't happen once constructed by buildWorldFromJson/tests, but not assumed non-null here the way Captain assumes a FleetOwner). */
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

  /** Whether this Explorer's ExpeditionParty trades/moves autonomously (see faction.ts's ExpeditionParty.direct) -- false (player-controlled, the only mode that existed before Round B) if unset or not yet wrapped in a party. */
  get aiControlled(): boolean {
    return this.company?.aiControlled ?? false;
  }

  /**
   * Player-picked single leg -- sets daysRemaining/destination from `route`
   * directly. Deliberately NOT an autonomous multi-hop planner for the
   * player: the caller (UI, or an aiControlled party's own direct via
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
   * arrives once it hits zero (see arrive() -- this is where the passage-tax
   * "talk to the Location leader" happens, before any trading; "setting up
   * camp" is narrative only, no separate state). No-op while AtLocation and
   * nothing is travelling -- an aiControlled party's own restocking/route
   * choice happens in ExpeditionParty.direct instead, called separately by
   * World.runDay (deliberately the NEXT day: direct's own idle-check only
   * passes once `destination` has already gone null here, so a party never
   * plans a new move the same day it arrives). Deliberately never auto-sells
   * gift-stock on arrival -- unlike Captain's cargo, it's kept in reserve for
   * a future passage-tax gift, not something to offload.
   */
  tick(day: number, world: World): void {
    void day;
    if (this.destination !== null) {
      this.daysRemaining -= 1;
      if (this.daysRemaining > 0) return;
      this.arrive(world);
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

  /**
   * Buys toward a GIFT_QUANTITY_OFFERED-unit reserve of every gift-worthy
   * commodity (Commodity.gift > 0), best (highest-scoring) first, from
   * whatever's available at the current Location -- same-spot purchases via
   * the existing buy() above (no destination, no voyage economics), so
   * capacity/cash capping and cargo bookkeeping are already handled
   * correctly. Called by ExpeditionParty.direct as an immediate same-day
   * action before it picks where to go next: an aiControlled Explorer trades
   * purely out of necessity (to have something to offer whichever Chieftain
   * it meets next), never for profit. No-op past whatever cash/capacity
   * allows, and for any gift-worthy commodity with no buy Market here today.
   */
  restockGiftsIfNeeded(buyMarkets: Map<string, Market>): void {
    const giftWorthy = Object.values(COMMODITIES).filter((c) => c.gift > 0).sort((a, b) => b.gift - a.gift);
    for (const commodity of giftWorthy) {
      const needed = GIFT_QUANTITY_OFFERED - this.heldQuantity(commodity.name);
      if (needed <= 0) continue;
      const market = buyMarkets.get(marketKey(this.locationName, commodity.name));
      if (market === undefined) continue;
      this.buy(commodity.name, needed, market);
    }
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

  /** Every direct Trail Route from this Explorer's current node its PorterParty can actually use -- the candidate set ExpeditionParty.direct's random-wander step picks a destination from. Empty if this Explorer sits at a dead end (no compatible outgoing Trail). */
  get reachableNeighbors(): Route[] {
    const adjacency = primeRouteGraphCache();
    const neighbors = adjacency.get(this.locationName) ?? [];
    return neighbors.filter((r) => r.routeType === "Trail" && this.porterParty.canUseRoute(r));
  }

  /**
   * Departs toward `destination` if it's a direct Trail neighbor this
   * PorterParty can use -- the aiControlled counterpart to the player's own
   * departFor(route), used to execute a REPOSITION Directive from
   * ExpeditionParty.direct (see reachableNeighbors, which is always where
   * `destination` comes from). No-op if no such direct route exists.
   */
  departToward(destination: string): void {
    const route = this.directRouteTo(destination);
    if (route !== null) this.departFor(route);
  }

  /**
   * Destination-searching route/cargo planning -- the Explorer-side
   * counterpart to Captain.findBestLocalRoute (same signature -- see the
   * Leader interface), sharing the same destination-first knapsack
   * (tradingAgent.ts's findBestBundle) but restricted to direct Trail
   * neighbors only (no multi-hop continuation -- this class was never built
   * to travel more than one leg atomically, see departFor). Not currently
   * called by ExpeditionParty.direct (which picks its destination randomly,
   * then calls planTradeTo for that ONE destination instead of searching for
   * the best one) -- kept because it's part of the Leader interface and
   * still fully functional (exercised directly in tests).
   */
  findBestLocalRoute(
    buyMarkets: Map<string, Market>, sellMarkets: Map<string, Market>, commodities: string[], closedLocations: ReadonlySet<string>,
    excludeRoutes: ReadonlySet<string> = new Set(),
  ): TradeDirective | null {
    return findBestBundle(
      this.locationName, this.cash, this.porterParty.cargoCapacity, this.porterParty,
      buyMarkets, sellMarkets, commodities, closedLocations, excludeRoutes, this.minDailyReturnPct,
      0, this.costParams(), () => null,
      (destination) => {
        const route = this.directRouteTo(destination);
        return route === null ? null : [route];
      },
    );
  }

  /**
   * Trade economics for a SINGLE, already-chosen destination -- no search
   * across candidates, unlike findBestLocalRoute. Used by
   * ExpeditionParty.direct's random-wander step to decide what (if anything)
   * to carry along whichever direct Trail neighbor it just randomly picked,
   * using the exact same knapsack/price-impact mechanism Captain uses
   * (allocateBundleForDestination/routeEconomicsFromPath) -- just without a
   * "best of many" search, since the destination itself wasn't chosen for
   * profit. Null if nothing has a positive margin to carry there right now
   * (ExpeditionParty.direct still moves there empty-handed) or if
   * `destination` isn't actually a direct Trail neighbor.
   */
  planTradeTo(
    destination: string, buyMarkets: Map<string, Market>, sellMarkets: Map<string, Market>, commodities: string[],
  ): TradeDirective | null {
    const route = this.directRouteTo(destination);
    if (route === null) return null;
    const items = allocateBundleForDestination(
      this.locationName, destination, commodities, buyMarkets, sellMarkets, this.cash, this.porterParty.cargoCapacity, new Set(),
    );
    if (items.length === 0) return null;
    const econ = routeEconomicsFromPath(
      [route], this.locationName, items, 0, buyMarkets, this.porterParty, this.costParams(), () => null,
    );
    if (econ.path === null) return null;
    return { destination, items, ...econ };
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
}
