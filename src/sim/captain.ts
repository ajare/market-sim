/**
 * Captain: a profit-seeking agent that buys low and sells high, running a
 * single Transport between locations. Ported from sim/captain.py -- see
 * that file's (and Architecture.md section 6's) extensive docstrings for
 * the economic reasoning; comments here are kept light since the logic is
 * transcribed 1:1.
 */
import { Crew } from "./crew";
import type { Faction } from "./faction";
import { TransportEvent, AGENT_EVENT_TEMPLATES, type TransportEventKind } from "./events";
import type { TransportStatus } from "./transport";
import { distanceBetween, travelDaysBetween, getLocation } from "./worldData";
import { getRoute, type Route, type RouteType } from "./routes";
import { findShortestPath, pathNodeSequence } from "./pathfinding";
import { Market, marketKey } from "./markets";
import { randRandom, randChoice } from "./simRandom";
import type { Contract } from "./contracts";

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

export type TradeAction = "BUY" | "SELL" | "REFUEL" | "REPOSITION" | "ATTACK";

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

function fmt1(n: number): string {
  return n.toFixed(1);
}
function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPercent0(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function excludeRouteKey(commodity: string, location: string): string {
  return `${commodity}||${location}`;
}

export class Captain extends Crew {
  carousing: number;
  private _ownCash: number;
  startingCash: number | null;
  repositionReturnMultiplier: number;
  minDailyReturnPct: number;
  priceImpact: number;
  agentEventProbability: number;
  company: Faction | null = null;

  location: string;
  currentNode: string;
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

  constructor(
    name: string,
    homeLocation: string,
    startingCash: number | null = null,
    repositionReturnMultiplier: number = 1.25,
    minDailyReturnPct: number = 0.02,
    priceImpact: number = 0.01,
    agentEventProbability: number = 0.005,
    carousing: number = 0.0,
  ) {
    super(name);
    this.carousing = carousing;
    this._ownCash = startingCash ?? 0.0;
    this.startingCash = startingCash;
    this.repositionReturnMultiplier = repositionReturnMultiplier;
    this.minDailyReturnPct = minDailyReturnPct;
    this.priceImpact = priceImpact;
    this.agentEventProbability = agentEventProbability;
    this.location = homeLocation;
    this.currentNode = homeLocation;
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
    return this.transport!.crew.reduce((sum, member) => sum + member.dailyWages, 0);
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
      const legDestination = nodes[i + 1];
      const route = path[i];
      const legFuelUnits = route.distance * fuelRate * quantity;
      if (legFuelUnits > this.transport!.fuelCapacity) {
        return infeasible;
      }

      const legFuelMarket = buyMarkets.get(marketKey(legOrigin, "Fuel"));
      const legFuelPrice = legFuelMarket !== undefined ? legFuelMarket.price : fuelPrice;

      totalDistance += route.distance;
      totalDays += travelDaysBetween(legOrigin, legDestination, this.transport!.speedUnitsPerDay);
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
  ): void {
    this.maybeTriggerAgentEvent(day);
    this.activeAgentEvents = this.activeAgentEvents.filter((e) => e.tick());

    let justArrived = false;
    if (this.status === "InTransit") {
      const crewCost = this.dailyCrewCost();
      if (crewCost > this.cash) {
        this.transport!.status = "Inactive";
        return;
      }
      this.cash -= crewCost;
      this.transport!.consumeFuel(this.dailyFuelBurn);
      this.daysRemaining -= 1;
      if (this.daysRemaining > 0) return;
      if (!this.arrive(day, buyMarkets, closedLocations)) return;
      justArrived = true;
    }

    if (closedLocations.has(this.location)) return;

    if (this.cargo !== null) {
      this.sellCargoIfPossible(day, sellMarkets);
    }

    if (this.groundedDaysRemaining > 0) {
      this.groundedDaysRemaining -= 1;
      return;
    }

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

  private maybeTriggerAgentEvent(day: number): void {
    if (randRandom() >= this.agentEventProbability) return;
    const eligible = AGENT_EVENT_TEMPLATES.filter(
      (t) => t.kind !== "cargo_loss" || this.cargo !== null,
    );
    if (eligible.length === 0) return;
    const template = randChoice(eligible);
    const event = new TransportEvent(template);
    this.applyAgentEvent(event, day);
  }

  private applyAgentEvent(event: TransportEvent, day: number): void {
    event.startedDay = day;
    event.day = day;
    event.subject = this.name;
    this.eventLog.push(event);
    let detail = "";
    if (event.kind === "delay") {
      const days = Math.trunc(event.magnitude);
      if (this.status === "InTransit") {
        this.daysRemaining += days;
        detail = `voyage delayed ${days}d (now ${this.daysRemaining}d out)`;
      } else {
        this.groundedDaysRemaining += days;
        detail = `grounded at ${this.location} for ${days}d`;
      }
    } else if (event.kind === "cargo_loss" && this.cargo !== null) {
      const lostQty = this.cargo.quantity * event.magnitude;
      this.cargo.quantity = Math.max(0.0, this.cargo.quantity - lostQty);
      detail = `lost ${fmt1(lostQty)} units of ${this.cargo.commodity}`;
    } else if (event.kind === "cash_gain") {
      this.cash += event.magnitude;
      detail = `+$${fmtMoney(event.magnitude)} cash`;
    } else if (event.kind === "cash_loss") {
      const paid = Math.min(event.magnitude, this.cash);
      this.cash = Math.max(0.0, this.cash - event.magnitude);
      detail = `-$${fmtMoney(paid)} cash`;
    } else if (event.kind === "fuel_discount" || event.kind === "fixed_cost_discount") {
      this.activeAgentEvents.push(event);
      detail = `${fmtPercent0(event.magnitude)} off for ${event.durationDays}d`;
    }

    this.agentEventLog.push({
      day,
      location: this.location,
      name: event.name,
      kind: event.kind,
      detail,
    });
  }

  /** Returns true for a genuine arrival at the final destination; false if only an intermediate refueling stop. */
  private arrive(day: number, buyMarkets: Map<string, Market>, closedLocations: ReadonlySet<string>): boolean {
    this.location = this.destination!;
    this.currentNode = this.location;

    if (this.cargo !== null && this.path.length > 0) {
      const nextRoute = this.path.shift()!;
      const nextNode = nextRoute.origin === this.currentNode ? nextRoute.destination : nextRoute.origin;
      const legFuelUnits = this.refuelAtStop(day, buyMarkets, nextRoute.distance, closedLocations);
      this.transport!.refuel(legFuelUnits);
      this.destination = nextNode;
      this.daysRemaining = travelDaysBetween(this.currentNode, nextNode, this.transport!.speedUnitsPerDay);
      this.dailyFuelBurn = this.daysRemaining > 0 ? legFuelUnits / this.daysRemaining : 0.0;
      return false;
    }

    this.status = "AtLocation";
    this.destination = null;
    this.dailyFuelBurn = 0.0;
    return true;
  }

  private refuelAtStop(
    day: number,
    buyMarkets: Map<string, Market>,
    nextLegDistance: number,
    closedLocations: ReadonlySet<string>,
  ): number {
    if (closedLocations.has(this.location)) return 0.0;
    const fuelUnits = nextLegDistance * this.currentFuelConsumptionRate() * this.cargo!.quantity;
    if (fuelUnits <= 0) return 0.0;
    const fuelMarket = buyMarkets.get(marketKey(this.location, "Fuel"));
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
      location: this.location,
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
      !closedLocations.has(this.location)
    );
  }

  private sellCargoIfPossible(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    if (this.cargo.contract !== null) {
      this.fulfillContract(day, sellMarkets);
      return;
    }
    const market = sellMarkets.get(marketKey(this.location, this.cargo.commodity));
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
      location: this.location,
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
    if (this.location !== contract.location) return;

    const proceeds = cargo.fuelCostTotal + contract.deliveryFee;
    const profit = proceeds - cargo.totalCost;

    this.cash += proceeds;
    this.realizedProfit += profit;
    contract.fulfilled = true;
    contract.inFlightCaptain = null;

    const market = sellMarkets.get(marketKey(this.location, cargo.commodity));
    if (market !== undefined) market.applyTrade(cargo.quantity);
    const issuingLocation = getLocation(contract.location)!;
    issuingLocation.cash -= proceeds;

    this.tradeLog.push({
      day,
      action: "SELL",
      commodity: cargo.commodity,
      location: this.location,
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
      const buyMarket = buyMarkets.get(marketKey(this.location, commodity));
      if (buyMarket === undefined || !buyMarket.isAvailable) continue;

      const sellCandidates: Market[] = [];
      for (const m of sellMarkets.values()) {
        if (
          m.commodityName === commodity &&
          m.locationName !== this.location &&
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

      const fuelMarket = buyMarkets.get(marketKey(this.location, "Fuel"));
      const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;

      for (const sellMarket of sellCandidates) {
        const econ = this.routeEconomics(
          this.location, sellMarket.locationName, buyMarket.price, sellMarket.price,
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
    const deliveryNodes = pathNodeSequence(producer, deliveryPath);
    let deliveryDays = 0;
    for (let i = 0; i < deliveryPath.length; i++) {
      deliveryDays += travelDaysBetween(deliveryNodes[i], deliveryNodes[i + 1], this.transport!.speedUnitsPerDay);
    }

    let repositionDays = 0;
    let repositionFuelCost = 0;
    if (producer !== this.location) {
      const repositionPath = findShortestPath(this.location, producer, canUse);
      if (repositionPath === null) return null;
      repositionDays = travelDaysBetween(this.location, producer, this.transport!.speedUnitsPerDay);
      const fuelMarket = buyMarkets.get(marketKey(this.location, "Fuel"));
      const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
      repositionFuelCost = distanceBetween(this.location, producer) * this.currentRepositionFuelRate() * fuelPrice;
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
    const originMarket = buyMarkets.get(marketKey(this.location, commodity));
    const sellMarket = sellMarkets.get(marketKey(destination, commodity));
    if (originMarket === undefined || sellMarket === undefined) return;
    if (!originMarket.isAvailable || !sellMarket.isAvailable) return;

    const quantity = Math.min(
      this.transport!.cargoCapacity,
      this.cash / originMarket.price,
      originMarket.availableQuantity,
    );
    if (quantity < 1) return;

    const fuelMarket = buyMarkets.get(marketKey(this.location, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    const econ = this.routeEconomics(
      this.location, destination, originMarket.price, sellMarket.price, quantity, fuelPrice, buyMarkets,
    );
    if (econ.expectedProfit <= 0 || econ.dailyReturnPct < this.minDailyReturnPct) return;
    if (econ.totalCost > this.cash) return;

    const path = econ.path;
    if (path === null || path.length === 0) return;

    const firstLeg = path[0];
    const originLocation = this.location;
    const leg1FuelUnits = firstLeg.distance * this.currentFuelConsumptionRate() * quantity;
    const leg1FuelCost = leg1FuelUnits * fuelPrice;
    const upfrontCost = quantity * originMarket.price + leg1FuelCost + this.currentFixedShipmentCost();

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

    this.currentNode = originLocation;
    this.path = path.slice(1);
    const nextNode = firstLeg.origin === originLocation ? firstLeg.destination : firstLeg.origin;
    this.destination = nextNode;
    this.daysRemaining = travelDaysBetween(originLocation, nextNode, this.transport!.speedUnitsPerDay);
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
    const originMarket = buyMarkets.get(marketKey(this.location, contract.commodity));
    if (originMarket === undefined || !originMarket.isAvailable) return;

    const path = findShortestPath(this.location, contract.location, (r) => this.transport!.canUseRoute(r));
    if (path === null || path.length === 0) return;

    const issuingLocation = getLocation(contract.location)!;
    const fuelMarket = buyMarkets.get(marketKey(this.location, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    const firstLeg = path[0];
    const originLocation = this.location;

    const perUnitFuelUnits = firstLeg.distance * this.currentFuelConsumptionRate();
    const perUnitFuelCost = perUnitFuelUnits * fuelPrice;
    const goodsAffordableQuantity = originMarket.price > 0 ? issuingLocation.cash / originMarket.price : 0;
    const fuelAffordableQuantity = perUnitFuelCost > 0 ? this.cash / perUnitFuelCost : Infinity;

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
    if (leg1FuelCost > this.cash) return;

    const buyPrice = originMarket.price;
    const goodsCost = quantity * buyPrice;
    this.cash -= leg1FuelCost;
    this.totalFuelSpent += leg1FuelCost;
    this.totalFuelUnitsConsumed += leg1FuelUnits;
    this.applyPriceImpact(originMarket, quantity, "buy");
    originMarket.applyTrade(quantity);
    originMarket.location.cash += goodsCost;
    issuingLocation.cash -= goodsCost;
    if (fuelMarket !== undefined) this.applyPriceImpact(fuelMarket, leg1FuelUnits, "buy");

    const nodes = pathNodeSequence(originLocation, path);
    let totalDistance = 0.0;
    let totalDays = 0;
    const routeTypes: RouteType[] = [];
    for (let i = 0; i < path.length; i++) {
      totalDistance += path[i].distance;
      totalDays += travelDaysBetween(nodes[i], nodes[i + 1], this.transport!.speedUnitsPerDay);
      if (!routeTypes.includes(path[i].routeType)) routeTypes.push(path[i].routeType);
    }

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
      totalCost: leg1FuelCost,
      departureDay: day,
      contract,
    };
    this.status = "InTransit";
    this.transport!.refuel(leg1FuelUnits);

    this.currentNode = originLocation;
    this.path = path.slice(1);
    const nextNode = firstLeg.origin === originLocation ? firstLeg.destination : firstLeg.origin;
    this.destination = nextNode;
    this.daysRemaining = travelDaysBetween(originLocation, nextNode, this.transport!.speedUnitsPerDay);
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
          m.locationName !== this.location &&
          !closedLocations.has(m.locationName) &&
          this.transport!.canUseRoute(getRoute(this.location, m.locationName)) &&
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
          if (!this.transport!.canUseRoute(getRoute(targetLoc, destLoc))) continue;
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

    const fuelMarketHere = buyMarkets.get(marketKey(this.location, "Fuel"));
    const fuelPriceHere = fuelMarketHere !== undefined ? fuelMarketHere.price : 0.0;
    const repositionDistance = distanceBetween(this.location, best.targetLoc);
    const repositionDays = travelDaysBetween(this.location, best.targetLoc, this.transport!.speedUnitsPerDay);
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
    if (destination === this.location) return false;
    // Reachability allows a multi-hop path, not just a direct edge -- the
    // distance/time below are coordinate-based (not edge-based), so a
    // multi-hop reposition is simulated the same way a direct one already
    // was: one continuous transit, no intermediate-stop bookkeeping needed.
    const path = findShortestPath(this.location, destination, (r) => this.transport!.canUseRoute(r));
    if (path === null || path.length === 0) return false;

    const fuelMarketHere = buyMarkets.get(marketKey(this.location, "Fuel"));
    const fuelPriceHere = fuelMarketHere !== undefined ? fuelMarketHere.price : 0.0;
    const repositionDistance = distanceBetween(this.location, destination);
    const repositionDays = travelDaysBetween(this.location, destination, this.transport!.speedUnitsPerDay);
    const repositionRouteTypes: RouteType[] = [];
    for (const leg of path) if (!repositionRouteTypes.includes(leg.routeType)) repositionRouteTypes.push(leg.routeType);
    const repositionRouteType: string = repositionRouteTypes.join("+");
    const repositionFuelUnits = repositionDistance * this.currentRepositionFuelRate();
    const repositionFuelCost = repositionFuelUnits * fuelPriceHere;
    if (repositionFuelCost > this.cash) return false;

    this.cash -= repositionFuelCost;
    this.totalFuelSpent += repositionFuelCost;
    this.totalFuelUnitsConsumed += repositionFuelUnits;
    this.totalRepositions += 1;
    if (fuelMarketHere !== undefined) this.applyPriceImpact(fuelMarketHere, repositionFuelUnits, "buy");

    const originLocation = this.location;
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
      const markLocation = this.status === "AtLocation" ? this.location : this.cargo.destination;
      const market = sellMarkets.get(marketKey(markLocation, this.cargo.commodity));
      cargoValue =
        market !== undefined ? market.price * this.cargo.quantity : this.cargo.unitCost * this.cargo.quantity;
    }

    const totalValue = this.cash + cargoValue;
    this.portfolioHistory.push({
      day,
      location: this.location,
      status: this.status,
      cash: round2(this.cash),
      cargoValue: round2(cargoValue),
      totalValue: round2(totalValue),
      realizedProfit: round2(this.realizedProfit),
      totalFuelSpent: round2(this.totalFuelSpent),
    });
  }
}
