/**
 * Faction: owns a fleet of Captains and their money -- and Company (its
 * actively fleet-directing subclass, with SoloTrader a non-pooling
 * variant) / PirateBrigade (a raiding subclass) / PoliceFleet (a
 * currently-passive law-enforcement subclass). Ported from sim/faction.py.
 *
 * `poolsCash` is a GETTER, not a plain field: Faction's constructor reads
 * `this.poolsCash` while running, and a plain class-field override
 * (`poolsCash = false` on SoloTrader/PirateBrigade) would not yet be
 * applied at that point -- JS initializes subclass fields only AFTER the
 * base constructor body finishes running, unlike Python's class-attribute
 * MRO lookup, which resolves an override immediately even during
 * `Faction.__init__`. A getter on the prototype chain is resolved
 * dynamically (like Python's MRO), so it works correctly here.
 */
import { Captain, type Directive, type TradeDirective } from "./captain";
import { Sailor } from "./crew";
import { Ship, type Transport } from "./transport";
import { getRoute } from "./routes";
import { getLocation, distanceBetween } from "./worldData";
import { findShortestPath } from "./pathfinding";
import { Market, marketKey } from "./markets";
import { randChoice, randUniform } from "./simRandom";
import type { BulletinBoard, Contract, ContractType } from "./contracts";

export type FleetCrew = Array<[Transport, Captain, string]>;

/** Range (inclusive, as a fraction of seized quantity) a raid destroys outright before fencing -- rolled fresh per attack. See PirateBrigade.attack. */
export const MIN_CARGO_DESTRUCTION_FRACTION = 0.25;
export const MAX_CARGO_DESTRUCTION_FRACTION = 0.75;

/**
 * How a Company decides between servicing contracts and arbitraging
 * (default: "compare" -- see Company.contractStrategy):
 * - "compare": weigh each contract against the ship's own best arbitrage
 *   route (by expected profit per ship-day) and take whichever pays more --
 *   claiming a contract only at the moment a ship commits to it.
 * - "prioritise": claim and service due contracts first, then arbitrage with
 *   whatever ships are left (the original behaviour, before this toggle
 *   existed).
 */
export type ContractStrategy = "prioritise" | "compare";

export interface FactionNetWorthSnapshot {
  day: number;
  cash: number;
  netWorth: number;
}

export class Faction {
  get poolsCash(): boolean {
    return true;
  }

  /** Whether this Faction's Captains can attempt to smuggle cargo through a closed port's black market instead of waiting for it to reopen -- see Captain.maybeSmuggle. False by default; only SoloTrader overrides it. */
  get canSmuggle(): boolean {
    return false;
  }

  name: string;
  captains: Captain[] = [];
  startingCash: number;
  /** The single shared pool every captain's `cash` reads/writes through -- only meaningful when poolsCash. */
  cash: number = 0;
  netWorthHistory: FactionNetWorthSnapshot[] = [];

  constructor(name: string, crew: FleetCrew, startingCash: number = 0.0) {
    this.name = name;
    for (const [transport, captain, homeLocation] of crew) {
      captain.transport = transport;
      captain.location = homeLocation;
      this.captains.push(captain);
      this.crewTransport(transport, captain);
    }
    this.startingCash = startingCash;
    if (this.poolsCash) {
      this.cash = startingCash;
      for (const captain of this.captains) {
        this.cash += captain.ownCash;
        captain.ownCash = 0.0;
        captain.company = this;
      }
    } else {
      if (startingCash && this.captains.length > 0) {
        const share = startingCash / this.captains.length;
        for (const captain of this.captains) {
          captain.ownCash += share;
        }
      }
      for (const captain of this.captains) {
        captain.company = this;
      }
    }
  }

  /** Fills a Transport's `.crew` (the captain plus Sailors for any extra crewRequirement seats) -- shared by the constructor's initial fleet and addTransport's single-recruit path. */
  private crewTransport(transport: Transport, captain: Captain): void {
    transport.crew = [captain];
    const extraSeats = Math.max(0, transport.crewRequirement - 1);
    for (let i = 0; i < extraSeats; i++) {
      transport.crew.push(new Sailor(`${transport.name} Sailor ${i + 2}`, transport));
    }
  }

  /**
   * Adds a single new Transport/Captain to this fleet at runtime -- the
   * single-recruit equivalent of what the constructor does for the whole
   * initial crew array. `startingCash` folds in the same way the
   * constructor's `startingCash` does: added to the shared pool if this
   * Faction pools cash, or credited directly to the new captain's own
   * balance otherwise. Returns `captain` for convenience.
   */
  addTransport(transport: Transport, captain: Captain, homeLocation: string, startingCash: number = 0.0): Captain {
    captain.transport = transport;
    captain.location = homeLocation;
    this.captains.push(captain);
    this.crewTransport(transport, captain);

    if (this.poolsCash) {
      this.cash += startingCash + captain.ownCash;
      captain.ownCash = 0.0;
    } else {
      captain.ownCash += startingCash;
    }
    captain.company = this;
    return captain;
  }

  /** Removes `captain` (and its Transport) from this fleet. Returns true if it was actually part of this fleet, false otherwise (no-op). */
  removeTransport(captain: Captain): boolean {
    const idx = this.captains.indexOf(captain);
    if (idx === -1) return false;
    this.captains.splice(idx, 1);
    return true;
  }

  totalCash(): number {
    if (this.poolsCash) return this.cash;
    return this.captains.reduce((sum, c) => sum + c.cash, 0);
  }

  netWorth(sellMarkets: Map<string, Market>): number {
    let total = this.totalCash();
    for (const t of this.captains) {
      // Contract cargo is bought and paid for by the issuing Location, not
      // the Company (see Captain.executeContractDelivery) -- the Company only
      // fronts fuel -- so it's not a Company asset and is excluded here.
      if (t.cargo !== null && t.cargo.contract === null) {
        const markLocation = t.status === "AtLocation" ? t.location : t.cargo.destination;
        const market = sellMarkets.get(marketKey(markLocation, t.cargo.commodity));
        const unitValue = market !== undefined ? market.price : t.cargo.unitCost;
        total += unitValue * t.cargo.quantity;
      }
    }
    return total;
  }

  recordNetWorthSnapshot(day: number, sellMarkets: Map<string, Market>): void {
    this.netWorthHistory.push({ day, cash: this.totalCash(), netWorth: this.netWorth(sellMarkets) });
  }

  /**
   * A plain Faction has no active routing strategy -- its ships plan and
   * execute trades entirely autonomously. Returning an empty Map has the
   * same net effect as Python's NotImplementedError-caught-and-skipped
   * (World.merges whatever's returned into directedRoutes either way).
   */
  directFleet(
    _day: number,
    _buyMarkets: Map<string, Market>,
    _sellMarkets: Map<string, Market>,
    _commodities: string[],
    _closedLocations: ReadonlySet<string>,
    _board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Captain, Directive> {
    return new Map();
  }
}

/**
 * A Faction that accepts Contracts from a BulletinBoard, filtered to the
 * ContractTypes it declares it can handle (`contractTypes` -- empty means it
 * never accepts anything, e.g. SoloTrader). `contracts` holds every Contract
 * this fulfiller has accepted but not yet had fulfilled.
 */
export class ContractFulfiller extends Faction {
  /** Contract types this fulfiller can accept. Empty by default -- a plain ContractFulfiller (like SoloTrader) accepts nothing. */
  contractTypes: readonly ContractType[] = [];

  /** Contracts accepted by this fulfiller -- see availableContracts/acceptContract. */
  contracts: Contract[] = [];

  /** Postings on `board` this fulfiller is able to accept, per `contractTypes`. Never includes an already-accepted posting -- a board only ever holds unaccepted ones. */
  protected availableContracts(board: BulletinBoard): Contract[] {
    return board.open.filter((c) => this.contractTypes.includes(c.type));
  }

  /** Accept `contract`: remove it from `board`, stamp this fulfiller as its owner, and add it to `contracts`. */
  protected acceptContract(board: BulletinBoard, contract: Contract): void {
    board.remove(contract);
    contract.fulfiller = this;
    this.contracts.push(contract);
  }

  /** Drop contracts this fulfiller has already had fulfilled OR cancelled (its cargo was seized by pirates -- see PirateBrigade.attack) -- called at the top of a servicing pass. */
  protected pruneFulfilled(): void {
    this.contracts = this.contracts.filter((c) => !c.fulfilled && !c.cancelled);
  }
}

/**
 * A Faction that actively directs its fleet: coordinated routing (every
 * idle transport's best local route is scored and assigned in descending
 * daily-return order, spreading coverage rather than piling onto one
 * route) plus shared capital (inherited from Faction). Also the only kind
 * of ContractFulfiller that can accept anything by default (`contractTypes`,
 * emptied on SoloTrader) -- how an accepted contract is weighed against
 * arbitrage is per-Company, via `contractStrategy` (see ContractStrategy and
 * directFleet).
 */
export class Company extends ContractFulfiller {
  override contractTypes: readonly ContractType[] = ["Commodity"];

  /**
   * Whether THIS Company prioritises contracts over arbitrage, or weighs the
   * two by expected profit -- see ContractStrategy and directFleet. A plain
   * instance field (not shared state), so each Company could in principle run
   * a different strategy; buildWorld currently starts every Company at the
   * same default ("compare"), and the UI's toggle pushes a single choice onto
   * all of them at once, but nothing stops per-Company variation.
   */
  contractStrategy: ContractStrategy = "compare";

  directFleet(
    _day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Captain, Directive> {
    const idle = this.captains.filter((t) => t.isIdleInPort(closedLocations));
    if (idle.length === 0) return new Map();

    const directives = new Map<Captain, Directive>();
    const assigned = new Set<Captain>();

    if (this.contractStrategy === "compare") {
      this.serviceContractsByProfit(
        idle, assigned, directives, buyMarkets, sellMarkets, commodities, closedLocations, board,
      );
    } else {
      this.claimOpenContracts(board);
      this.serviceContracts(idle, assigned, directives, buyMarkets, closedLocations);
    }

    const arbitrageIdle = idle.filter((t) => !assigned.has(t));
    if (arbitrageIdle.length === 0) return directives;

    const candidates: Array<[Captain, TradeDirective]> = [];
    for (const trader of arbitrageIdle) {
      const best = trader.findBestLocalRoute(buyMarkets, sellMarkets, commodities, closedLocations);
      if (best !== null) candidates.push([trader, best]);
    }
    if (candidates.length === 0) return directives;

    candidates.sort((a, b) => b[1].dailyReturnPct - a[1].dailyReturnPct);

    // Multiple ships may share a (commodity, destination) route -- capped by
    // how much of the destination's deficit is still uncovered, so fleet
    // coordination scales shipping with actual demand instead of capping
    // every route at a single ship. The first ship onto a route is always
    // let through regardless of deficit size, matching the old one-per-day
    // fallback for routes with no measurable deficit (e.g. fuel depots).
    const claimedQuantity = new Map<string, number>();
    const fullRoutes = new Set<string>();
    for (let [trader, best] of candidates) {
      if (directives.has(trader)) continue;
      let routeKey = `${best.commodity}||${best.destination}`;
      if (fullRoutes.has(routeKey)) {
        const alt = trader.findBestLocalRoute(
          buyMarkets, sellMarkets, commodities, closedLocations, new Set(fullRoutes),
        );
        if (alt === null) continue;
        best = alt;
        routeKey = `${best.commodity}||${best.destination}`;
        if (fullRoutes.has(routeKey)) continue;
      }

      directives.set(trader, best);
      const claimed = (claimedQuantity.get(routeKey) ?? 0) + best.quantity;
      claimedQuantity.set(routeKey, claimed);
      if (claimed >= this.remainingDemand(best.commodity, best.destination)) {
        fullRoutes.add(routeKey);
      }
    }
    return directives;
  }

  /**
   * Accept any still-available Contract off `board`, capped at roughly one
   * contract's worth of dedicated capacity per ship (`contracts.length <
   * captains.length`) so a single Company (especially whichever happens to
   * act first each day) can't monopolize every contract in the world --
   * leaving the rest for other Companies to pick up.
   *
   * No affordability check: the issuing Location pays for the goods
   * directly (see Captain.executeContractDelivery), so a Company only ever
   * needs to afford fuel for a delivery it's already accepted -- checked at
   * departure time, not at accept time.
   */
  private claimOpenContracts(board: BulletinBoard): void {
    this.pruneFulfilled();
    for (const contract of this.availableContracts(board)) {
      if (this.contracts.length >= this.captains.length) break;
      this.acceptContract(board, contract);
    }
  }

  /**
   * Assign idle captains to due, not-already-in-flight contracts before any
   * arbitrage routing runs. Prefers a captain already sitting at a valid
   * producer (immediate CONTRACT_DELIVER); otherwise repositions the nearest
   * available idle captain toward the nearest valid producer, to be handed
   * the delivery once it arrives (a future day's directFleet call will find
   * it idle-at-producer and take the first branch).
   */
  private serviceContracts(
    idle: Captain[],
    assigned: Set<Captain>,
    directives: Map<Captain, Directive>,
    buyMarkets: Map<string, Market>,
    closedLocations: ReadonlySet<string>,
  ): void {
    for (const contract of this.contracts) {
      if (assigned.size >= idle.length) break;
      if (contract.inFlightCaptain !== null) {
        // An Inactive transport never recovers (Captain.act's InTransit
        // branch flips it once and there's no path back) -- so a captain
        // frozen mid-delivery would otherwise deadlock this contract
        // forever, since inFlightCaptain !== null blocks any replacement.
        // Release it so another idle captain can pick up the delivery.
        if (contract.inFlightCaptain.transport?.status === "Inactive") {
          contract.inFlightCaptain = null;
        } else {
          continue;
        }
      }
      const readyCaptain = idle.find((c) => {
        if (assigned.has(c)) return false;
        const market = buyMarkets.get(marketKey(c.location, contract.commodity));
        return market !== undefined && market.isAvailable;
      });
      if (readyCaptain !== undefined) {
        directives.set(readyCaptain, { action: "CONTRACT_DELIVER", contract });
        assigned.add(readyCaptain);
        continue;
      }

      // Reachability must allow a multi-hop path, not just a direct edge --
      // otherwise a captain idle somewhere with no DIRECT route to any
      // producer never gets repositioned at all, and (never moving) never
      // discovers a route from anywhere else either, permanently starving
      // the contract. departEmptyTo already executes multi-hop repositions
      // (its distance/time math is coordinate-based, not edge-based), so
      // this search just needs to match what it can actually carry out.
      //
      // Candidates are ranked by how much of the contract a trip there could
      // actually deliver (capped at contract.quantity -- once a producer can
      // fully supply it, more stock on top doesn't matter), THEN by
      // distance. Pure nearest-first previously let a commodity with few,
      // geographically scattered producers get stuck repeatedly routing to
      // the same nearby-but-thin producer instead of a farther one with
      // ample stock -- every delivery would land far short of
      // contract.quantity, never letting the destination's stockpile
      // recover (see Simulation.md's Gold/Silver stockout finding).
      let best: { captain: Captain; destination: string; deliverable: number; distance: number } | null = null;
      for (const captain of idle) {
        if (assigned.has(captain)) continue;
        for (const market of buyMarkets.values()) {
          if (market.commodityName !== contract.commodity || !market.isAvailable) continue;
          if (closedLocations.has(market.locationName)) continue;
          const path = findShortestPath(captain.location, market.locationName, (r) => captain.transport!.canUseRoute(r));
          if (path === null) continue;
          const deliverable = Math.min(captain.transport!.cargoCapacity, contract.quantity, market.availableQuantity);
          const dist = distanceBetween(captain.location, market.locationName);
          const better =
            best === null ||
            deliverable > best.deliverable ||
            (deliverable === best.deliverable && dist < best.distance);
          if (better) {
            best = { captain, destination: market.locationName, deliverable, distance: dist };
          }
        }
      }
      if (best !== null) {
        directives.set(best.captain, { action: "REPOSITION", destination: best.destination });
        assigned.add(best.captain);
      }
    }
  }

  /**
   * "compare"-mode servicing: instead of claiming and prioritising contracts,
   * weigh each contract against the ship's own best arbitrage route and take
   * whichever earns more per ship-day. Candidate contracts are this Company's
   * already-claimed unfulfilled ones plus still-open (unclaimed) ones -- but a
   * still-open contract is only actually claimed at the moment a ship commits
   * to it, so contracts we never find profitable stay open for other Companies
   * (and expire / re-tender normally) rather than being hoarded unserviced.
   */
  private serviceContractsByProfit(
    idle: Captain[],
    assigned: Set<Captain>,
    directives: Map<Captain, Directive>,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    board: BulletinBoard,
  ): void {
    this.pruneFulfilled();
    const candidateContracts = [...this.contracts, ...this.availableContracts(board)];
    if (candidateContracts.length === 0) return;

    // The bar each contract must clear: the captain's best arbitrage $/day
    // (expected net profit over the trip, per day of ship-time). -Infinity
    // means the captain has no viable arbitrage right now, so any profitable
    // contract wins.
    const arbPerDay = new Map<Captain, number>();
    for (const captain of idle) {
      const best = captain.findBestLocalRoute(buyMarkets, sellMarkets, commodities, closedLocations);
      arbPerDay.set(captain, best !== null && best.travelDays > 0 ? best.expectedProfit / best.travelDays : -Infinity);
    }

    interface Option { captain: Captain; contract: Contract; producer: string; ready: boolean; perDay: number; }
    const options: Option[] = [];
    for (const contract of candidateContracts) {
      if (contract.inFlightCaptain !== null) {
        // Same Inactive-transport release valve as serviceContracts.
        if (contract.inFlightCaptain.transport?.status === "Inactive") contract.inFlightCaptain = null;
        else continue;
      }
      for (const captain of idle) {
        if (assigned.has(captain)) continue;
        const readyMarket = buyMarkets.get(marketKey(captain.location, contract.commodity));
        let producer: string | null;
        let ready = false;
        if (readyMarket !== undefined && readyMarket.isAvailable && !closedLocations.has(captain.location)) {
          producer = captain.location;
          ready = true;
        } else {
          producer = this.bestProducer(captain, contract, buyMarkets, closedLocations);
        }
        if (producer === null) continue;
        const perDay = captain.estimateContractProfitPerDay(contract, producer, buyMarkets);
        if (perDay === null) continue;
        if (perDay < (arbPerDay.get(captain) ?? -Infinity)) continue; // arbitrage is the better use of this ship
        options.push({ captain, contract, producer, ready, perDay });
      }
    }

    // Assign the most profitable options first, one ship per contract and one
    // contract per ship.
    options.sort((a, b) => b.perDay - a.perDay);
    const usedContracts = new Set<Contract>();
    for (const opt of options) {
      if (assigned.has(opt.captain) || usedContracts.has(opt.contract)) continue;
      if (opt.contract.fulfiller === null) {
        // Accept now, at commit time -- capped like claimOpenContracts so one
        // Company can't monopolise every contract.
        if (this.contracts.length >= this.captains.length) continue;
        this.acceptContract(board, opt.contract);
      }
      directives.set(
        opt.captain,
        opt.ready
          ? { action: "CONTRACT_DELIVER", contract: opt.contract }
          : { action: "REPOSITION", destination: opt.producer },
      );
      assigned.add(opt.captain);
      usedContracts.add(opt.contract);
    }
  }

  /**
   * Best producer for `captain` to source `contract.commodity` from: reachable,
   * ranked by how much of the contract a trip there could deliver (capped at
   * the contract quantity) then by distance -- the same ranking serviceContracts
   * uses, but resolved per-captain for serviceContractsByProfit.
   */
  private bestProducer(
    captain: Captain,
    contract: Contract,
    buyMarkets: Map<string, Market>,
    closedLocations: ReadonlySet<string>,
  ): string | null {
    let best: { destination: string; deliverable: number; distance: number } | null = null;
    for (const market of buyMarkets.values()) {
      if (market.commodityName !== contract.commodity || !market.isAvailable) continue;
      if (closedLocations.has(market.locationName)) continue;
      const path = findShortestPath(captain.location, market.locationName, (r) => captain.transport!.canUseRoute(r));
      if (path === null) continue;
      const deliverable = Math.min(captain.transport!.cargoCapacity, contract.quantity, market.availableQuantity);
      const dist = distanceBetween(captain.location, market.locationName);
      const better =
        best === null ||
        deliverable > best.deliverable ||
        (deliverable === best.deliverable && dist < best.distance);
      if (better) best = { destination: market.locationName, deliverable, distance: dist };
    }
    return best === null ? null : best.destination;
  }

  /** Deficit still open at a destination for a commodity -- floors at 0 so a destination already at/above its minimum doesn't block the first ship either. */
  private remainingDemand(commodity: string, destination: string): number {
    const location = getLocation(destination);
    if (location === undefined) return 0;
    const deficit = (location.minStockpiles[commodity] ?? 0) - (location.stockpiles[commodity] ?? 0);
    return Math.max(deficit, 0);
  }
}

/**
 * A Company that still gets coordinated routing but does NOT pool its
 * fleet's cash into one shared balance -- each captain keeps their own
 * private balance. Also opts out of the Contract system entirely, via an
 * empty `contractTypes` -- `availableContracts` then always returns nothing,
 * so a SoloTrader never accepts a posting regardless of what's on the board.
 * In exchange for being locked out of Contracts, it's the only Faction that
 * can smuggle (`canSmuggle`) -- an independent operator with no corporate
 * oversight is willing to run a blockade a Company wouldn't touch.
 */
export class SoloTrader extends Company {
  constructor(name: string, crew: FleetCrew, startingCash: number = 0.0) {
    if (crew.length !== 1) {
      throw new Error(`SoloTrader '${name}' must have exactly one Transport/Captain, got ${crew.length}`);
    }
    super(name, crew, startingCash);
  }

  override get poolsCash(): boolean {
    return false;
  }

  override contractTypes: readonly ContractType[] = [];

  /** SoloTrader's one distinctive edge over a plain Company: it'll run a closed port's blockade instead of just waiting -- see Captain.maybeSmuggle. */
  override get canSmuggle(): boolean {
    return true;
  }
}

export class PirateBrigade extends Faction {
  override get poolsCash(): boolean {
    return false;
  }

  targets: Company[];
  laziness: number;
  raidFraction: number;
  maxCarousingToAttack: number;
  carousingCostPerCrew: number;
  carousingIncreaseByDay: number;
  maxCarousing: number;
  policeFleets: PoliceFleet[];
  /** Fraction of tracked Company/SoloTrader ship-presence at each Location, as of the last scan -- see directFleet's density-matching reposition logic. */
  private cachedTargetDensity: Map<string, number> | null = null;
  private lastScanDay: number | null = null;
  /**
   * Per-day attack bookkeeping, reset at the top of every directFleet call
   * (which always runs before any captain's own act() -- see World.runDay).
   * Shared between directFleet's own scan-based attack loop and
   * maybeAttackOnArrival's same-day arrival-triggered attack, so a given
   * pirate/victim pair only ever attacks/gets attacked once per day
   * regardless of which of the two paths triggers it.
   */
  private attackersUsedToday = new Set<Captain>();
  private victimsHitToday = new Set<Captain>();

  constructor(
    name: string,
    crew: FleetCrew,
    targets: Company[],
    startingCash: number = 0.0,
    laziness: number = 1,
    raidFraction: number = 0.1,
    maxCarousingToAttack: number = 100.0,
    carousingCostPerCrew: number = 10.0,
    carousingIncreaseByDay: number = 10.0,
    maxCarousing: number = 100.0,
    policeFleets: PoliceFleet[] | null = null,
  ) {
    const nonShips = crew.filter(([transport]) => !(transport instanceof Ship)).map(([, captain]) => captain.name);
    if (nonShips.length > 0) {
      throw new Error(
        `PirateBrigade '${name}' can only crew Ships -- non-Ship Transports on: ${nonShips.join(", ")}`,
      );
    }
    super(name, crew, startingCash);
    this.targets = targets;
    this.laziness = laziness;
    this.raidFraction = raidFraction;
    this.maxCarousingToAttack = maxCarousingToAttack;
    this.carousingCostPerCrew = carousingCostPerCrew;
    this.carousingIncreaseByDay = carousingIncreaseByDay;
    this.maxCarousing = maxCarousing;
    this.policeFleets = policeFleets ?? [];
  }

  /** Same Ship-only restriction as the constructor -- see its check above. */
  override addTransport(transport: Transport, captain: Captain, homeLocation: string, startingCash: number = 0.0): Captain {
    if (!(transport instanceof Ship)) {
      throw new Error(`PirateBrigade '${this.name}' can only crew Ships -- got a non-Ship Transport for captain '${captain.name}'`);
    }
    return super.addTransport(transport, captain, homeLocation, startingCash);
  }

  private targetShipCountsByLocation(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const company of this.targets) {
      for (const captain of company.captains) {
        const loc = captain.status === "AtLocation" ? captain.location : captain.destination;
        if (loc === null) continue;
        counts.set(loc, (counts.get(loc) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** This brigade's own current distribution across Locations, in the same AtLocation-or-heading-toward convention as targetShipCountsByLocation -- what directFleet compares against the target density to find under-covered spots. */
  private pirateShipCountsByLocation(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const captain of this.captains) {
      const loc = captain.status === "AtLocation" ? captain.location : captain.destination;
      if (loc === null) continue;
      counts.set(loc, (counts.get(loc) ?? 0) + 1);
    }
    return counts;
  }

  private policePresentAt(location: string): boolean {
    for (const policeFleet of this.policeFleets) {
      for (const captain of policeFleet.captains) {
        if (captain.status === "AtLocation" && captain.location === location) return true;
      }
    }
    return false;
  }

  /** Whether `pirateCaptain` is fit to raid right now -- independent of its own InTransit/AtLocation status (see coLocatedTarget / maybeAttackOnArrival). */
  private isEligibleAttacker(pirateCaptain: Captain): boolean {
    return (
      pirateCaptain.groundedDaysRemaining === 0 &&
      pirateCaptain.carousing <= this.maxCarousingToAttack &&
      !this.policePresentAt(pirateCaptain.location)
    );
  }

  /**
   * A still-available target Company/SoloTrader captain sharing `pirateCaptain`'s
   * Location -- matched purely on the `location` field, regardless of either
   * side's InTransit/AtLocation status. A ship mid-multi-leg-refuel sits at an
   * intermediate node with `location` updated but status still "InTransit"
   * (see Captain.arrive), and a ship that departed/arrived earlier today keeps
   * its pre-move `location` until its next arrival -- both are exposed here on
   * purpose, matching a raider that can strike anyone currently sitting at its
   * anchorage, moving or not.
   */
  private coLocatedTarget(pirateCaptain: Captain): Captain | null {
    if (!this.isEligibleAttacker(pirateCaptain)) return null;
    for (const company of this.targets) {
      for (const captain of company.captains) {
        if (this.victimsHitToday.has(captain)) continue;
        if (captain.location === pirateCaptain.location) return captain;
      }
    }
    return null;
  }

  /**
   * Called by Captain.act() the instant a tracked Company/SoloTrader captain
   * arrives somewhere, BEFORE it sells/delivers its cargo that same act()
   * call -- directFleet's own scan runs once per day, before any captain's
   * act(), so it can never catch a ship that arrives and immediately sells
   * within that same day. This gives a co-located, still-available pirate a
   * shot at it right then instead. Shares attackersUsedToday/victimsHitToday
   * with directFleet's scan so a pair never attacks/gets attacked twice in
   * one day regardless of which path fires.
   */
  maybeAttackOnArrival(day: number, victimCaptain: Captain, sellMarkets: Map<string, Market>): void {
    if (!(victimCaptain.company instanceof Company) || !this.targets.includes(victimCaptain.company)) return;
    if (this.victimsHitToday.has(victimCaptain)) return;
    for (const pirateCaptain of this.captains) {
      if (this.attackersUsedToday.has(pirateCaptain)) continue;
      if (pirateCaptain.location !== victimCaptain.location) continue;
      if (!this.isEligibleAttacker(pirateCaptain)) continue;
      this.attack(day, pirateCaptain, victimCaptain, sellMarkets);
      this.attackersUsedToday.add(pirateCaptain);
      this.victimsHitToday.add(victimCaptain);
      pirateCaptain.groundedDaysRemaining = Math.max(pirateCaptain.groundedDaysRemaining, 1);
      return;
    }
  }

  private applyDailyCarousing(captain: Captain): void {
    const cost = captain.transport!.crew.length * this.carousingCostPerCrew;
    if (captain.cash < cost) return;
    captain.cash -= cost;
    captain.carousing += this.carousingIncreaseByDay;
    if (captain.carousing > this.maxCarousing) {
      captain.carousing = 0.0;
      captain.groundedDaysRemaining = Math.max(captain.groundedDaysRemaining, 1);
    }
  }

  private attack(day: number, pirateCaptain: Captain, victimCaptain: Captain, sellMarkets: Map<string, Market>): void {
    const victimPoolsCash = victimCaptain.company !== null && victimCaptain.company.poolsCash;
    const stolenCash = victimPoolsCash ? 0.0 : round2(victimCaptain.cash * this.raidFraction);

    let seizedCommodity: string | null = null;
    let seizedQuantity = 0.0;
    let destroyedQuantity = 0.0;
    let fencePrice: number | null = null;
    let fencedProceeds = 0.0;
    if (victimCaptain.cargo !== null) {
      const cargo = victimCaptain.cargo;
      const market = sellMarkets.get(marketKey(pirateCaptain.location, cargo.commodity));
      const unitValue = market !== undefined ? market.price : cargo.unitCost;
      const location = getLocation(pirateCaptain.location);
      const fenceFraction = location !== undefined ? location.fenceFraction : 0.5;
      seizedCommodity = cargo.commodity;
      seizedQuantity = cargo.quantity;

      // A raid is messy -- some of the haul gets damaged, dumped, or lost in
      // the scuffle before it ever reaches the fence, rolled fresh per
      // attack (see MIN/MAX_CARGO_DESTRUCTION_FRACTION). Only what survives
      // gets fenced; the rest is gone regardless of fenceFraction.
      const destructionFraction = randUniform(MIN_CARGO_DESTRUCTION_FRACTION, MAX_CARGO_DESTRUCTION_FRACTION);
      destroyedQuantity = round2(cargo.quantity * destructionFraction);
      const fenceableQuantity = cargo.quantity - destroyedQuantity;

      fencePrice = round2(unitValue * fenceFraction);
      fencedProceeds = round2(fencePrice * fenceableQuantity);
      victimCaptain.cargo = null;

      // The fence doesn't just pay cash for the surviving goods -- it takes
      // physical possession, so they re-enter circulation at wherever the
      // pirate happens to be docked, rather than vanishing from the economy
      // (the destroyed portion above, unlike this, is gone for good).
      if (location !== undefined && fenceableQuantity > 0) {
        location.stockpiles[cargo.commodity] = (location.stockpiles[cargo.commodity] ?? 0) + fenceableQuantity;
      }

      // Contract-bound cargo never reaches its destination either way (fenced
      // or destroyed), so the delivery is cancelled outright -- the fulfiller
      // is never paid (fulfillContract only pays out on actual arrival, which
      // can no longer happen now that cargo is null) and the pair becomes
      // eligible for a fresh tender again (see World's activeContractKeys /
      // ContractFulfiller.pruneFulfilled).
      if (cargo.contract !== null) {
        cargo.contract.cancelled = true;
        cargo.contract.inFlightCaptain = null;
      }
    }

    const totalGain = round2(stolenCash + fencedProceeds);
    if (totalGain <= 0 && seizedCommodity === null) return;

    victimCaptain.cash -= stolenCash;
    pirateCaptain.cash += totalGain;

    pirateCaptain.tradeLog.push({
      day,
      action: "ATTACK",
      commodity: seizedCommodity,
      location: pirateCaptain.location,
      destination: victimCaptain.name,
      quantity: round2(seizedQuantity),
      price: fencePrice,
      distance: null,
      routeType: null,
      travelDays: null,
      fuelPrice: null,
      fuelUnitsConsumed: null,
      fuelCostPaid: 0.0,
      profit: totalGain,
    });
    let detail = stolenCash > 0 ? `-$${stolenCash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} cash` : "cash pooled -- untouchable";
    if (seizedCommodity !== null) {
      detail += `, ${seizedQuantity.toFixed(1)} ${seizedCommodity} seized (${destroyedQuantity.toFixed(1)} destroyed) and fenced for ${fencedProceeds.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    victimCaptain.agentEventLog.push({
      day,
      location: victimCaptain.location,
      name: `Pirate attack by ${pirateCaptain.name} (${this.name})`,
      kind: "cash_loss",
      detail,
    });
  }

  directFleet(
    day: number,
    _buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    _commodities: string[],
    closedLocations: ReadonlySet<string>,
    _board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Captain, Directive> {
    this.attackersUsedToday = new Set();
    this.victimsHitToday = new Set();

    for (const captain of this.captains) {
      if (captain.status === "AtLocation") this.applyDailyCarousing(captain);
    }

    const needsScan = this.lastScanDay === null || day - this.lastScanDay >= this.laziness;
    if (needsScan) {
      const targetCounts = this.targetShipCountsByLocation();
      const totalTargets = [...targetCounts.values()].reduce((a, b) => a + b, 0);
      this.cachedTargetDensity = totalTargets > 0
        ? new Map([...targetCounts.entries()].map(([loc, count]) => [loc, count / totalTargets]))
        : new Map();
      this.lastScanDay = day;
    }

    const targetDensity = this.cachedTargetDensity;
    if (targetDensity === null || targetDensity.size === 0) return new Map();

    // Tracks this brigade's own distribution as directives are handed out
    // below, so multiple idle ships assigned within the same day's pass see
    // each other's moves and spread out, rather than every one of them
    // independently piling onto whichever single spot looked most
    // under-covered at the start of the day.
    const pirateCounts = this.pirateShipCountsByLocation();
    const totalPirates = this.captains.length;

    const directives = new Map<Captain, Directive>();
    for (const captain of this.captains) {
      // Attack eligibility no longer requires AtLocation (see
      // isEligibleAttacker/coLocatedTarget) -- checked for every captain,
      // not just idle ones, so a ship mid-multi-leg-refuel sitting at an
      // intermediate node can still ambush someone there. Only the
      // reposition assignment below stays gated to idle-in-port captains.
      const victim = this.coLocatedTarget(captain);
      if (victim !== null) {
        this.attack(day, captain, victim, sellMarkets);
        this.attackersUsedToday.add(captain);
        this.victimsHitToday.add(victim);
        captain.groundedDaysRemaining = Math.max(captain.groundedDaysRemaining, 1);
        continue;
      }

      if (!captain.isIdleInPort(closedLocations)) continue;

      // Rank every Location with Company/SoloTrader presence by how far
      // short of its target-density share this brigade's OWN ship count
      // there currently falls (desired - current), most-deficient first --
      // matching pirate density to target density instead of the old
      // winner-take-all chase of a single busiest hotspot.
      const ranked = [...targetDensity.entries()]
        .map(([loc, density]) => ({ loc, deficit: density * totalPirates - (pirateCounts.get(loc) ?? 0) }))
        .sort((a, b) => b.deficit - a.deficit);

      for (const { loc } of ranked) {
        if (loc === captain.location || closedLocations.has(loc)) continue;
        if (!captain.transport!.canUseRoute(getRoute(captain.location, loc))) continue;
        directives.set(captain, { action: "REPOSITION", destination: loc });
        pirateCounts.set(loc, (pirateCounts.get(loc) ?? 0) + 1);
        pirateCounts.set(captain.location, Math.max(0, (pirateCounts.get(captain.location) ?? 0) - 1));
        break;
      }
    }
    return directives;
  }
}

/**
 * A law-enforcement Faction -- currently pure random-wandering patrol.
 * Government-funded: always pools cash into a bottomless, infinite pool.
 */
export class PoliceFleet extends Faction {
  override get poolsCash(): boolean {
    return true;
  }

  targets: PirateBrigade[];
  patrolIntervalDays: number;
  private lastPatrolDay = new Map<Captain, number>();

  constructor(
    name: string,
    crew: FleetCrew,
    targets: PirateBrigade[] | null = null,
    patrolIntervalDays: number = 5,
  ) {
    super(name, crew, Infinity);
    this.targets = targets ?? [];
    this.patrolIntervalDays = patrolIntervalDays;
  }

  private randomPatrolDestination(
    captain: Captain,
    allLocations: ReadonlySet<string>,
    closedLocations: ReadonlySet<string>,
  ): string | null {
    const candidates = [...allLocations].filter(
      (loc) =>
        loc !== captain.location &&
        !closedLocations.has(loc) &&
        captain.transport!.canUseRoute(getRoute(captain.location, loc)),
    );
    if (candidates.length === 0) return null;
    return randChoice(candidates);
  }

  directFleet(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    _commodities: string[],
    closedLocations: ReadonlySet<string>,
    _board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Captain, Directive> {
    const allLocations = new Set<string>();
    for (const m of buyMarkets.values()) allLocations.add(m.locationName);
    for (const m of sellMarkets.values()) allLocations.add(m.locationName);

    const directives = new Map<Captain, Directive>();
    for (const captain of this.captains) {
      if (!captain.isIdleInPort(closedLocations)) continue;

      const lastPatrolDay = this.lastPatrolDay.get(captain);
      if (lastPatrolDay !== undefined && day - lastPatrolDay < this.patrolIntervalDays) continue;

      const destination = this.randomPatrolDestination(captain, allLocations, closedLocations);
      if (destination === null) continue;

      directives.set(captain, { action: "REPOSITION", destination });
      this.lastPatrolDay.set(captain, day);
    }
    return directives;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
