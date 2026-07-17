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
import { Ship, crewSpeedFraction, CONDITION_DECAY_PER_TRANSIT_DAY, type Transport, type TransportStatus, type CargoState, type CargoItem } from "./transport";
import {
  distanceBetween, travelDaysBetween, getLocation, getWorldStartDate, LOCATION_COORDINATES, headingBetween,
} from "./worldData";
import { getRoutes, routeTravelDays, type Route, type RouteType } from "./routes";
import { findShortestPath } from "./pathfinding";
import { Market, marketKey } from "./markets";
import { randRandom } from "./simRandom";
import type { Contract } from "./contracts";
import { round2 } from "./utils";
import { trimHistory } from "./historyRetention";
import { dayToTimeOfYear, type WeatherSystem, type Position } from "./weather";
import { stormAt, type StormSystem, type Storm } from "./storms";
import type { PersonInit } from "./person";
import type { Location } from "./location";
import type { ShipLogEntry } from "./log";
export type { ShipLogEntry };
import { hireFromSailorPool, addToSailorPool } from "./sailorPool";
import {
  routeEconomicsFromPath, findBestBundle, reverifyBundle, applyPurchases, applyMarketPriceImpact, sellCargoShared,
  type CargoAllocation, type RouteEconomics, type TradeDirective, type TripCostParams,
} from "./tradingAgent";
export type { CargoAllocation, RouteEconomics, TradeDirective };

/** Wind speed (world-units/day) at which the wind-alignment effect below reaches its full configured magnitude -- roughly a "strong" wind under either built-in WeatherProfile (Default's storm-boosted max is ~480, Caribbean's ~810). */
const WIND_EFFECT_REFERENCE_SPEED = 300;
/** Max fraction a perfectly-aligned (following) or perfectly-opposed (head-on) wind at WIND_EFFECT_REFERENCE_SPEED changes a Ship's effective speed by -- e.g. 0.15 means +/-15% at full alignment and full reference strength, tapering to 0 at right angles or calm wind. */
const WIND_EFFECT_MAX_FRACTION = 0.15;

/** Effective-speed multiplier for a Ship departing a port currently inside an active Storm's radius (see storms.ts) -- on top of the wind-alignment effect above, since a storm churns from every direction at once, not just a clean headwind. */
const STORM_SPEED_MULTIPLIER = 0.75;
/** Same, for a Storm that has escalated into a cyclone -- strictly more severe than a plain Storm. */
const CYCLONE_SPEED_MULTIPLIER = 0.55;
/** Condition fraction lost, once, the moment a Ship departs a port currently inside an active Storm's radius -- on top of ordinary transit decay. Can sink the Ship (see Faction.sinkAtSea) exactly like transit decay bottoming out. */
const STORM_CONDITION_DAMAGE = 0.08;
/** Same, for a cyclone. */
const CYCLONE_CONDITION_DAMAGE = 0.2;

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

/**
 * Whether Captains record Ship's Log entries at all (see recordShipLog and
 * Faction.sinkAtSea/sinkInPort's final-entry writes) -- off by default since
 * this is a narrative/flavor feature with a real per-day cost (building a
 * sentence for every Captain, every day) that most callers don't need.
 * Module-level (like worldData.ts's DISPLAY_DISTANCE_UNIT) rather than a
 * World field: it's a pure UI preference, not part of a World's own data, so
 * it should survive a reset()/loadWorldFromJson() the same way the viewer's
 * contractStrategy setting does (see useSimStore.ts).
 */
let SHIP_LOG_ENABLED = false;

export function setShipLogEnabled(enabled: boolean): void {
  SHIP_LOG_ENABLED = enabled;
}

export function isShipLogEnabled(): boolean {
  return SHIP_LOG_ENABLED;
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

export interface RepositionDirective {
  action: "REPOSITION";
  destination: string;
}

/** Directs an idle captain, already sitting at a valid producer, to buy and ship a due Contract's delivery. */
export interface ContractDeliveryDirective {
  action: "CONTRACT_DELIVER";
  contract: Contract;
}

/** Directs a docked Ship whose condition has fallen below CONDITION_REPAIR_THRESHOLD to spend the WHOLE day repairing instead of trading/departing -- see Company.directFleet (which issues this ahead of any trade/reposition/contract directive) and Captain.act. */
export interface RepairDirective {
  action: "REPAIR";
}

export type Directive = TradeDirective | RepositionDirective | ContractDeliveryDirective | RepairDirective;

function isRepositionDirective(d: Directive): d is RepositionDirective {
  return "action" in d && d.action === "REPOSITION";
}

function isContractDeliveryDirective(d: Directive): d is ContractDeliveryDirective {
  return "action" in d && d.action === "CONTRACT_DELIVER";
}

export function isRepairDirective(d: Directive): d is RepairDirective {
  return "action" in d && d.action === "REPAIR";
}

export interface CaptainInit extends Omit<PersonInit, "location" | "transport" | "dailyWage"> {
  homeLocation: Location;
  startingCash?: number | null;
  repositionReturnMultiplier?: number;
  minDailyReturnPct?: number;
  priceImpact?: number;
  agentEventProbability?: number;
}

export class Captain extends Sailor {
  private _ownCash: number;
  startingCash: number | null;
  repositionReturnMultiplier: number;
  minDailyReturnPct: number;
  priceImpact: number;
  agentEventProbability: number;
  company: Faction | null = null;

  /**
   * The Transport this Captain was crewing the instant it sank (see
   * Faction.sinkAtSea/sinkInPort, the only writers) -- `transport` itself is
   * already null by the time either of those returns, so this is the only
   * way a caller further up the stack (World.runDay's post-act() cleanup)
   * can still tell what kind of Ship needs replacing. Left stale (not
   * cleared) once set; only meaningful to read in the same turn a sinking
   * just happened, while `transport` is still null.
   */
  lastTransport: Transport | null = null;

  destination: string | null = null;
  daysRemaining = 0;
  /** Proxies `this.transport.cargo` -- cargo state lives on the Transport (see CargoState in transport.ts), not the Captain, so it survives a Captain being replaced/reassigned. Every other read/write site in this file keeps using `this.cargo` unchanged. */
  get cargo(): CargoState | null {
    return this.transport?.cargo ?? null;
  }
  set cargo(value: CargoState | null) {
    if (this.transport !== null) this.transport.cargo = value;
  }
  path: Route[] = [];
  private dailyFuelBurn = 0.0;

  /** Today's simulated day number and the World's WeatherSystem (if any) -- set once at the top of act(), read by currentSpeedUnitsPerDay/windSpeedMultiplier for the rest of that same call. Not threaded as a parameter through every route-evaluation/departure helper (routeEconomics, leavePort, arrive, departEmptyTo, ...) since neither changes mid-turn, the same reasoning as the arrivedToday/repairedToday same-day flags below. */
  private currentDay = 0;
  private currentWeather: WeatherSystem | null = null;
  private currentStorms: StormSystem | null = null;

  activeAgentEvents: TransportEvent[] = [];
  eventLog: TransportEvent[] = [];
  groundedDaysRemaining = 0;
  agentEventLog: AgentEventLogEntry[] = [];

  tradeLog: TradeLogEntry[] = [];

  /** One entry per simulated day this Captain has had a Ship -- see recordShipLog, the sole writer (plus Faction.sinkAtSea/sinkInPort for a Ship's final entry). Never truncated, same convention as tradeLog/portfolioHistory. */
  shipLog: ShipLogEntry[] = [];
  /** Day number the most recent genuine arrival happened (see Captain.arrive's true-return branch) -- consumed and cleared by recordShipLog the same day, so it can distinguish "made port today" from "still docked from a prior day." */
  private arrivedToday: number | null = null;
  /** Day number the most recent REPAIR Directive was executed (see act()'s isRepairDirective branch) -- consumed and cleared by recordShipLog. */
  private repairedToday: number | null = null;
  /** Day number Shore Leave was last granted -- set by World.runDay's end-of-day Shore Leave step (outside this class, hence public), consumed and cleared by recordShipLog. */
  shoreLeaveGrantedToday: number | null = null;
  /** Day number this Captain most recently took command of a (newly bought or replacement) Ship -- set by World.acquireShip (outside this class, hence public), consumed and cleared by recordShipLog. */
  newShipDay: number | null = null;

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
    applyMarketPriceImpact(market, units, direction, this.priceImpact);
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
   * Effective speed given how fully crewed this Transport currently is, and
   * (Ships only, when `headingDeg` is supplied) today's wind and any active
   * Storm at this Captain's current port -- see windSpeedMultiplier/
   * stormSpeedMultiplier. Crew fullness: 50% of speedUnitsPerDay with just
   * the Captain aboard, up to 100% at a full complement (crewRequirement),
   * linear in between (see hireCrewIfPossible). Every other Transport type
   * is unaffected by any of these factors -- always its plain
   * speedUnitsPerDay.
   */
  private currentSpeedUnitsPerDay(headingDeg: number | null = null): number {
    const base = this.transport!.speedUnitsPerDay * crewSpeedFraction(this.transport!);
    if (headingDeg === null) return base;
    return base * this.windSpeedMultiplier(headingDeg) * this.stormSpeedMultiplier();
  }

  /**
   * Speed multiplier from wind at this Captain's current port (LOCATION_COORDINATES[this.locationName]),
   * sampled once for TODAY's date only (this.currentDay/this.currentWeather,
   * set at the top of act() -- never resampled mid-voyage or at any other
   * position, per the feature's own spec). A following wind (blowing toward
   * `headingDeg`, the direction of travel) speeds the Ship up; a headwind
   * (blowing back at it) slows it down; a crosswind is roughly neutral.
   * Ships only -- 1.0 (no effect) for every other Transport type, or when
   * there's no WeatherSystem (e.g. a World built without one, or a test
   * Captain driven directly with no `weather` passed to act()).
   */
  private windSpeedMultiplier(headingDeg: number): number {
    if (this.currentWeather === null || !(this.transport instanceof Ship)) return 1.0;
    const position = LOCATION_COORDINATES[this.locationName];
    if (position === undefined) return 1.0;
    const pos: Position = { x: position[0], y: position[1] };
    const t = dayToTimeOfYear(this.currentDay, getWorldStartDate());
    const windSpeed = this.currentWeather.windSpeed(t, pos);
    const windDirection = this.currentWeather.windDirection(t, pos);
    let angleDiff = (headingDeg - windDirection) % 360;
    if (angleDiff > 180) angleDiff -= 360;
    if (angleDiff < -180) angleDiff += 360;
    const alignment = Math.cos((angleDiff * Math.PI) / 180); // 1 = tailwind, -1 = headwind
    const strength = Math.min(1, windSpeed / WIND_EFFECT_REFERENCE_SPEED);
    return 1 + alignment * strength * WIND_EFFECT_MAX_FRACTION;
  }

  /**
   * Speed multiplier from an active Storm/cyclone (see storms.ts) currently
   * covering this Captain's port, read-only (safe to call many times during
   * route evaluation, unlike applyStormDamageOnDeparture below) -- a storm
   * churns from every direction at once, so unlike wind this doesn't depend
   * on heading. Ships only; 1.0 (no effect) with no active Storm there, no
   * StormSystem, or any other Transport type.
   */
  private stormSpeedMultiplier(): number {
    const storm = this.stormAtCurrentPort();
    if (storm === null) return 1.0;
    return storm.isCyclone ? CYCLONE_SPEED_MULTIPLIER : STORM_SPEED_MULTIPLIER;
  }

  /** The Storm (if any) currently covering this Captain's port -- shared by stormSpeedMultiplier (read-only) and applyStormDamageOnDeparture (mutating). Ships only; null with no StormSystem or any other Transport type. */
  private stormAtCurrentPort(): Storm | null {
    if (this.currentStorms === null || !(this.transport instanceof Ship)) return null;
    const position = LOCATION_COORDINATES[this.locationName];
    if (position === undefined) return null;
    return stormAt(this.currentStorms.storms, { x: position[0], y: position[1] });
  }

  /**
   * A one-time condition hit (on top of ordinary transit decay) if this
   * Captain's port is currently inside an active Storm's radius -- called
   * exactly once per ACTUAL departure (leavePort/arrive's next-hop
   * continuation/departEmptyTo), never during route evaluation (which only
   * reads the speed penalty via stormSpeedMultiplier, a side-effect-free
   * read -- applying damage there would punish a Captain for merely
   * considering a route it never took). Sinks the Ship immediately
   * (Faction.sinkAtSea) if this drops condition to <= 0, exactly like
   * ordinary transit-decay does. Returns false if the Ship just sank (the
   * caller must stop touching `this` immediately, same convention as the
   * InTransit condition-decay check in act()); true otherwise (including
   * when there's no storm/no effect to apply at all).
   */
  private applyStormDamageOnDeparture(day: number): boolean {
    if (this.company?.decaysCondition !== true) return true;
    const storm = this.stormAtCurrentPort();
    if (storm === null) return true;
    const damage = storm.isCyclone ? CYCLONE_CONDITION_DAMAGE : STORM_CONDITION_DAMAGE;
    this.transport!.condition -= damage;
    this.transport!.recordCondition(day, "storm");
    if (this.transport!.condition <= 0) {
      this.company!.sinkAtSea(this, day);
      return false;
    }
    return true;
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
   *
   * Public (not `private`) since World.runDay calls this directly, in its
   * own global pass over every already-docked captain (formal day order
   * step 2 -- see CLAUDE.md), before any captain's own act() runs today. A
   * ship that instead arrives (or finishes crew rotation) THIS SAME DAY gets
   * its hire folded into act() itself, right after that turn's rotation --
   * see act()'s justArrived handling.
   */
  hireCrewIfPossible(): void {
    const transport = this.transport!;
    if (!(transport instanceof Ship)) return;
    const seatsOpen = transport.crewRequirement - transport.crew.length;
    if (seatsOpen <= 0) return;
    const location = transport.location;
    if (location === null || !(location.terminalTypes.has("Port") || location.terminalTypes.has("Platform"))) return;
    const hired = hireFromSailorPool(location.name, seatsOpen, this.company?.hirePiracyThreshold ?? 0.0);
    const rotates = this.company?.rotatesCrew === true;
    for (const sailor of hired) {
      if (rotates) sailor.journeysRemaining = JOURNEYS_PER_HIRE;
      sailor.boardTransport(transport);
      transport.crew.push(sailor);
    }
  }

  /** This Captain's current trip-cost inputs for the shared tradingAgent.ts functions -- wind/storm/crew-fraction already folded into `currentSpeedUnitsPerDay` by the time it's called with a heading. */
  private costParams(): TripCostParams {
    return {
      fuelConsumptionRate: this.currentFuelConsumptionRate(),
      fixedShipmentCost: this.currentFixedShipmentCost(),
      dailyCrewCost: this.dailyCrewCost(),
      speedFn: (heading) => this.currentSpeedUnitsPerDay(heading),
    };
  }

  /** `items`' combined economics for one voyage `origin` -> `destination` -- see tradingAgent.ts's routeEconomicsFromPath, which this just supplies a freshly-found (possibly multi-hop) path and this Captain's own cost params to. */
  private routeEconomics(
    origin: string,
    destination: string,
    items: readonly CargoAllocation[],
    fuelPrice: number,
    buyMarkets: Map<string, Market>,
  ): RouteEconomics {
    const path = findShortestPath(origin, destination, (r) => this.transport!.canUseRoute(r));
    return routeEconomicsFromPath(path, origin, items, fuelPrice, buyMarkets, this.transport!, this.costParams(), headingBetween);
  }

  act(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string> = new Set(),
    directedRoute: Directive | null = null,
    pirateBrigade: PirateBrigade | null = null,
    weather: WeatherSystem | null = null,
    storms: StormSystem | null = null,
  ): void {
    // Read by currentSpeedUnitsPerDay/windSpeedMultiplier/
    // applyStormDamageOnDeparture for the rest of this call -- see their doc
    // comments (today's wind/storms are sampled at most once per port/day,
    // never resampled mid-voyage).
    this.currentDay = day;
    this.currentWeather = weather;
    this.currentStorms = storms;

    // No new TransportEvent is ever randomly rolled here -- events are
    // disabled -- but any already-active event (from a loaded scenario)
    // still applies and ticks down below.
    this.activeAgentEvents = this.activeAgentEvents.filter((e) => e.tick());

    // Formal day order (see CLAUDE.md): contracts issued and crew hiring for
    // already-docked ships both happen in World.runDay, before ANY captain's
    // act() runs today -- see hireCrewIfPossible's own doc comment. Only an
    // arrival's own hire (paired with that ship's crew rotation, below) still
    // happens inside this method.
    let justArrived = false;
    if (this.status === "InTransit") {
      // Crew wages are no longer owed day-by-day here -- the whole trip's
      // crew cost is paid upfront at departure (see routeEconomics/
      // executeLocalRoute/executeContractDelivery/departEmptyTo), sized to
      // the estimated day count, so there's nothing left to deduct or check
      // affordability against while already underway.
      this.transport!.consumeFuel(this.dailyFuelBurn);

      // Condition decay -- gated per-Faction by Faction.decaysCondition
      // (true for every concrete Faction today: Company/SoloTrader,
      // PirateBrigade, PoliceFleet). A Ship whose condition bottoms out here, still genuinely underway,
      // sinks AT SEA -- fatal, unlike a pirate-attack-induced sink (always
      // AtLocation by the time it happens -- see maybeAttackOnArrival,
      // below) -- see Company.sinkAtSea. `this` is discarded the instant
      // this fires, so nothing else in act() may run afterward.
      if (this.transport!.handlesZeroCondition() && this.company?.decaysCondition === true) {
        this.transport!.condition -= CONDITION_DECAY_PER_TRANSIT_DAY;
        this.transport!.recordCondition(day, "transit");
        if (this.transport!.condition <= 0) {
          this.company.sinkAtSea(this, day);
          return;
        }
      }

      this.daysRemaining -= 1;
      if (this.daysRemaining > 0) return;
      if (!this.arrive(day, buyMarkets, closedLocations)) return;
      justArrived = true;
      // The only remaining attack trigger -- BEFORE this ship sells/fences,
      // since a docked ship that's already sold has nothing left to raid.
      // See PirateBrigade.maybeAttackOnArrival. This can sink the Ship
      // (survivable -- see Company.sinkInPort), which clears `this.transport`
      // -- every remaining line in this method reads it (starting with the
      // very next one, `this.locationName`), so bail out immediately rather
      // than let a benched Captain crash the rest of its own turn.
      pirateBrigade?.maybeAttackOnArrival(day, this);
      if (this.transport === null) return;
    }

    if (closedLocations.has(this.locationName)) {
      if (this.cargo !== null && this.company?.canSmuggle === true) {
        this.maybeSmuggle(day, sellMarkets);
      }
      return;
    }

    if (this.cargo !== null) {
      if (this.company?.fencesCargo === true) {
        this.fenceCargoIfPossible(day, sellMarkets);
      } else {
        this.sellCargoIfPossible(day, sellMarkets);
      }
    }

    if (this.groundedDaysRemaining > 0) {
      this.groundedDaysRemaining -= 1;
      return;
    }

    if (justArrived) {
      // Crew due to rotate off disembarks, and any vacated seats are
      // refilled immediately, right here -- both AFTER this turn's
      // sell/fence, matching the formal day order's last two steps.
      this.advanceCrewRotation();
      this.hireCrewIfPossible();
      return;
    }

    if (this.cargo === null) {
      if (directedRoute !== null) {
        if (isRepairDirective(directedRoute)) {
          // Spends the WHOLE day repairing -- no trade, no departure, just
          // this. Free (no cash cost); see Company.directFleet, the only
          // source of this Directive.
          this.transport!.condition = 1.0;
          this.transport!.recordCondition(day, "repair");
          this.repairedToday = day;
        } else if (isRepositionDirective(directedRoute)) {
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
      // Continuing on to the next leg from this intermediate stop is itself
      // a departure -- if it's currently sitting inside an active Storm,
      // that's just as dangerous as departing the original port was (see
      // leavePort). A sunk Ship here is reported the same way "not a
      // genuine final arrival" already is -- the caller (act()) just
      // returns either way, so reusing `false` for both is correct, not a
      // loss of information.
      if (!this.applyStormDamageOnDeparture(day)) return false;
      const nextRoute = this.path.shift()!;
      const nextNode = nextRoute.origin === this.locationName ? nextRoute.destination : nextRoute.origin;
      const legFuelUnits = this.refuelAtStop(day, buyMarkets, nextRoute.distance, closedLocations);
      this.transport!.refuel(legFuelUnits);
      this.destination = nextNode;
      this.daysRemaining = routeTravelDays(nextRoute, this.currentSpeedUnitsPerDay(headingBetween(this.locationName, nextNode)));
      this.dailyFuelBurn = this.daysRemaining > 0 ? legFuelUnits / this.daysRemaining : 0.0;
      return false;
    }

    this.status = "AtLocation";
    this.destination = null;
    this.dailyFuelBurn = 0.0;
    this.arrivedToday = day;
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
   * Called from act() AFTER this turn's sell/fence step, not from arrive()
   * itself -- see act()'s justArrived handling.
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
    const totalQuantity = this.cargo!.items.reduce((sum, i) => sum + i.quantity, 0);
    const fuelUnits = nextLegDistance * this.currentFuelConsumptionRate() * totalQuantity;
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
      // No single commodity to attribute a REFUEL stop to any more (the hold
      // may carry several) -- describeTradeLogEntry's REFUEL narrative never
      // reads this field anyway.
      commodity: null,
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

  /**
   * Sells (or, for a contract-bound item, delivers) every item in the hold
   * that CAN be resolved right now, one at a time -- an item whose market is
   * closed/unavailable, or whose contract destination hasn't been reached
   * yet, simply stays aboard for another day's attempt rather than blocking
   * the rest of a mixed hold. Each open-market item's profit apportions its
   * fair share of the trip's shared fuel/fixed/crew overhead by quantity, so
   * the sum across every item still equals the old single-commodity
   * invariant (total revenue - cargo.totalCost) when the whole hold sells
   * together.
   */
  private sellCargoIfPossible(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    const cargo = this.cargo;
    // tradingAgent.ts's sellCargoShared handles every open-market item (the
    // same math for Captain and Explorer); it leaves EVERY contract-bound
    // item untouched in remainingItems regardless of whether this is actually
    // its delivery location, so this wrapper still has to separate "arrived,
    // hand off to fulfillContractItem" from "not yet arrived, keep aboard".
    const { realizedProfitDelta, proceeds, entries, remainingItems } = sellCargoShared(
      this.locationName, cargo, sellMarkets, this.priceImpact,
    );
    this.cash += proceeds;
    this.realizedProfit += realizedProfitDelta;
    for (const entry of entries) {
      this.tradeLog.push({
        day,
        action: "SELL",
        commodity: entry.commodity,
        location: this.locationName,
        destination: null,
        quantity: entry.quantity,
        price: entry.price,
        distance: cargo.distance,
        routeType: cargo.routeType,
        travelDays: cargo.travelDays,
        fuelPrice: round2(cargo.fuelPricePaid),
        fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
        fuelCostPaid: round2(cargo.fuelCostTotal),
        profit: entry.profit,
      });
    }

    const stillRemaining: CargoItem[] = [];
    for (const item of remainingItems) {
      if (item.contract !== null && this.locationName === item.contract.location) {
        this.fulfillContractItem(item, cargo, day, sellMarkets);
        continue;
      }
      stillRemaining.push(item);
    }
    this.cargo = stillRemaining.length > 0 ? { ...cargo, items: stillRemaining } : null;
  }

  /**
   * PirateBrigade-only counterpart to sellCargoIfPossible (see
   * Faction.fencesCargo) -- converts cargo seized in a raid (see
   * PirateBrigade.attack) into cash at this Location's fence price, a
   * discount off the CURRENT live market price, looked up fresh right now
   * rather than snapshotted at the moment of seizure. There's no cost basis
   * (it was stolen, not bought), so the full proceeds are profit. The fence
   * takes physical possession of the goods -- they re-enter this Location's
   * stockpile rather than vanishing from the economy. Unlike
   * sellCargoIfPossible, this is unconditional per item (a fence takes
   * everything, market availability irrelevant), so the whole hold always
   * empties in one pass -- matches the old single-commodity behavior.
   */
  private fenceCargoIfPossible(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    const cargo = this.cargo;
    const location = getLocation(this.locationName);
    const fenceFraction = location !== undefined ? location.fenceFraction : 0.5;

    for (const item of cargo.items) {
      const market = sellMarkets.get(marketKey(this.locationName, item.commodity));
      const unitValue = market !== undefined ? market.price : 0;
      const fencePrice = round2(unitValue * fenceFraction);
      const proceeds = round2(fencePrice * item.quantity);

      this.cash += proceeds;
      this.realizedProfit += proceeds;

      if (location !== undefined && item.quantity > 0) {
        location.stockpiles[item.commodity] = (location.stockpiles[item.commodity] ?? 0) + item.quantity;
      }

      this.tradeLog.push({
        day,
        action: "SELL",
        commodity: item.commodity,
        location: this.locationName,
        destination: null,
        quantity: round2(item.quantity),
        price: fencePrice,
        distance: null,
        routeType: null,
        travelDays: null,
        fuelPrice: null,
        fuelUnitsConsumed: null,
        fuelCostPaid: 0.0,
        profit: proceeds,
      });
    }
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
   * the goods really do change hands. One detection roll covers the WHOLE
   * hold per attempt (not per item -- a single smuggling run either goes
   * smoothly or gets caught, it isn't item-by-item); caught cargo is seized
   * outright -- no proceeds, no stockpile change -- plus a fine
   * (`SMUGGLING_FINE_FRACTION` of what the whole hold would have sold for at
   * the real price). A successful run still sells only the items that have
   * an available black-market buyer here; the rest stays aboard.
   */
  private maybeSmuggle(day: number, sellMarkets: Map<string, Market>): void {
    if (this.cargo === null) return;
    if (this.cargo.items.some((i) => i.contract !== null)) return; // SoloTrader never accepts Contracts to begin with
    const cargo = this.cargo;

    if (randRandom() < SMUGGLING_DETECTION_PROBABILITY) {
      const totalValue = cargo.items.reduce((sum, i) => {
        const market = sellMarkets.get(marketKey(this.locationName, i.commodity));
        return sum + (market !== undefined ? market.price : 0) * i.quantity;
      }, 0);
      const fine = round2(Math.min(totalValue * SMUGGLING_FINE_FRACTION, this.cash));
      const totalLoss = round2(-fine - cargo.totalCost);
      this.cash -= fine;
      this.realizedProfit -= fine + cargo.totalCost;
      // The fine/loss is one lump sum for the whole caught hold -- recorded
      // once, on the first item's row, same convention as a multi-item BUY's
      // shared fuel figures.
      cargo.items.forEach((item, i) => {
        this.tradeLog.push({
          day,
          action: "SMUGGLE",
          commodity: item.commodity,
          location: this.locationName,
          destination: null,
          quantity: round2(item.quantity),
          price: null,
          distance: cargo.distance,
          routeType: cargo.routeType,
          travelDays: cargo.travelDays,
          fuelPrice: round2(cargo.fuelPricePaid),
          fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
          fuelCostPaid: round2(cargo.fuelCostTotal),
          profit: i === 0 ? totalLoss : null,
        });
      });
      this.cargo = null;
      return;
    }

    const totalQuantity = cargo.items.reduce((sum, i) => sum + i.quantity, 0);
    const goodsCostTotal = cargo.items.reduce((sum, i) => sum + i.unitCost * i.quantity, 0);
    const overhead = cargo.totalCost - goodsCostTotal;

    const remaining: CargoItem[] = [];
    for (const item of cargo.items) {
      const market = sellMarkets.get(marketKey(this.locationName, item.commodity));
      if (market === undefined) {
        remaining.push(item);
        continue;
      }
      const blackMarketPrice = market.price * SMUGGLING_PRICE_DISCOUNT;
      const proceeds = blackMarketPrice * item.quantity;
      const itemShareOfOverhead = totalQuantity > 0 ? overhead * (item.quantity / totalQuantity) : 0;
      const profit = proceeds - item.unitCost * item.quantity - itemShareOfOverhead;

      this.cash += proceeds;
      this.realizedProfit += profit;
      market.applyTrade(item.quantity);

      this.tradeLog.push({
        day,
        action: "SMUGGLE",
        commodity: item.commodity,
        location: this.locationName,
        destination: null,
        quantity: round2(item.quantity),
        price: round2(blackMarketPrice),
        distance: cargo.distance,
        routeType: cargo.routeType,
        travelDays: cargo.travelDays,
        fuelPrice: round2(cargo.fuelPricePaid),
        fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
        fuelCostPaid: round2(cargo.fuelCostTotal),
        profit: round2(profit),
      });
    }
    this.cargo = remaining.length > 0 ? { ...cargo, items: remaining } : null;
  }

  /**
   * Contract payout: the goods were already paid for by the issuing Location
   * directly at purchase time (see Captain.executeContractDelivery), so
   * arrival is not a payment event for the goods -- only the fuel cost
   * already fronted gets reimbursed, plus a fixed delivery fee, both paid by
   * the issuing Location. Unlike a market SELL, the price paid has nothing
   * to do with the destination market's price, and delivering the stock
   * doesn't move the market price the way a normal trade would. A
   * contract-delivery voyage is always exactly this one item today (see
   * executeContractDelivery), so the whole trip's fuelCostTotal/totalCost
   * belong to it entirely -- no apportionment needed, unlike the open-market
   * items sellCargoIfPossible loops over.
   */
  private fulfillContractItem(item: CargoItem, cargo: CargoState, day: number, sellMarkets: Map<string, Market>): void {
    const contract = item.contract!;
    const proceeds = cargo.fuelCostTotal + contract.deliveryFee;
    const profit = proceeds - cargo.totalCost;

    this.cash += proceeds;
    this.realizedProfit += profit;
    contract.fulfilled = true;
    contract.inFlightCaptain = null;

    const market = sellMarkets.get(marketKey(this.locationName, item.commodity));
    if (market !== undefined) market.applyTrade(item.quantity);
    const issuingLocation = getLocation(contract.location)!;
    issuingLocation.cash -= proceeds;

    this.tradeLog.push({
      day,
      action: "SELL",
      commodity: item.commodity,
      location: this.locationName,
      destination: null,
      quantity: round2(item.quantity),
      price: null,
      distance: cargo.distance,
      routeType: cargo.routeType,
      travelDays: cargo.travelDays,
      fuelPrice: round2(cargo.fuelPricePaid),
      fuelUnitsConsumed: round2(cargo.fuelUnitsConsumed),
      fuelCostPaid: round2(cargo.fuelCostTotal),
      profit: round2(profit),
    });
  }

  /**
   * Public (not `private`) since Company.directFleet calls this directly on
   * an idle captain to score its best route -- mirrors faction.py's
   * cross-module call to this "private-by-convention" method in Python. The
   * destination-first knapsack itself lives in tradingAgent.ts's
   * findBestBundle (shared with Explorer) -- this just supplies this
   * Captain's own state (cash, transport, cost params, full multi-hop
   * Dijkstra pathfinding) to it.
   */
  findBestLocalRoute(
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    excludeRoutes: ReadonlySet<string> = new Set(),
  ): TradeDirective | null {
    const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    return findBestBundle(
      this.locationName, this.cash, this.transport!.cargoCapacity, this.transport!,
      buyMarkets, sellMarkets, commodities, closedLocations, excludeRoutes, this.minDailyReturnPct,
      fuelPrice, this.costParams(), headingBetween,
      (destination) => findShortestPath(this.locationName, destination, (r) => this.transport!.canUseRoute(r)),
    );
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
    let cursor = producer;
    for (const leg of deliveryPath) {
      const legDestination = leg.origin === cursor ? leg.destination : leg.origin;
      deliveryDays += routeTravelDays(leg, this.currentSpeedUnitsPerDay(headingBetween(cursor, legDestination)));
      cursor = legDestination;
    }

    let repositionDays = 0;
    let repositionFuelCost = 0;
    if (producer !== this.locationName) {
      const repositionPath = findShortestPath(this.locationName, producer, canUse);
      if (repositionPath === null) return null;
      repositionDays = travelDaysBetween(
        this.locationName, producer, this.currentSpeedUnitsPerDay(headingBetween(this.locationName, producer)),
      );
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

  /**
   * Formal day-order step 5 (see CLAUDE.md) -- puts this Captain underway
   * along `path`'s first leg. Split out from the buy step (step 4, which
   * already set `this.cargo` and paid for it before calling this) as its own
   * function call, not fused, so a future step can be inserted between
   * buying and departing without threading more state through one call.
   * Shared by executeLocalRoute and executeContractDelivery -- both buy then
   * hand off to this for the actual departure bookkeeping. Returns false if
   * departing straight into an active Storm just sank the Ship (see
   * applyStormDamageOnDeparture) -- the caller must stop touching `this`
   * immediately, same convention as arrive()'s own return value.
   */
  private leavePort(path: Route[], originLocation: string, leg1FuelUnits: number, day: number): boolean {
    this.status = "InTransit";
    this.transport!.refuel(leg1FuelUnits);
    if (!this.applyStormDamageOnDeparture(day)) return false;

    const firstLeg = path[0];
    this.path = path.slice(1);
    const nextNode = firstLeg.origin === originLocation ? firstLeg.destination : firstLeg.origin;
    this.destination = nextNode;
    this.daysRemaining = routeTravelDays(firstLeg, this.currentSpeedUnitsPerDay(headingBetween(originLocation, nextNode)));
    this.dailyFuelBurn = this.daysRemaining > 0 ? leg1FuelUnits / this.daysRemaining : 0.0;
    return true;
  }

  /**
   * Re-verifies each item in the planned bundle fresh against current
   * markets/cash/capacity (the scored bundle from findBestLocalRoute is a
   * plan, not a guaranteed trade -- markets may have shifted since it was
   * scored), buys whatever's still viable, and departs. Items that fall
   * through (market closed/unavailable, or capacity/cash ran out on an
   * earlier, higher-margin item) are simply left out of this voyage.
   */
  private executeLocalRoute(
    route: { destination: string; items: readonly CargoAllocation[] },
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
  ): void {
    const { destination } = route;
    const executed = reverifyBundle(
      this.locationName, route.items, destination, this.transport!.cargoCapacity, this.cash, buyMarkets, sellMarkets,
    );
    if (executed.length === 0) return;

    const fuelMarket = buyMarkets.get(marketKey(this.locationName, "Fuel"));
    const fuelPrice = fuelMarket !== undefined ? fuelMarket.price : 0.0;
    const econ = this.routeEconomics(
      this.locationName, destination,
      executed.map((e) => ({ commodity: e.commodity, quantity: e.quantity, buyPrice: e.buyPrice, sellPriceEstimate: e.sellPriceEstimate })),
      fuelPrice, buyMarkets,
    );
    if (econ.expectedProfit <= 0 || econ.dailyReturnPct < this.minDailyReturnPct) return;
    if (econ.totalCost > this.cash) return;

    const path = econ.path;
    if (path === null || path.length === 0) return;

    const originLocation = this.locationName;
    const totalQuantity = executed.reduce((sum, e) => sum + e.quantity, 0);
    const leg1FuelUnits = path[0].distance * this.currentFuelConsumptionRate() * totalQuantity;
    const leg1FuelCost = leg1FuelUnits * fuelPrice;
    const { cargoItems, goodsCost } = applyPurchases(executed, this.priceImpact);
    // Crew wages for the WHOLE trip (every leg, see routeEconomics) are paid
    // upfront here alongside goods/fuel/fixed-cost -- there's no later daily
    // deduction while InTransit any more (see act()). Only LEG 1's fuel is
    // charged now -- later legs refuel at each intermediate stop (see
    // refuelAtStop), matching `econ.fuelUnitsConsumed`/`fuelCostTotal` being
    // the whole-trip total but `leg1FuelCost` here being just the first hop.
    const upfront = goodsCost + leg1FuelCost + this.currentFixedShipmentCost() + econ.crewCost;

    this.cash -= upfront;
    this.totalFuelSpent += leg1FuelCost;
    this.totalFuelUnitsConsumed += leg1FuelUnits;
    this.totalFixedFeesSpent += this.transport!.fixedShipmentCost;
    if (fuelMarket !== undefined) this.applyPriceImpact(fuelMarket, leg1FuelUnits, "buy");

    // The trip's shared fuel figures are only recorded on the first item's
    // log line -- repeating them on every item would read as though the full
    // trip fuel cost were paid once per commodity, not once total.
    executed.forEach((e, i) => {
      this.tradeLog.push({
        day,
        action: "BUY",
        commodity: e.commodity,
        location: originLocation,
        destination,
        quantity: round2(e.quantity),
        price: round2(e.buyPrice),
        distance: econ.distance,
        routeType: econ.routeType,
        travelDays: econ.travelDays,
        fuelPrice: i === 0 ? round2(fuelPrice) : null,
        fuelUnitsConsumed: i === 0 ? round2(leg1FuelUnits) : null,
        fuelCostPaid: i === 0 ? round2(leg1FuelCost) : 0.0,
        profit: null,
      });
    });

    this.cargo = {
      items: cargoItems,
      origin: originLocation,
      destination,
      distance: econ.distance,
      routeType: econ.routeType,
      travelDays: econ.travelDays,
      fuelPricePaid: fuelPrice,
      fuelUnitsConsumed: leg1FuelUnits,
      fuelCostTotal: leg1FuelCost,
      totalCost: upfront,
      departureDay: day,
    };

    this.leavePort(path, originLocation, leg1FuelUnits, day);
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
    let cursor = originLocation;
    const routeTypes: RouteType[] = [];
    for (const leg of path) {
      const legDestination = leg.origin === cursor ? leg.destination : leg.origin;
      totalDistance += leg.distance;
      totalDays += routeTravelDays(leg, this.currentSpeedUnitsPerDay(headingBetween(cursor, legDestination)));
      if (!routeTypes.includes(leg.routeType)) routeTypes.push(leg.routeType);
      cursor = legDestination;
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
      items: [{ commodity: contract.commodity, quantity, unitCost: buyPrice, contract }],
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
    };

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

    this.leavePort(path, originLocation, leg1FuelUnits, day);
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
            targetLoc, destLoc,
            [{ commodity, quantity: trialQuantity, buyPrice: targetBuyMarket.price, sellPriceEstimate: destSellMarket.price }],
            fuelPriceAtTarget, buyMarkets,
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
    const repositionDays = travelDaysBetween(
      this.locationName, best.targetLoc, this.currentSpeedUnitsPerDay(headingBetween(this.locationName, best.targetLoc)),
    );
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
    const repositionDays = travelDaysBetween(
      this.locationName, destination, this.currentSpeedUnitsPerDay(headingBetween(this.locationName, destination)),
    );
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
    if (!this.applyStormDamageOnDeparture(day)) return false;
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
    // Contract-bound items are paid for by the issuing Location, not this
    // Captain's Company (see executeContractDelivery), so each is excluded
    // from portfolio value individually -- the same per-item exclusion
    // Faction.netWorth uses, since one voyage's hold can mix a contract item
    // with open-market ones.
    if (this.cargo !== null) {
      const markLocation = this.status === "AtLocation" ? this.locationName : this.cargo.destination;
      for (const item of this.cargo.items) {
        if (item.contract !== null) continue;
        const market = sellMarkets.get(marketKey(markLocation, item.commodity));
        cargoValue += market !== undefined ? market.price * item.quantity : item.unitCost * item.quantity;
      }
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
    // Called once per Captain per day (see World.runDay), so this is also
    // the natural place to trim tradeLog -- it isn't otherwise touched on a
    // fixed once-a-day cadence (trades can happen 0-N times a day).
    trimHistory(this.portfolioHistory, day);
    trimHistory(this.tradeLog, day);
  }

  /** One narrative sentence for a single `tradeLog` entry -- see recordShipLog. */
  private describeTradeLogEntry(entry: TradeLogEntry): string {
    switch (entry.action) {
      case "BUY":
        return `Took on ${entry.quantity.toFixed(1)} units of ${entry.commodity} at ${entry.location}, bound for ${entry.destination}.`;
      case "SELL":
        if (entry.price === null) {
          // fulfillContract -- see its own tradeLog push -- always leaves price null.
          return `Delivered ${entry.quantity.toFixed(1)} ${entry.commodity} at ${entry.location} against a standing supply contract.`;
        }
        return entry.profit !== null && entry.profit >= 0
          ? `Sold ${entry.quantity.toFixed(1)} ${entry.commodity} at ${entry.location} for $${entry.price.toFixed(2)}/unit, a profit of $${entry.profit.toFixed(2)}.`
          : `Sold ${entry.quantity.toFixed(1)} ${entry.commodity} at ${entry.location} for $${entry.price.toFixed(2)}/unit, a loss of $${Math.abs(entry.profit ?? 0).toFixed(2)}.`;
      case "REFUEL":
        return `Took on fuel at ${entry.location}.`;
      case "REPOSITION":
        return `Weighed anchor from ${entry.location} for ${entry.destination}, chasing a better market.`;
      case "ATTACK":
        return entry.commodity !== null
          ? `Ran down a merchant near ${entry.location}, seizing ${entry.quantity.toFixed(1)} ${entry.commodity} and $${(entry.profit ?? 0).toFixed(2)} in coin.`
          : `Ran down a merchant near ${entry.location}, making off with $${(entry.profit ?? 0).toFixed(2)} in coin.`;
      case "SMUGGLE":
        return entry.price === null
          ? `Tried to run ${entry.quantity.toFixed(1)} ${entry.commodity} past the blockade at ${entry.location} -- caught, cargo seized and a fine levied.`
          : `Slipped ${entry.quantity.toFixed(1)} ${entry.commodity} past the blockade at ${entry.location} for a tidy sum.`;
    }
  }

  /**
   * Appends today's entry to this Captain's Ship's Log -- a narrative
   * one-paragraph summary of the day, built entirely from data already
   * recorded elsewhere (tradeLog, agentEventLog) plus a handful of small
   * same-day flags (arrivedToday/repairedToday/shoreLeaveGrantedToday/
   * newShipDay) set at the few call sites that don't otherwise leave a
   * day-stamped trace -- see each flag's own doc comment. Called once per
   * day, for every Captain still in `World.captains` (a Captain whose Ship
   * sank this turn is spliced out before this runs -- see World.runDay --
   * so its FINAL entry is instead written directly by Faction.sinkAtSea/
   * sinkInPort, the only two writers of shipLog outside this method).
   */
  recordShipLog(day: number): void {
    if (!isShipLogEnabled()) return;
    const clauses: string[] = [];

    if (this.newShipDay === day) {
      clauses.push(`Took command of the ${this.transport?.name ?? "vessel"} at ${this.locationName}.`);
    }
    if (this.repairedToday === day) {
      clauses.push(`Spent the day under repair.`);
    }
    if (this.arrivedToday === day) {
      clauses.push(`Made port at ${this.locationName}.`);
    }
    for (const entry of this.tradeLog) {
      if (entry.day === day) clauses.push(this.describeTradeLogEntry(entry));
    }
    for (const entry of this.agentEventLog) {
      if (entry.day === day) clauses.push(`${entry.name} -- ${entry.detail}.`);
    }

    if (clauses.length === 0) {
      if (this.status === "InTransit") {
        const days = this.daysRemaining;
        clauses.push(`Under way toward ${this.destination}, ${days} day${days === 1 ? "" : "s"} out.`);
      } else if (this.status === "Inactive") {
        clauses.push(`Adrift near ${this.locationName}, unable to pay the crew.`);
      } else if (this.groundedDaysRemaining > 0) {
        const days = this.groundedDaysRemaining;
        clauses.push(`Confined to port at ${this.locationName}, ${days} day${days === 1 ? "" : "s"} of penalty remaining.`);
      } else {
        clauses.push(`Rode out a quiet day at anchor in ${this.locationName}.`);
      }
    }

    if (this.shoreLeaveGrantedToday === day) {
      clauses.push(`Crew granted shore leave for the night.`);
    }

    this.shipLog.push({ day, text: clauses.join(" ") });
    trimHistory(this.shipLog, day);
    this.arrivedToday = null;
    this.repairedToday = null;
    this.shoreLeaveGrantedToday = null;
    this.newShipDay = null;
  }
}
