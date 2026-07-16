/**
 * Explorer: the player-controlled expedition leader (exploration game mode).
 * Extends Person directly (not Sailor) -- an Explorer commands a PorterParty
 * Transport but carries nothing personally; all inventory lives on the
 * PorterParty itself (see transport.ts's `inventory` field). Movement is
 * player-picked one leg at a time (departFor), NOT the autonomous multi-hop
 * Dijkstra planning Captain uses (findBestLocalRoute/findShortestPath) --
 * see doc/ExploreGameIntegration.md's "Expedition movement/pathfinding"
 * section.
 */
import { Person, type PersonInit } from "./person";
import type { PorterParty } from "./transport";
import type { Route } from "./routes";
import { routeTravelDays } from "./routes";
import type { Market } from "./markets";
import { COMMODITIES, getLocation } from "./worldData";
import { DEFAULT_WEIGHT_PER_UNIT } from "./commodity";
import type { ShipLogEntry } from "./log";
import type { Location } from "./location";
import type { World } from "./world";
import { buildPassageTaxDecision } from "./decisions";

export interface ExplorerInit extends Omit<PersonInit, "location" | "transport" | "dailyWage"> {
  homeLocation: Location;
  transport: PorterParty;
  startingCash?: number;
}

export class Explorer extends Person {
  cash: number;
  /** Node name the party is currently travelling toward -- null while AtLocation (not travelling). */
  destination: string | null = null;
  /** Days left on the current single leg -- see departFor/tick. Hop-by-hop atomic, same as Captain: no interim position tracked mid-leg. */
  daysRemaining = 0;
  shipLog: ShipLogEntry[] = [];

  constructor(init: ExplorerInit) {
    super({ ...init, dailyWage: 0, location: null, transport: null });
    this.cash = init.startingCash ?? 0;
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

  /**
   * Player-picked single leg -- sets daysRemaining/destination from `route`
   * directly. Deliberately NOT an autonomous multi-hop planner: the caller
   * (UI) is responsible for choosing which viable outgoing route to use: see
   * doc/ExploreGameIntegration.md's "Leg-choice event is optional, not
   * forced" decision. No-op if already travelling.
   */
  departFor(route: Route): void {
    if (this.destination !== null) return;
    const nextNode = route.origin === this.locationName ? route.destination : route.origin;
    this.destination = nextNode;
    this.daysRemaining = routeTravelDays(route, this.porterParty.speedUnitsPerDay);
  }

  /**
   * Advances one simulated day: decrements daysRemaining while travelling,
   * and arrives once it hits zero. No-op while AtLocation (destination
   * null).
   */
  tick(_day: number, world: World): void {
    if (this.destination === null) return;
    this.daysRemaining -= 1;
    if (this.daysRemaining > 0) return;
    this.arrive(world);
  }

  /**
   * Arrives at `destination`, then -- if it's a Native village and nothing
   * else is already pending -- triggers the passage-tax negotiation decision
   * before any trading is possible, per doc/ExploreGameIntegration.md's
   * "Triggers on arrival, before any trading" decision. The
   * `pendingDecision === null` guard is defensive: World.runDay already
   * refuses to tick anything while a decision is pending (see World.runDay's
   * own pause gate), so arrive() should never actually run with one already
   * set.
   */
  private arrive(world: World): void {
    const location = getLocation(this.destination!);
    if (location !== undefined) this.porterParty.arriveAt(location);
    this.destination = null;
    if (location !== undefined && location.settlementType === "Native village" && world.pendingDecision === null) {
      world.pendingDecision = buildPassageTaxDecision(this, location);
    }
  }

  /** Weight currently occupied in the PorterParty's inventory, per-commodity weightPerUnit (falls back to DEFAULT_WEIGHT_PER_UNIT for an unregistered commodity). */
  private usedCapacity(): number {
    const inventory = this.porterParty.inventory ?? {};
    let total = 0;
    for (const [commodity, quantity] of Object.entries(inventory)) {
      const weight = COMMODITIES[commodity]?.weightPerUnit ?? DEFAULT_WEIGHT_PER_UNIT;
      total += quantity * weight;
    }
    return total;
  }

  /**
   * Buys `quantity` of `commodity` from `market` (the current location's buy
   * market -- see world.buyMarkets), capped by cash, the market's available
   * quantity, and remaining inventory weight capacity. New, deliberately
   * simple method -- no price-impact curve, no fuel, no crew cost, no
   * contract path (see Captain.executeLocalRoute for the full machinery this
   * intentionally does NOT reuse). Returns the quantity actually bought (0 if
   * nothing could be bought).
   */
  buy(commodity: string, quantity: number, market: Market): number {
    if (!market.isAvailable || quantity <= 0) return 0;
    const weight = COMMODITIES[commodity]?.weightPerUnit ?? DEFAULT_WEIGHT_PER_UNIT;
    const remainingCapacity = Math.max(0, this.porterParty.cargoCapacity - this.usedCapacity());
    const affordable = market.price > 0 ? this.cash / market.price : Infinity;
    const actualQuantity = Math.min(
      quantity,
      affordable,
      market.availableQuantity,
      weight > 0 ? remainingCapacity / weight : Infinity,
    );
    if (actualQuantity <= 0) return 0;

    const cost = actualQuantity * market.price;
    this.cash -= cost;
    market.applyTrade(actualQuantity);
    market.location.cash += cost;

    const inventory = this.porterParty.inventory ?? (this.porterParty.inventory = {});
    inventory[commodity] = (inventory[commodity] ?? 0) + actualQuantity;
    return actualQuantity;
  }

  /**
   * Sells `quantity` of `commodity` into `market` (the current location's
   * sell market -- see world.sellMarkets), capped by how much of it the
   * party is actually carrying. Same "new, simple" scope as buy() above.
   * Returns the quantity actually sold (0 if nothing could be sold).
   */
  sell(commodity: string, quantity: number, market: Market): number {
    if (!market.isAvailable || quantity <= 0) return 0;
    const inventory = this.porterParty.inventory ?? {};
    const held = inventory[commodity] ?? 0;
    const actualQuantity = Math.min(quantity, held);
    if (actualQuantity <= 0) return 0;

    const proceeds = actualQuantity * market.price;
    this.cash += proceeds;
    market.applyTrade(actualQuantity);
    market.location.cash -= proceeds;

    inventory[commodity] = held - actualQuantity;
    if (inventory[commodity] <= 0) delete inventory[commodity];
    return actualQuantity;
  }
}
