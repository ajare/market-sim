/**
 * Captain: a profit-seeking agent that buys low and sells high, running a
 * single Transport between locations. Ported from sim/captain.py -- see
 * that file's (and Architecture.md section 6's) extensive docstrings for
 * the economic reasoning; comments here are kept light since the logic is
 * transcribed 1:1.
 */
import { Sailor, JOURNEYS_PER_HIRE } from "./sailor";
import type { Faction, PirateBrigade } from "./faction";
import { TransportEvent, type TransportEventKind } from "./events";
import { Ship, crewSpeedFraction, type TransportStatus } from "./transport";
import { distanceBetween, travelDaysBetween, getLocation } from "./worldData";
import { getRoutes, routeTravelDays, type Route, type RouteType } from "./routes";
import { findShortestPath, pathNodeSequence } from "./pathfinding";
import { Market, marketKey } from "./markets";
import { randRandom } from "./simRandom";
import type { Contract } from "./contracts";
import { round2 } from "./utils";
import type { PersonInit } from "./person";
import type { Location } from "./location";
import { hireFromSailorPool, addToSailorPool } from "./sailorPool";

export interface CargoState {
  commodity: string;
  quantity: number;
  unitCost: number;
  origin: string;
  destination: string;
  distance: number;
  routeType: string;
  travelDays: number;
  fuelPricePaid: number;
  fuelUnitsConsumed: number;
  fuelCostTotal: number;
  totalCost: number;
  departureDay: number;
  /** Set when this cargo is being delivered against a supply Contract rather than sold on the open market -- see Captain.fulfillContract. */
  contract: Contract | null;
}

export type TradeAction = "BUY" | "SELL" | "REFUEL" | "REPOSITION" | "ATTACK" | "SMUGGLE";

// Tunable knobs for smuggling -- a SoloTrader-only ability (Faction.canSmuggle,
// see faction.ts) to sell cargo through a closed port's black market instead
// of waiting for it to reopen. See Captain.maybeSmuggle.

/** Chance a smuggling attempt is caught each day it's tried. Caught cargo is seized outright (no proceeds) and a fine is deducted -- see SMUGGLING_FINE_FRACTION. */
export const SMUGGLING_DETECTION_PROBABILITY = 0.25;

/** Black-market sale price, as a fraction of the market's last live price (frozen while the port is closed) -- the discount a black-market buyer demands for the risk. */
export const SMUGGLING_PRICE_DISCOUNT = 0.7;

/** Fine on getting caught, as a fraction of what the seized cargo would have sold for at the (undiscounted) market price. */
export const SMUGGLING_FINE_FRACTION = 0.3;

export interface TradeLogEntry {
  day: number;
  action: TradeAction;
  commodity: string | null;
  location: string;
  destination: string | null;
  quantity: number;
  price: number | null;
  distance: number | null;
  routeType: string | null;
  travelDays: number | null;
  fuelPrice: number | null;
  fuelUnitsConsumed: number | null;
  fuelCostPaid: number;
  profit: number | null;
}

export interface AgentEventLogEntry {
  day: number;
  location: string;
  name: string;
  kind: TransportEventKind;
  detail: string;
}

export interface PortfolioSnapshot {
  day: number;
  location: string;
  status: TransportStatus;
  cash: number;
  cargoValue: number;
  totalValue: number;
  realizedProfit: number;
  totalFuelSpent: number;
}

export interface RouteEconomics {
  distance: number;
  routeType: string;
  travelDays: number;
  fuelPrice: number;
  fuelUnitsConsumed: number;
  fuelCostPerUnit: number;
  totalCost: number;
  expectedRevenue: number;
  expectedProfit: number;
  dailyReturnPct: number;
  path: Route[] | null;
  crewCost: number;
  /** Cargo quantity this estimate was costed against -- lets a Faction gauge how much of a route's demand one ship covers. */
  quantity: number;
}

export interface TradeDirective extends RouteEconomics {
  commodity: string;
  destination: string;
}

export interface RepositionDirective {
  action: "REPOSITION";
  destination: string;
}

/** Directs an idle captain, already sitting at a valid producer, to buy and ship a due Contract's delivery. */
export interface ContractDeliveryDirective {
  action: "CONTRACT_DELIVER";
  contract: Contract;
}

export type Directive = TradeDirective | RepositionDirective | ContractDeliveryDirective;

function isRepositionDirective(d: Directive): d is RepositionDirective {
  return "action" in d && d.action === "REPOSITION";
}

function isContractDeliveryDirective(d: Directive): d is ContractDeliveryDirective {
  return "action" in d && d.action === "CONTRACT_DELIVER";
}

function excludeRouteKey(commodity: string, location: string): string {
  return `${commodity}||${location}`;
}

export interface CaptainInit extends Omit<PersonInit, "location" | "transport" | "dailyWage"> {
  homeLocation: Location;
  startingCash?: number | null;
  repositionReturnMultiplier?: number;
  minDailyReturnPct?: number;
  priceImpact?: number;
  agentEventProbability?: number;
  carousing?: number;
}

export class Captain extends Sailor {
  carousing: number;
  private _ownCash: number;
  startingCash: number | null;
  repositionReturnMultiplier: number;
  minDailyReturnPct: number;
  priceImpact: number;
  agentEventProbability: number;
  company: Faction | null = null;

  destination: string | null = null;
  daysRemaining = 0;
  cargo: CargoState | null = null;
  path: Route[] = [];
  private dailyFuelBurn = 0.0;

  activeAgentEvents: TransportEvent[] = [];
  eventLog: TransportEvent[] = [];
  groundedDaysRemaining = 0;
  agentEventLog: AgentEventLogEntry[] = [];

  tradeLog: TradeLogEntry[] = [];
  realizedProfit = 0.0;
  totalFuelSpent = 0.0;
  totalFuelUnitsConsumed = 0.0;
  totalFixedFeesSpent = 0.0;
  totalRepositions = 0;
  portfolioHistory: PortfolioSnapshot[] = [];

  constructor(init: CaptainInit) {
    // dailyWage forced to 0 -- Captains are unpaid, unlike a plain Sailor's
    // DEFAULT_SAILOR_DAILY_WAGE (see sailor.ts). location (not transport) is
    // set to homeLocation here, matching Person's AT/ON invariant for a
    // freshly constructed, not-yet-crewed Captain; Faction's constructor
    // moves it onto the Transport (see Person.boardTransport) once assigned.
    super({ ...init, dailyWage: 0.0, location: init.homeLocation });
    this.rank = "Captain";
    this.carousing = init.carousing ?? 0.0;
    this._ownCash = init.startingCash ?? 0.0;
    this.startingCash = init.startingCash ?? null;
    this.repositionReturnMultiplier = init.repositionReturnMultiplier ?? 1.25;
    this.minDailyReturnPct = init.minDailyReturnPct ?? 0.02;
    this.priceImpact = init.priceImpact ?? 0.01;
    this.agentEventProbability = init.agentEventProbability ?? 0.005;
  }

  /** Funds live on whichever Faction owns this transport (if it pools cash), else this Captain's own balance. */
  get cash(): number {
    if (this.company !== null && this.company.poolsCash) return this.company.cash;
    return this._ownCash;
  }

  set cash(value: number) {
    if (this.company !== null && this.company.poolsCash) {
      this.company.cash = value;
    } else {
      this._ownCash = value;
    }
  }

  /** Grants direct access to this captain's own private balance, bypassing any pooling -- used by Faction.__init__. */
  get ownCash(): number {
    return this._ownCash;
  }
  set ownCash(value: number) {
    this._ownCash = value;
  }

  get status(): TransportStatus {
    return this.transport!.status;
  }
  set status(value: TransportStatus) {
    this.transport!.status = value;
  }

  /**
   * The name of wherever this Captain's Transport currently is (docked, or
   * mid-multi-hop-transit's last waypoint) -- see Transport.currentNode.
   * Every pathfinding/market-key/log-entry site (in this file and beyond --
   * see faction.ts/NetworkView.tsx/FleetPanel.tsx) reads this, not the
   * inherited Person location field, which stays null the whole time a
   * Captain has a Transport (see Person.boardTransport), by design.
   */
  get locationName(): string {
    return this.transport!.currentNode!;
  }

  private applyPriceImpact(market: Market, units: number, direction: "buy" | "sell"): void {
    if (market.fixedPrice) return;
    const magnitude = (this.priceImpact * units) / (units + 50.0);
    if (direction === "buy") {
      market.price = market.price * (1 + magnitude);
    } else {
      market.price = Math.max(0.5, market.price * (1 - magnitude));
    }
  }

  private activeDiscount(kind: TransportEventKind): number {
    const total = this.activeAgentEvents
      .filter((e) => e.kind === kind)
      .reduce((sum, e) => sum + e.magnitude, 0);
    return Math.min(0.9, total);
  }

  private currentFuelConsumptionRate(): number {
    return this.transport!.fuelConsumptionPerUnitDistance * (1 - this.activeDiscount("fuel_discount"));
  }
  private currentRepositionFuelRate(): number {
    return this.transport!.repositionFuelConsumptionPerDistance * (1 - this.activeDiscount("fuel_discount"));
  }
  private currentFixedShipmentCost(): number {
    return this.transport!.fixedShipmentCost * (1 - this.activeDiscount("fixed_cost_discount"));
  }

  private dailyCrewCost(): number {
    return this.transport!.crew.reduce((sum, member) => sum + member.dailyWage, 0);
  }

  /**
   * Effective speed given how fully crewed this Transport currently is.
   * Ships only: 50% of speedUnitsPerDay with just the Captain aboard, up to
   * 100% at a full complement (crewRequirement), linear in between (see
   * hireCrewIfPossible). Every other Transport type is unaffected -- always
   * its plain speedUnitsPerDay.
   */
  private currentSpeedUnitsPerDay(): number {
    return this.transport!.speedUnitsPerDay * crewSpeedFraction(this.transport!);
  }

  /**
   * If this Captain's Ship is docked at a Sea-capable Location (Port or
   * Platform -- both count identically, see ROUTE_TERMINAL_COMPATIBILITY)
   * and isn't at full complement, hires as many Sailors as that Location's
   * pool has available to fill open seats, up to every seat in one day.
   * Hiring itself is free -- the only cost is the upfront wage the next time
   * this Ship actually departs (see routeEconomics/dailyCrewCost). If the
   * local pool falls short, the remaining seats simply stay open (no Sailor
   * is ever generated fresh here) -- the Ship sails under-crewed and slower
   * (see crewSpeedFraction) rather than waiting. No-op for every other
   * Transport type.
   *
   * A hire made for a Company/SoloTrader (Faction.rotatesCrew) is only good
   * for JOURNEYS_PER_HIRE journeys before disembarking again -- see
   * advanceCrewRotation. A PirateBrigade/PoliceFleet hire is permanent.
   */
  private hireCrewIfPossible(): void {
    const transport = this.transport!;
    if (!(transport instanceof Ship)) return;
    const seatsOpen = transport.crewRequirement - transport.crew.length;
    if (seatsOpen <= 0) return;
    const location = transport.location;
    if (location === null || !(location.terminalTypes.has("Port") || location.terminalTypes.has("Platform"))) return;
    const hired = hireFromSailorPool(location.name, seatsOpen);
    const rotates = this.company?.rotatesCrew === true;
    for (const sailor of hired) {
      if (rotates) sailor.journeysRemaining = JOURNEYS_PER_HIRE;
      sailor.boardTransport(transport);
      transport.crew.push(sailor);
    }
  }

  private routeEconomics(
    origin: string,
    destination: string,
    buyPrice: number,
    sellPriceEstimate: number,
    quantity: number,
    fuelPrice: number,
    buyMarkets: Map<string, Market>,
  ): RouteEconomics {
    const infeasible: RouteEconomics = {
      distance: 0.0, routeType: "unreachable", travelDays: 0,
      fuelPrice, fuelUnitsConsumed: 0.0, fuelCostPerUnit: 0.0,
      totalCost: 0.0, expectedRevenue: 0.0, expectedProfit: -1.0,
      dailyReturnPct: -1.0, path: null, crewCost: 0.0, quantity: 0.0,
    };

    const path = findShortestPath(origin, destination, (r) => this.transport!.canUseRoute(r));
    if (path === null) return infeasible;

    const nodes = pathNodeSequence(origin, path);
    const fuelRate = this.currentFuelConsumptionRate();
    let totalDistance = 0.0;
    let totalDays = 0;
    let totalFuelUnits = 0.0;
    let totalFuelCost = 0.0;
    const routeTypes: RouteType[] = [];

    for (let i = 0; i < path.length; i++) {
      const legOrigin = nodes[i];
      const route = path[i];
      const legFuelUnits = route.distance * fuelRate * quantity;
      if (legFuelUnits > this.transport!.fuelCapacity) {
        return infeasible;
      }

      const legFuelMarket = buyMarkets.get(marketKey(legOrigin, "Fuel"));
      const legFuelPrice = legFuelMarket !== undefined ? legFuelMarket.price : fuelPrice;

      totalDistance += route.distance;
      totalDays += routeTravelDays(route, this.currentSpeedUnitsPerDay());
      totalFuelUnits += legFuelUnits;
      totalFuelCost += legFuelUnits * legFuelPrice;
      if (!routeTypes.includes(route.routeType)) routeTypes.push(route.routeType);
    }

    const crewCost = this.dailyCrewCost() * totalDays;
    const totalCost = quantity * buyPrice + totalFuelCost + this.currentFixedShipmentCost() + crewCost;
    const expectedRevenue = quantity * sellPriceEstimate;
    const expectedProfit = expectedRevenue - totalCost;
    const dailyReturnPct =
      totalCost > 0 && totalDays > 0 ? expectedProfit / totalCost / totalDays : -1.0;

    return {
      distance: totalDistance,
      routeType: routeTypes.length > 0 ? routeTypes.join("+") : "none",
      travelDays: totalDays,
      fuelPrice,
      fuelUnitsConsumed: totalFuelUnits,
      fuelCostPerUnit: quantity > 0 ? totalFuelCost / quantity : 0.0,
      totalCost,
      expectedRevenue,
      expectedProfit,
      dailyReturnPct,
      path,
      crewCost,
      quantity,
    };
  }

  act(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string> = new Set(),
    directedRoute: Directive | null = null,
    pirateBrigade: PirateBrigade | null = null,
  ): void {
    // No new TransportEvent is ever randomly rolled here -- events are
    // disabled -- but any already-active event (from a loaded scenario)
    // still applies and ticks down below.
    this.activeAgentEvents = this.activeAgentEvents.filter((e) => e.tick());

    let justArrived = false;
    if (this.status === "InTransit") {
      // Crew wages are no longer owed day-by-day here -- the whole trip's
      // crew cost is paid upfront at departure (see routeEconomics/
      // executeLocalRoute/executeContractDelivery/departEmptyTo), sized to
      // the estimated day count, so there's nothing left to deduct or check
      // affordability against while already underway.
      this.transport!.consumeFuel(this.dailyFuelBurn);
      this.daysRemaining -= 1;
      if (this.daysRemaining > 0) return;
      if (!this.arrive(day, buyMarkets, closedLocations)) return;
      justArrived = true;
      // Give a co-located pirate a shot at this delivery BEFORE it sells --
      // otherwise a ship that arrives and sells within the same act() call
      // is never observably "at this Location with cargo" at any day
      // boundary, and the once-a-day PirateBrigade scan (which runs before
      // any captain's act()) can never catch it. See PirateBrigade.maybeAttackOnArrival.
      pirateBrigade?.maybeAttackOnArrival(day, this, sellMarkets);
    }

    if (closedLocations.has(this.locationName)) {
      if (this.cargo !== null && this.company?.canSmuggle === true) {
        this.maybeSmuggle(day, sellMarkets);
      }
      return;
    }

    if (this.cargo !== null) {
      this.sellCargoIfPossible(day, sellMarkets);
    }

    if (this.groundedDaysRemaining > 0) {
      this.groundedDaysRemaining -= 1;
      return;
    }

    // Runs even on the arrival day itself -- a Ship shouldn't sit under-crewed
    // at a Port for a whole extra day just because it happened to just dock
    // there, before the "no same-day redeparture" rule below applies.
    this.hireCrewIfPossible();

    if (justArrived) return;

    if (this.cargo === null) {
      if (directedRoute !== null) {
        if (isRepositionDirective(directedRoute)) {
          this.executeDirectedReposition(directedRoute.destination, day, buyMarkets);
        } else if (isContractDeliveryDirective(directedRoute)) {
          this.executeContractDelivery(directedRoute.contract, day, buyMarkets);
        } else {
          this.executeLocalRoute(directedRoute, day, buyMarkets, sellMarkets);
        }
      } else {
        this.planAndDepart(day, buyMarkets, sellMarkets, commodities, closedLocations);
      }
    }
  }

  /** Returns true for a genuine arrival at the final destination; false if only an intermediate refueling stop. */
  private arrive(day: number, buyMarkets: Map<string, Market>, closedLocations: ReadonlySet<string>): boolean {
    this.transport!.arriveAt(getLocation(this.destination!)!);

    if (this.cargo !== null && this.path.length > 0) {
      const nextRoute = this.path.shift()!;
      const nextNode = nextRoute.origin === this.locationName ? nextRoute.destination : nextRoute.origin;
      const legFuelUnits = this.refuelAtStop(day, buyMarkets, nextRoute.distance, closedLocations);
      this.transport!.refuel(legFuelUnits);
      this.destination = nextNode;
      this.daysRemaining = routeTravelDays(nextRoute, this.currentSpeedUnitsPerDay());
      this.dailyFuelBurn = this.daysRemaining > 0 ? legFuelUnits / this.daysRemaining : 0.0;
      return false;
    }

    this.advanceCrewRotation();
    this.status = "AtLocation";
    this.destination = null;
    this.dailyFuelBurn = 0.0;
    return true;
  }

  /**
   * Ticks down every crew member's rotation counter by one journey (this
   * genuine final arrival counts as one, whether it closed out a local
   * trade, a contract delivery, or a reposition) and disembarks anyone whose
   * term just expired into this Location's Sailor pool. Only Company/
   * SoloTrader hires ever carry a non-null journeysRemaining (see
   * hireCrewIfPossible/Faction.rotatesCrew) -- the Captain and any
   * PirateBrigade/PoliceFleet crew are permanent and skip this entirely.
   */
  private advanceCrewRotation(): void {
    const transport = this.transport!;
    const location = transport.location!;
    const departing: Sailor[] = [];
    for (const member of transport.crew) {
      if (member.journeysRemaining === null) continue;
      member.journeysRemaining -= 1;
      if (member.journeysRemaining <= 0) departing.push(member);
    }
    for (const member of departing) {
      transport.removeCrewMember(member);
      member.disembarkAt(location);
      addToSailorPool(location.name, member);
    }
  }

  private refuelAtStop(
    day: number,
    buyMarkets: Map<string, Market>,
    nextLegDistance: number,
    closedLocations: ReadonlySet<string>,
  ): number {
    if (closedLocations.has(this.locationName)) return 0.0;
    const fuelUnits = nextLegDistance * this.currentFuelConsumptionRate() * this.cargo!.quantity;
    if (fuelUnits <= 0) return 0.0;
    const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    const fuelCost = fuelUnits * fuelPrice;

    this.cash -= fuelCost;
    this.totalFuelSpent += fuelCost;
    this.totalFuelUnitsConsumed += fuelUnits;
    this.cargo!.fuelUnitsConsumed += fuelUnits;
    this.cargo!.fuelCostTotal += fuelCost;
    this.cargo!.totalCost += fuelCost;
    if (fuelMarket !== undefined) this.applyPriceImpact(fuelMarket, fuelUnits, "buy");

    this.tradeLog.push({
      day,
      action: "REFUEL",
      commodity: this.cargo!.commodity,
      location: this.locationName,
      destination: this.cargo!.destination,
      quantity: 0.0,
      price: null,
      distance: null,
      routeType: null,
      travelDays: null,
      fuelPrice: round2(fuelPrice),
      fuelUnitsConsumed: round2(fuelUnits),
      fuelCostPaid: round2(fuelCost),
      profit: null,
    });
    return fuelUnits;
  }

  /** True if this transport could be given a fresh route order right now. */
  isIdleInPort(closedLocations: ReadonlySet<string> = new Set()): boolean {
    return (
      this.status === "AtLocation" &&
      this.cargo === null &&
      this.groundedDaysRemaining === 0 &&
      !closedLocations.has(this.locationName)
    );
  }

  private sellCargoIfPossible(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    if (this.cargo.contract !== null) {
      this.fulfillContract(day, sellMarkets);
      return;
    }
    const market = sellMarkets.get(marketKey(this.locationName, this.cargo.commodity));
    if (market === undefined || !market.isAvailable) return;

    const sellPrice = market.price;
    const proceeds = sellPrice * this.cargo.quantity;
    const profit = proceeds - this.cargo.totalCost;

    this.cash += proceeds;
    this.realizedProfit += profit;
    this.applyPriceImpact(market, this.cargo.quantity, "sell");
    market.applyTrade(this.cargo.quantity);
    market.location.cash -= proceeds;

    this.tradeLog.push({
      day,
      action: "SELL",
      commodity: this.cargo.commodity,
      location: this.locationName,
      destination: null,
      quantity: round2(this.cargo.quantity),
      price: round2(sellPrice),
      distance: this.cargo.distance,
      routeType: this.cargo.routeType,
      travelDays: this.cargo.travelDays,
      fuelPrice: round2(this.cargo.fuelPricePaid),
      fuelUnitsConsumed: round2(this.cargo.fuelUnitsConsumed),
      fuelCostPaid: round2(this.cargo.fuelCostTotal),
      profit: round2(profit),
    });
    this.cargo = null;
  }

  /**
   * SoloTrader-only (see Faction.canSmuggle): sell cargo through a closed
   * port's black market instead of just waiting for it to reopen. Tried
   * automatically, once per day, for as long as this Captain sits at a
   * closed port holding cargo. Priced at `SMUGGLING_PRICE_DISCOUNT` off the
   * market's last live price (frozen while closed, since a black-market
   * buyer demands a cut for the risk); the port's own books never see the
   * deal (unlike `sellCargoIfPossible`, this never touches
   * `market.location.cash`), though the physical stockpile still moves --
   * the goods really do change hands. Each attempt risks getting caught
   * (`SMUGGLING_DETECTION_PROBABILITY`): caught cargo is seized outright --
   * no proceeds, no stockpile change -- plus a fine (`SMUGGLING_FINE_FRACTION`
   * of what it would have sold for at the real price).
   */
  private maybeSmuggle(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    if (this.cargo.contract !== null) return; // SoloTrader never accepts Contracts to begin with
    const market = sellMarkets.get(marketKey(this.locationName, this.cargo.commodity));
    if (market === undefined || !market.isAvailable) return;

    const cargo = this.cargo;
    if (randRandom() < SMUGGLING_DETECTION_PROBABILITY) {
      const fine = round2(Math.min(market.price * cargo.quantity * SMUGGLING_FINE_FRACTION, this.cash));
      this.cash -= fine;
      this.realizedProfit -= fine + cargo.totalCost;
      this.tradeLog.push({
        day,
        action: "SMUGGLE",
        commodity: cargo.commodity,
        location: this.locationName,
        destination: null,
        quantity: round2(cargo.quantity),
        price: null,
        distance: cargo.distance,
        routeType: cargo.routeType,
        travelDays: cargo.travelDays,
        fuelPrice: round2(cargo.fuelPricePaid),
        fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
        fuelCostPaid: round2(cargo.fuelCostTotal),
        profit: round2(-fine - cargo.totalCost),
      });
      this.cargo = null;
      return;
    }

    const blackMarketPrice = market.price * SMUGGLING_PRICE_DISCOUNT;
    const proceeds = blackMarketPrice * cargo.quantity;
    const profit = proceeds - cargo.totalCost;

    this.cash += proceeds;
    this.realizedProfit += profit;
    market.applyTrade(cargo.quantity);

    this.tradeLog.push({
      day,
      action: "SMUGGLE",
      commodity: cargo.commodity,
      location: this.locationName,
      destination: null,
      quantity: round2(cargo.quantity),
      price: round2(blackMarketPrice),
      distance: cargo.distance,
      routeType: cargo.routeType,
      travelDays: cargo.travelDays,
      fuelPrice: round2(cargo.fuelPricePaid),
      fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
      fuelCostPaid: round2(cargo.fuelCostTotal),
      profit: round2(profit),
    });
    this.cargo = null;
  }

  /**
   * Contract payout: the goods were already paid for by the issuing Location
   * directly at purchase time (see Captain.executeContractDelivery), so
   * arrival is not a payment event for the goods -- only the fuel cost
   * already fronted gets reimbursed, plus a fixed delivery fee, both paid by
   * the issuing Location. Unlike a market SELL, the price paid has nothing
   * to do with the destination market's price, and delivering the stock
   * doesn't move the market price the way a normal trade would.
   */
  private fulfillContract(day: number, sellMarkets: Map<string, Market>): void {
    const cargo = this.cargo!;
    const contract = cargo.contract!;
    if (this.locationName !== contract.location) return;

    const proceeds = cargo.fuelCostTotal + contract.deliveryFee;
    const profit = proceeds - cargo.totalCost;

    this.cash += proceeds;
    this.realizedProfit += profit;
    contract.fulfilled = true;
    contract.inFlightCaptain = null;

    const market = sellMarkets.get(marketKey(this.locationName, cargo.commodity));
    if (market !== undefined) market.applyTrade(cargo.quantity);
    const issuingLocation = getLocation(contract.location)!;
    issuingLocation.cash -= proceeds;

    this.tradeLog.push({
      day,
      action: "SELL",
      commodity: cargo.commodity,
      location: this.locationName,
      destination: null,
      quantity: round2(cargo.quantity),
      price: null,
      distance: cargo.distance,
      routeType: cargo.routeType,
      travelDays: cargo.travelDays,
      fuelPrice: round2(cargo.fuelPricePaid),
      fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
      fuelCostPaid: round2(cargo.fuelCostTotal),
      profit: round2(profit),
    });
    this.cargo = null;
  }

  /**
   * Public (not `private`) since Company.directFleet calls this directly on
   * an idle captain to score its best route -- mirrors faction.py's
   * cross-module call to this "private-by-convention" method in Python.
   */
  findBestLocalRoute(
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    excludeRoutes: ReadonlySet<string> = new Set(),
  ): TradeDirective | null {
    let best: TradeDirective | null = null;
    for (const commodity of commodities) {
      const buyMarket = buyMarkets.get(marketKey(this.locationName, commodity));
      if (buyMarket === undefined || !buyMarket.isAvailable) continue;

      const sellCandidates: Market[] = [];
      for (const m of sellMarkets.values()) {
        if (
          m.commodityName === commodity &&
          m.locationName !== this.locationName &&
          !closedLocations.has(m.locationName) &&
          !excludeRoutes.has(excludeRouteKey(commodity, m.locationName)) &&
          m.isAvailable
        ) {
          sellCandidates.push(m);
        }
      }
      if (sellCandidates.length === 0) continue;

      const trialQuantity = Math.min(
        this.transport!.cargoCapacity,
        this.cash / buyMarket.price,
        buyMarket.availableQuantity,
      );
      if (trialQuantity < 1) continue;

      const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
      const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;

      for (const sellMarket of sellCandidates) {
        const econ = this.routeEconomics(
          this.locationName, sellMarket.locationName, buyMarket.price, sellMarket.price,
          trialQuantity, fuelPrice, buyMarkets,
        );
        if (econ.expectedProfit <= 0 || econ.dailyReturnPct < this.minDailyReturnPct) continue;
        if (best === null || econ.dailyReturnPct > best.dailyReturnPct) {
          best = { commodity, destination: sellMarket.locationName, ...econ };
        }
      }
    }
    return best;
  }

  /**
   * Estimate the COMPANY's expected profit per ship-day of delivering
   * `contract` if this captain buys at `producer` and carries it to the
   * contract's location. Public for the same reason as findBestLocalRoute:
   * Company.directFleet (in "compare" mode) calls it to weigh a contract
   * against this captain's best arbitrage route on a common basis.
   *
   * Only the costs the Company actually bears are counted -- crew wages over
   * the whole trip, plus reposition fuel if the ship must first sail empty to
   * the producer. The goods themselves and the delivery-leg fuel are paid /
   * reimbursed by the issuing Location (see executeContractDelivery /
   * fulfillContract), so they never enter the Company's profit. Ship-days are
   * the scarce resource (contracts tie up almost no Company capital), so we
   * normalize by days -- directly comparable to an arbitrage route's
   * expectedProfit / travelDays. Returns null if producer or destination is
   * unreachable.
   */
  estimateContractProfitPerDay(
    contract: Contract,
    producer: string,
    buyMarkets: Map<string, Market>,
  ): number | null {
    const canUse = (r: Route) => this.transport!.canUseRoute(r);

    const deliveryPath = findShortestPath(producer, contract.location, canUse);
    if (deliveryPath === null) return null;
    let deliveryDays = 0;
    for (const leg of deliveryPath) {
      deliveryDays += routeTravelDays(leg, this.currentSpeedUnitsPerDay());
    }

    let repositionDays = 0;
    let repositionFuelCost = 0;
    if (producer !== this.locationName) {
      const repositionPath = findShortestPath(this.locationName, producer, canUse);
      if (repositionPath === null) return null;
      repositionDays = travelDaysBetween(this.locationName, producer, this.currentSpeedUnitsPerDay());
      const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
      const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
      repositionFuelCost = distanceBetween(this.locationName, producer) * this.currentRepositionFuelRate() * fuelPrice;
    }

    const totalDays = repositionDays + deliveryDays;
    if (totalDays <= 0) return null;
    const crewCost = this.dailyCrewCost() * totalDays;
    const profit = contract.deliveryFee - crewCost - repositionFuelCost;
    return profit / totalDays;
  }

  private executeLocalRoute(
    route: { commodity: string; destination: string },
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
  ): void {
    const { commodity, destination } = route;
    const originMarket = buyMarkets.get(marketKey(this.locationName, commodity));
    const sellMarket = sellMarkets.get(marketKey(destination, commodity));
    if (originMarket === undefined || sellMarket === undefined) return;
    if (!originMarket.isAvailable || !sellMarket.isAvailable) return;

    const quantity = Math.min(
      this.transport!.cargoCapacity,
      this.cash / originMarket.price,
      originMarket.availableQuantity,
    );
    if (quantity < 1) return;

    const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    const econ = this.routeEconomics(
      this.locationName, destination, originMarket.price, sellMarket.price, quantity, fuelPrice, buyMarkets,
    );
    if (econ.expectedProfit <= 0 || econ.dailyReturnPct < this.minDailyReturnPct) return;
    if (econ.totalCost > this.cash) return;

    const path = econ.path;
    if (path === null || path.length === 0) return;

    const firstLeg = path[0];
    const originLocation = this.locationName;
    const leg1FuelUnits = firstLeg.distance * this.currentFuelConsumptionRate() * quantity;
    const leg1FuelCost = leg1FuelUnits * fuelPrice;
    // Crew wages for the WHOLE trip (every leg, see routeEconomics) are paid
    // upfront here alongside goods/fuel/fixed-cost -- there's no later daily
    // deduction while InTransit any more (see act()).
    const upfrontCost = quantity * originMarket.price + leg1FuelCost + this.currentFixedShipmentCost() + econ.crewCost;

    const buyPrice = originMarket.price;
    this.cash -= upfrontCost;
    this.totalFuelSpent += leg1FuelCost;
    this.totalFuelUnitsConsumed += leg1FuelUnits;
    this.totalFixedFeesSpent += this.transport!.fixedShipmentCost;
    this.applyPriceImpact(originMarket, quantity, "buy");
    originMarket.applyTrade(quantity);
    originMarket.location.cash += quantity * buyPrice;
    if (fuelMarket !== undefined) this.applyPriceImpact(fuelMarket, leg1FuelUnits, "buy");

    this.cargo = {
      commodity,
      quantity,
      unitCost: buyPrice,
      origin: originLocation,
      destination,
      distance: econ.distance,
      routeType: econ.routeType,
      travelDays: econ.travelDays,
      fuelPricePaid: fuelPrice,
      fuelUnitsConsumed: leg1FuelUnits,
      fuelCostTotal: leg1FuelCost,
      totalCost: upfrontCost,
      departureDay: day,
      contract: null,
    };
    this.status = "InTransit";
    this.transport!.refuel(leg1FuelUnits);

    this.path = path.slice(1);
    const nextNode = firstLeg.origin === originLocation ? firstLeg.destination : firstLeg.origin;
    this.destination = nextNode;
    this.daysRemaining = routeTravelDays(firstLeg, this.currentSpeedUnitsPerDay());
    this.dailyFuelBurn = this.daysRemaining > 0 ? leg1FuelUnits / this.daysRemaining : 0.0;

    this.tradeLog.push({
      day,
      action: "BUY",
      commodity,
      location: originLocation,
      destination,
      quantity: round2(quantity),
      price: round2(buyPrice),
      distance: econ.distance,
      routeType: econ.routeType,
      travelDays: econ.travelDays,
      fuelPrice: round2(fuelPrice),
      fuelUnitsConsumed: round2(leg1FuelUnits),
      fuelCostPaid: round2(leg1FuelCost),
      profit: null,
    });
  }

  /**
   * Buy at the current (producer) location and depart toward the contract's
   * Location, marking the cargo as contract-bound so fulfillContract pays it
   * out on arrival instead of selling at the destination's market price.
   * Unlike executeLocalRoute, there's no profitability gate: a due Contract
   * is an obligation the Company committed to, not an opportunistic trade --
   * matching Company.directFleet prioritizing contracts over arbitrage.
   *
   * The issuing Location pays the producer directly for the goods -- the
   * Company never fronts that cost, only the fuel to carry them (reimbursed,
   * plus a delivery fee, on arrival -- see fulfillContract). So quantity is
   * bounded by the issuing Location's own cash (the goods payer) and the
   * Company's cash covering fuel alone, not by the Company affording the
   * goods themselves.
   */
  private executeContractDelivery(contract: Contract, day: number, buyMarkets: Map<string, Market>): void {
    const originMarket = buyMarkets.get(marketKey(this.locationName, contract.commodity));
    if (originMarket === undefined || !originMarket.isAvailable) return;

    const path = findShortestPath(this.locationName, contract.location, (r) => this.transport!.canUseRoute(r));
    if (path === null || path.length === 0) return;

    const issuingLocation = getLocation(contract.location)!;
    const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    const firstLeg = path[0];
    const originLocation = this.locationName;

    // Distance/duration for the WHOLE path -- computed before the quantity/
    // affordability gates below since crew cost doesn't depend on cargo
    // quantity, only on how many days the trip takes.
    let totalDistance = 0.0;
    let totalDays = 0;
    const routeTypes: RouteType[] = [];
    for (const leg of path) {
      totalDistance += leg.distance;
      totalDays += routeTravelDays(leg, this.currentSpeedUnitsPerDay());
      if (!routeTypes.includes(leg.routeType)) routeTypes.push(leg.routeType);
    }
    // Crew wages for the whole trip are paid upfront here -- there's no
    // later daily deduction while InTransit any more (see act()).
    const crewCost = this.dailyCrewCost() * totalDays;
    if (crewCost > this.cash) return;

    const perUnitFuelUnits = firstLeg.distance * this.currentFuelConsumptionRate();
    const perUnitFuelCost = perUnitFuelUnits * fuelPrice;
    const goodsAffordableQuantity = originMarket.price > 0 ? issuingLocation.cash / originMarket.price : 0;
    const fuelAffordableQuantity = perUnitFuelCost > 0 ? (this.cash - crewCost) / perUnitFuelCost : Infinity;

    const quantity = Math.min(
      this.transport!.cargoCapacity,
      contract.quantity,
      originMarket.availableQuantity,
      goodsAffordableQuantity,
      fuelAffordableQuantity,
    );
    if (quantity < 1) return;

    const leg1FuelUnits = perUnitFuelUnits * quantity;
    const leg1FuelCost = leg1FuelUnits * fuelPrice;
    if (leg1FuelCost + crewCost > this.cash) return;

    const buyPrice = originMarket.price;
    const goodsCost = quantity * buyPrice;
    this.cash -= leg1FuelCost + crewCost;
    this.totalFuelSpent += leg1FuelCost;
    this.totalFuelUnitsConsumed += leg1FuelUnits;
    this.applyPriceImpact(originMarket, quantity, "buy");
    originMarket.applyTrade(quantity);
    originMarket.location.cash += goodsCost;
    issuingLocation.cash -= goodsCost;
    if (fuelMarket !== undefined) this.applyPriceImpact(fuelMarket, leg1FuelUnits, "buy");

    contract.inFlightCaptain = this;
    this.cargo = {
      commodity: contract.commodity,
      quantity,
      unitCost: buyPrice,
      origin: originLocation,
      destination: contract.location,
      distance: totalDistance,
      routeType: routeTypes.join("+"),
      travelDays: totalDays,
      fuelPricePaid: fuelPrice,
      fuelUnitsConsumed: leg1FuelUnits,
      fuelCostTotal: leg1FuelCost,
      totalCost: leg1FuelCost + crewCost,
      departureDay: day,
      contract,
    };
    this.status = "InTransit";
    this.transport!.refuel(leg1FuelUnits);

    this.path = path.slice(1);
    const nextNode = firstLeg.origin === originLocation ? firstLeg.destination : firstLeg.origin;
    this.destination = nextNode;
    this.daysRemaining = routeTravelDays(firstLeg, this.currentSpeedUnitsPerDay());
    this.dailyFuelBurn = this.daysRemaining > 0 ? leg1FuelUnits / this.daysRemaining : 0.0;

    this.tradeLog.push({
      day,
      action: "BUY",
      commodity: contract.commodity,
      location: originLocation,
      destination: contract.location,
      quantity: round2(quantity),
      price: round2(buyPrice),
      distance: totalDistance,
      routeType: routeTypes.join("+"),
      travelDays: totalDays,
      fuelPrice: round2(fuelPrice),
      fuelUnitsConsumed: round2(leg1FuelUnits),
      fuelCostPaid: round2(leg1FuelCost),
      profit: null,
    });
  }

  private planAndDepart(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
  ): void {
    const best = this.findBestLocalRoute(buyMarkets, sellMarkets, commodities, closedLocations);
    if (best === null) {
      this.considerRepositioning(day, buyMarkets, sellMarkets, commodities, closedLocations);
      return;
    }
    this.executeLocalRoute(best, day, buyMarkets, sellMarkets);
  }

  private considerRepositioning(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
  ): void {
    let best: { commodity: string; targetLoc: string; destLoc: string; econ: RouteEconomics } | null = null;

    for (const commodity of commodities) {
      const buyCandidates: Market[] = [];
      for (const m of buyMarkets.values()) {
        if (
          m.commodityName === commodity &&
          m.locationName !== this.locationName &&
          !closedLocations.has(m.locationName) &&
          getRoutes(this.locationName, m.locationName).some((r) => this.transport!.canUseRoute(r)) &&
          m.isAvailable
        ) {
          buyCandidates.push(m);
        }
      }
      const sellCandidates: Market[] = [];
      for (const m of sellMarkets.values()) {
        if (m.commodityName === commodity && !closedLocations.has(m.locationName) && m.isAvailable) {
          sellCandidates.push(m);
        }
      }
      if (buyCandidates.length === 0 || sellCandidates.length === 0) continue;

      for (const targetBuyMarket of buyCandidates) {
        const targetLoc = targetBuyMarket.locationName;
        const trialQuantity = Math.min(
          this.transport!.cargoCapacity,
          this.cash / targetBuyMarket.price,
          targetBuyMarket.availableQuantity,
        );
        if (trialQuantity < 1) continue;

        const fuelMarketAtTarget = buyMarkets.get(marketKey(targetLoc, "Fuel"));
        const fuelPriceAtTarget = fuelMarketAtTarget !== undefined ? fuelMarketAtTarget.price : 0.0;

        for (const destSellMarket of sellCandidates) {
          const destLoc = destSellMarket.locationName;
          if (destLoc === targetLoc) continue;
          if (!getRoutes(targetLoc, destLoc).some((r) => this.transport!.canUseRoute(r))) continue;
          const econ = this.routeEconomics(
            targetLoc, destLoc, targetBuyMarket.price, destSellMarket.price,
            trialQuantity, fuelPriceAtTarget, buyMarkets,
          );
          if (econ.expectedProfit <= 0) continue;
          if (best === null || econ.dailyReturnPct > best.econ.dailyReturnPct) {
            best = { commodity, targetLoc, destLoc, econ };
          }
        }
      }
    }

    if (best === null) return;

    const fuelMarketHere = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPriceHere = fuelMarketHere !== undefined ? fuelMarketHere.price : 0.0;
    const repositionDistance = distanceBetween(this.locationName, best.targetLoc);
    const repositionDays = travelDaysBetween(this.locationName, best.targetLoc, this.currentSpeedUnitsPerDay());
    const repositionFuelUnits = repositionDistance * this.currentRepositionFuelRate();
    const repositionFuelCost = repositionFuelUnits * fuelPriceHere;
    const repositionCrewCost = this.dailyCrewCost() * repositionDays;

    const opp = best.econ;
    const totalDays = repositionDays + opp.travelDays;
    const totalCost = repositionFuelCost + repositionCrewCost + opp.totalCost;
    const totalProfit = opp.expectedProfit - repositionFuelCost - repositionCrewCost;
    const adjustedDailyReturn =
      totalCost > 0 && totalDays > 0 ? totalProfit / totalCost / totalDays : -1.0;

    const requiredReturn = this.minDailyReturnPct * this.repositionReturnMultiplier;
    if (totalProfit <= 0 || adjustedDailyReturn < requiredReturn) return;

    this.departEmptyTo(best.targetLoc, day, buyMarkets, best.commodity);
  }

  private departEmptyTo(
    destination: string,
    day: number,
    buyMarkets: Map<string, Market>,
    reasonCommodity: string | null = null,
  ): boolean {
    if (destination === this.locationName) return false;
    // Reachability allows a multi-hop path, not just a direct edge -- the
    // distance/time below are coordinate-based (not edge-based), so a
    // multi-hop reposition is simulated the same way a direct one already
    // was: one continuous transit, no intermediate-stop bookkeeping needed.
    const path = findShortestPath(this.locationName, destination, (r) => this.transport!.canUseRoute(r));
    if (path === null || path.length === 0) return false;

    const fuelMarketHere = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPriceHere = fuelMarketHere !== undefined ? fuelMarketHere.price : 0.0;
    const repositionDistance = distanceBetween(this.locationName, destination);
    const repositionDays = travelDaysBetween(this.locationName, destination, this.currentSpeedUnitsPerDay());
    const repositionRouteTypes: RouteType[] = [];
    for (const leg of path) if (!repositionRouteTypes.includes(leg.routeType)) repositionRouteTypes.push(leg.routeType);
    const repositionRouteType: string = repositionRouteTypes.join("+");
    const repositionFuelUnits = repositionDistance * this.currentRepositionFuelRate();
    const repositionFuelCost = repositionFuelUnits * fuelPriceHere;
    // Crew wages for the reposition leg are paid upfront here -- there's no
    // later daily deduction while InTransit any more (see act()).
    const repositionCrewCost = this.dailyCrewCost() * repositionDays;
    if (repositionFuelCost + repositionCrewCost > this.cash) return false;

    this.cash -= repositionFuelCost + repositionCrewCost;
    this.totalFuelSpent += repositionFuelCost;
    this.totalFuelUnitsConsumed += repositionFuelUnits;
    this.totalRepositions += 1;
    if (fuelMarketHere !== undefined) this.applyPriceImpact(fuelMarketHere, repositionFuelUnits, "buy");

    const originLocation = this.locationName;
    this.status = "InTransit";
    this.transport!.refuel(repositionFuelUnits);
    this.destination = destination;
    this.daysRemaining = repositionDays;
    this.dailyFuelBurn = repositionDays > 0 ? repositionFuelUnits / repositionDays : 0.0;

    this.tradeLog.push({
      day,
      action: "REPOSITION",
      commodity: reasonCommodity,
      location: originLocation,
      destination,
      quantity: 0.0,
      price: null,
      distance: repositionDistance,
      routeType: repositionRouteType,
      travelDays: repositionDays,
      fuelPrice: round2(fuelPriceHere),
      fuelUnitsConsumed: round2(repositionFuelUnits),
      fuelCostPaid: round2(repositionFuelCost),
      profit: null,
    });
    return true;
  }

  private executeDirectedReposition(destination: string, day: number, buyMarkets: Map<string, Market>): void {
    this.departEmptyTo(destination, day, buyMarkets, null);
  }

  recordPortfolioSnapshot(day: number, sellMarkets: Map<string, Market>): void {
    let cargoValue = 0.0;
    // Contract cargo is paid for by the issuing Location, not this Captain's
    // Company (see executeContractDelivery), so it's excluded from portfolio
    // value the same way Faction.netWorth excludes it.
    if (this.cargo !== null && this.cargo.contract === null) {
      const markLocation = this.status === "AtLocation" ? this.locationName : this.cargo.destination;
      const market = sellMarkets.get(marketKey(markLocation, this.cargo.commodity));
      cargoValue =
        market !== undefined ? market.price * this.cargo.quantity : this.cargo.unitCost * this.cargo.quantity;
    }

    const totalValue = this.cash + cargoValue;
    this.portfolioHistory.push({
      day,
      location: this.locationName,
      status: this.status,
      cash: round2(this.cash),
      cargoValue: round2(cargoValue),
      totalValue: round2(totalValue),
      realizedProfit: round2(this.realizedProfit),
      totalFuelSpent: round2(this.totalFuelSpent),
    });
  }
}
