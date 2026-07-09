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
import { Market, marketKey } from "./markets";
import { randChoice } from "./simRandom";
import type { Contract } from "./contracts";

export type FleetCrew = Array<[Transport, Captain, string]>;

export class Faction {
  get poolsCash(): boolean {
    return true;
  }

  name: string;
  captains: Captain[] = [];
  startingCash: number;
  /** The single shared pool every captain's `cash` reads/writes through -- only meaningful when poolsCash. */
  cash: number = 0;

  constructor(name: string, crew: FleetCrew, startingCash: number = 0.0) {
    this.name = name;
    for (const [transport, captain, homeLocation] of crew) {
      captain.transport = transport;
      captain.location = homeLocation;
      this.captains.push(captain);

      transport.crew = [captain];
      const extraSeats = Math.max(0, transport.crewRequirement - 1);
      for (let i = 0; i < extraSeats; i++) {
        transport.crew.push(new Sailor(`${transport.name} Sailor ${i + 2}`, transport));
      }
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

  totalCash(): number {
    if (this.poolsCash) return this.cash;
    return this.captains.reduce((sum, c) => sum + c.cash, 0);
  }

  netWorth(sellMarkets: Map<string, Market>): number {
    let total = this.totalCash();
    for (const t of this.captains) {
      if (t.cargo !== null) {
        const markLocation = t.status === "AtLocation" ? t.location : t.cargo.destination;
        const market = sellMarkets.get(marketKey(markLocation, t.cargo.commodity));
        const unitValue = market !== undefined ? market.price : t.cargo.unitCost;
        total += unitValue * t.cargo.quantity;
      }
    }
    return total;
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
    _closedLocations: ReadonlySet<string> = new Set(),
    _contracts: readonly Contract[] = [],
  ): Map<Captain, Directive> {
    return new Map();
  }
}

/**
 * A Faction that actively directs its fleet: coordinated routing (every
 * idle transport's best local route is scored and assigned in descending
 * daily-return order, spreading coverage rather than piling onto one
 * route) plus shared capital (inherited from Faction). Also the only kind
 * of Faction that claims and services supply Contracts (see
 * `acceptsContracts`, overridden to false on SoloTrader) -- claimed
 * contracts are serviced before any arbitrage routing is even considered.
 */
export class Company extends Faction {
  /** Contracts claimed by this Company -- see claimOpenContracts/serviceContracts. */
  contracts: Contract[] = [];

  get acceptsContracts(): boolean {
    return true;
  }

  directFleet(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string> = new Set(),
    openContracts: readonly Contract[] = [],
  ): Map<Captain, Directive> {
    const idle = this.captains.filter((t) => t.isIdleInPort(closedLocations));
    if (idle.length === 0) return new Map();

    const directives = new Map<Captain, Directive>();
    const assigned = new Set<Captain>();

    if (this.acceptsContracts) {
      this.claimOpenContracts(openContracts);
      this.serviceContracts(day, idle, assigned, directives, buyMarkets, closedLocations);
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
   * Claim any still-unclaimed Contract, capped at roughly one contract's
   * worth of dedicated capacity per ship (`contracts.length < captains.length`)
   * so a single Company (especially whichever happens to act first each day)
   * can't monopolize every contract in the world -- leaving the rest for
   * other Companies to pick up.
   */
  private claimOpenContracts(openContracts: readonly Contract[]): void {
    for (const contract of openContracts) {
      if (this.contracts.length >= this.captains.length) break;
      if (contract.company === null) {
        contract.company = this;
        this.contracts.push(contract);
      }
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
    day: number,
    idle: Captain[],
    assigned: Set<Captain>,
    directives: Map<Captain, Directive>,
    buyMarkets: Map<string, Market>,
    closedLocations: ReadonlySet<string>,
  ): void {
    for (const contract of this.contracts) {
      if (assigned.size >= idle.length) break;
      if (contract.inFlightCaptain !== null) continue;
      const due = contract.lastDeliveryDay === null || day - contract.lastDeliveryDay >= contract.intervalDays;
      if (!due) continue;

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

      let best: { captain: Captain; destination: string; distance: number } | null = null;
      for (const captain of idle) {
        if (assigned.has(captain)) continue;
        for (const market of buyMarkets.values()) {
          if (market.commodityName !== contract.commodity || !market.isAvailable) continue;
          if (closedLocations.has(market.locationName)) continue;
          if (!captain.transport!.canUseRoute(getRoute(captain.location, market.locationName))) continue;
          const dist = distanceBetween(captain.location, market.locationName);
          if (best === null || dist < best.distance) {
            best = { captain, destination: market.locationName, distance: dist };
          }
        }
      }
      if (best !== null) {
        directives.set(best.captain, { action: "REPOSITION", destination: best.destination });
        assigned.add(best.captain);
      }
    }
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
 * private balance. Also opts out of the Contract system entirely: Locations
 * only offer contracts to (and SoloTrader never claims from) pooled
 * Companies.
 */
export class SoloTrader extends Company {
  override get poolsCash(): boolean {
    return false;
  }

  override get acceptsContracts(): boolean {
    return false;
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
  private cachedRankedLocations: string[] | null = null;
  private lastScanDay: number | null = null;

  constructor(
    name: string,
    crew: FleetCrew,
    targets: Company[],
    startingCash: number = 0.0,
    laziness: number = 1,
    raidFraction: number = 0.1,
    maxCarousingToAttack: number = 50.0,
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

  private policePresentAt(location: string): boolean {
    for (const policeFleet of this.policeFleets) {
      for (const captain of policeFleet.captains) {
        if (captain.status === "AtLocation" && captain.location === location) return true;
      }
    }
    return false;
  }

  private coLocatedTarget(pirateCaptain: Captain, alreadyAttacked: ReadonlySet<Captain>): Captain | null {
    if (pirateCaptain.carousing > this.maxCarousingToAttack) return null;
    if (this.policePresentAt(pirateCaptain.location)) return null;
    for (const company of this.targets) {
      for (const captain of company.captains) {
        if (alreadyAttacked.has(captain)) continue;
        if (captain.status === "AtLocation" && captain.location === pirateCaptain.location) return captain;
      }
    }
    return null;
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
      fencePrice = round2(unitValue * fenceFraction);
      fencedProceeds = round2(fencePrice * seizedQuantity);
      victimCaptain.cargo = null;
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
      detail += `, ${seizedQuantity.toFixed(1)} ${seizedCommodity} seized and fenced for ${fencedProceeds.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
    closedLocations: ReadonlySet<string> = new Set(),
    _contracts: readonly Contract[] = [],
  ): Map<Captain, Directive> {
    for (const captain of this.captains) {
      if (captain.status === "AtLocation") this.applyDailyCarousing(captain);
    }

    const needsScan = this.lastScanDay === null || day - this.lastScanDay >= this.laziness;
    if (needsScan) {
      const targetCounts = this.targetShipCountsByLocation();
      this.cachedRankedLocations = [...targetCounts.keys()].sort(
        (a, b) => (targetCounts.get(b) ?? 0) - (targetCounts.get(a) ?? 0),
      );
      this.lastScanDay = day;
    }

    const rankedLocations = this.cachedRankedLocations;
    if (rankedLocations === null || rankedLocations.length === 0) return new Map();

    const directives = new Map<Captain, Directive>();
    const alreadyAttacked = new Set<Captain>();
    for (const captain of this.captains) {
      if (!captain.isIdleInPort(closedLocations)) continue;

      const victim = this.coLocatedTarget(captain, alreadyAttacked);
      if (victim !== null) {
        this.attack(day, captain, victim, sellMarkets);
        alreadyAttacked.add(victim);
        captain.groundedDaysRemaining = Math.max(captain.groundedDaysRemaining, 1);
        continue;
      }

      for (const loc of rankedLocations) {
        if (loc === captain.location || closedLocations.has(loc)) continue;
        if (!captain.transport!.canUseRoute(getRoute(captain.location, loc))) continue;
        directives.set(captain, { action: "REPOSITION", destination: loc });
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
    closedLocations: ReadonlySet<string> = new Set(),
    _contracts: readonly Contract[] = [],
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
