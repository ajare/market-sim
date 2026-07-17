/**
 * Transport: the physical vehicle (capacity, speed, fuel efficiency, fees)
 * decoupled from the trading agent (Captain) that operates it -- plus its
 * Ship/WagonTrain/Plane subclasses and the off-the-shelf SHIP_CLASSES presets.
 * Ported from sim/transport.py.
 */
import type { Route, RouteType } from "./routes";
import type { Sailor } from "./sailor";
import type { Location } from "./location";
import type { Contract } from "./contracts";
import { trimHistory } from "./historyRetention";

export type TransportStatus = "AtLocation" | "InTransit" | "Inactive";

/**
 * One commodity within a voyage's cargo hold -- see CargoState. A single
 * voyage can carry several of these at once (a mixed load), each bought at
 * the same origin and bound for the same destination but priced/costed
 * independently, since each is its own commodity with its own market.
 */
export interface CargoItem {
  commodity: string;
  quantity: number;
  unitCost: number;
  /** Set when this item is being delivered against a supply Contract rather than sold on the open market -- see Captain.fulfillContract. Independent per item, so one voyage can mix a contract-bound item with open-market ones. */
  contract: Contract | null;
}

/**
 * In-transit cargo a Transport is currently carrying -- moved here from
 * Captain (see captain.ts's `cargo` getter/setter) since cargo belongs to the
 * physical vehicle, not whichever Captain currently crews it. Holds a MIX of
 * commodities (see CargoItem) bought at `origin` and bound for `destination`
 * in one voyage -- the trip-level fields below (distance/travelDays/fuel/
 * departureDay) are shared across every item in `items`, since they describe
 * the one voyage carrying them all, not any single commodity.
 */
export interface CargoState {
  items: CargoItem[];
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
}

/** Why a condition-history entry was recorded -- see Transport.recordCondition/conditionHistory. "transit" is ordinary day-by-day decay while underway; "repair" is the jump back to 1.0 a REPAIR Directive gives. */
export type ConditionChangeCause = "transit" | "pirate" | "storm" | "repair";

/** One day's condition-history entry -- see Transport.conditionHistory. */
export interface ConditionRecord {
  day: number;
  condition: number;
  cause: ConditionChangeCause;
}

// Tunable knobs for Ship condition -- see the `condition` field doc on
// Transport. Apply to every decaysCondition FleetOwner's Ships (Company/
// SoloTrader/PirateBrigade/PoliceFleet -- see FleetOwner.decaysCondition in
// faction.ts, the actual per-FleetOwner gate; Captain.act is the consumer).

/** How much a Ship's condition drops for every day it spends genuinely InTransit -- see Captain.act. At this rate a Ship needs 25 days of continuous, unrepaired travel to go from full condition to needing repair. */
export const CONDITION_DECAY_PER_TRANSIT_DAY = 0.02;
/** A docked Ship below this condition must repair (a whole-day REPAIR Directive, see Company.direct/Captain.act) before it's allowed to depart again. */
export const CONDITION_REPAIR_THRESHOLD = 0.5;
/** Random extra condition damage a pirate attack inflicts on top of stealing cash/cargo -- see PirateBrigade.attack. */
export const MIN_ATTACK_CONDITION_DAMAGE = 0.0;
export const MAX_ATTACK_CONDITION_DAMAGE = 0.2;

export interface TransportInit {
  name?: string;
  cargoCapacity?: number;
  speedUnitsPerDay?: number;
  fuelConsumptionPerUnitDistance?: number;
  repositionFuelConsumptionPerDistance?: number;
  fixedShipmentCost?: number;
  fuelCapacity?: number;
  status?: TransportStatus;
  currentFuel?: number | null;
  crewRequirement?: number;
  purchasePrice?: number;
  condition?: number;
}

export class Transport {
  name: string;
  cargoCapacity: number;
  speedUnitsPerDay: number;
  fuelConsumptionPerUnitDistance: number;
  repositionFuelConsumptionPerDistance: number;
  fixedShipmentCost: number;
  fuelCapacity: number;
  status: TransportStatus;
  /** Live fuel gauge; null means this Transport doesn't track fuel and never needs refueling. */
  currentFuel: number | null;
  crewRequirement: number;
  /** Cost to buy a fresh one of these (see World.buyShipForCompany) -- 0 for a Transport that was never meant to be purchased at runtime (every non-SHIP_CLASSES Transport). */
  purchasePrice: number;
  /**
   * [0, 1] -- 1 is pristine, 0 (or below) is destroyed. Every Transport
   * tracks it (initialized to 1), but only `Ship` actually decays it or does
   * anything when it bottoms out -- see `handlesZeroCondition`. What
   * actually HAPPENS when a Ship's condition hits zero (crew fate, cash/
   * cargo loss, Company bookkeeping) lives in Captain.act/FleetOwner, not here
   * -- Transport is deliberately decoupled from the trading agent that owns
   * it (see this file's doc comment) and has no access to a Captain's cash,
   * cargo, or Company.
   */
  condition: number;
  /** Day-by-day condition readings, tagged with why each one was recorded (see recordCondition/ConditionChangeCause) -- read by the viewer's Transport Condition History chart to plot a line per Transport and mark pirate-attack/storm-caused drops distinctly from ordinary transit decay. Empty for a Transport whose condition has never changed (e.g. one that's never left port). */
  conditionHistory: ConditionRecord[] = [];
  crew: Sailor[] = [];
  /**
   * Where this Transport currently is -- the settled Location once docked,
   * or the last node it passed through mid-multi-hop-transit (kept live at
   * every intermediate stop, not just on final arrival -- see arriveAt).
   * Every crewing Person's own `location` is null while aboard (see
   * Person.boardTransport), so this is what Person.currentLocation() falls
   * back to for anyone crewing this Transport. Null only before this
   * Transport has ever been placed anywhere (a freshly constructed, not yet
   * homed Transport).
   */
  location: Location | null = null;
  /** `location`'s name, kept in sync by arriveAt -- a plain string for the many call sites (pathfinding, market lookups) that key off a location name rather than the object itself. */
  currentNode: string | null = null;
  /** In-transit cargo this Transport is currently carrying -- see CargoState (now a mixed, multi-commodity hold, same shape for every Transport type). Belongs to the Transport, not whichever Captain currently crews it (Captain exposes a `cargo` getter/setter that proxies this field for backward-compatible call sites). Null for a Transport that has never loaded cargo, or once it's been sold/dumped/seized. */
  cargo: CargoState | null = null;

  constructor(init: TransportInit = {}) {
    this.name = init.name ?? "Generic Transport";
    this.cargoCapacity = init.cargoCapacity ?? 20.0;
    this.speedUnitsPerDay = init.speedUnitsPerDay ?? 500.0;
    this.fuelConsumptionPerUnitDistance = init.fuelConsumptionPerUnitDistance ?? 0.004;
    this.repositionFuelConsumptionPerDistance = init.repositionFuelConsumptionPerDistance ?? 0.04;
    this.fixedShipmentCost = init.fixedShipmentCost ?? 15.0;
    this.fuelCapacity = init.fuelCapacity ?? 100.0;
    this.status = init.status ?? "AtLocation";
    this.currentFuel = init.currentFuel ?? null;
    this.crewRequirement = init.crewRequirement ?? 1;
    this.purchasePrice = init.purchasePrice ?? 0.0;
    this.condition = init.condition ?? 1.0;
  }

  /**
   * Whether this Transport TYPE is destroyed once `condition` bottoms out --
   * the subclass-dispatched "handler" for zero condition. False (and inert)
   * in the base class and every subclass except `Ship`; the actual
   * consequences of a Ship hitting zero (crew/Captain fate, cash/cargo loss,
   * Company/World bookkeeping) are orchestrated by Captain.act/FleetOwner,
   * which check this before acting -- see this class's `condition` doc.
   */
  handlesZeroCondition(): boolean {
    return false;
  }

  /** Appends today's condition reading, tagged with `cause` -- called right after every place `condition` is actually mutated (transit decay, a REPAIR Directive, a pirate attack, storm/cyclone damage), never speculatively. Trimmed to the global history-retention window like every other day-stamped log (see historyRetention.ts). */
  recordCondition(day: number, cause: ConditionChangeCause): void {
    this.conditionHistory.push({ day, condition: this.condition, cause });
    trimHistory(this.conditionHistory, day);
  }

  /** Marks this Transport as currently at/passing through `location` -- keeps `location` (object) and `currentNode` (its name) in sync in one place, called on initial homing and every arrival (including intermediate multi-hop stops). */
  arriveAt(location: Location): void {
    this.location = location;
    this.currentNode = location.name;
  }

  /** null (the default) means unrestricted -- any RouteType is usable. */
  allowedRouteTypes(): RouteType[] | null {
    return null;
  }

  needsRefuel(fuelRequired: number): boolean {
    if (this.currentFuel === null) return false;
    return this.currentFuel < fuelRequired;
  }

  consumeFuel(amount: number): void {
    if (this.currentFuel !== null) this.currentFuel = Math.max(0.0, this.currentFuel - amount);
  }

  refuel(amount: number): void {
    if (this.currentFuel !== null) this.currentFuel = Math.min(this.fuelCapacity, this.currentFuel + amount);
  }

  /**
   * Removes `member` from this Transport's crew (e.g. the Transports panel's
   * "kill crew member" UI action) -- no-op if not present. Leaves the seat
   * open; for a Ship, the next time it's docked at a Port or Platform,
   * Captain.hireCrewIfPossible tops it back up from that Location's Sailor
   * pool (if it has anyone available -- see sailorPool.ts).
   */
  removeCrewMember(member: Sailor): void {
    const idx = this.crew.indexOf(member);
    if (idx !== -1) this.crew.splice(idx, 1);
  }

  canUseRoute(route: Route | undefined | null): boolean {
    if (route == null) return false;
    const allowed = this.allowedRouteTypes();
    return allowed === null || allowed.includes(route.routeType);
  }

  /** Equivalent of Python's dataclasses.replace() -- clone with field overrides. */
  clone(overrides: Partial<TransportInit> = {}): this {
    const Ctor = this.constructor as new (init: TransportInit) => this;
    return new Ctor({
      name: this.name,
      cargoCapacity: this.cargoCapacity,
      speedUnitsPerDay: this.speedUnitsPerDay,
      fuelConsumptionPerUnitDistance: this.fuelConsumptionPerUnitDistance,
      repositionFuelConsumptionPerDistance: this.repositionFuelConsumptionPerDistance,
      fixedShipmentCost: this.fixedShipmentCost,
      fuelCapacity: this.fuelCapacity,
      status: this.status,
      currentFuel: this.currentFuel,
      crewRequirement: this.crewRequirement,
      purchasePrice: this.purchasePrice,
      condition: this.condition,
      ...overrides,
    });
  }
}

/**
 * A sea-going vessel. NOTE: despite Ship historically being described as
 * "unrestricted", the actual upstream Python implementation overrides
 * `allowed_route_types()` to Sea-only -- ported faithfully as-is (a
 * behavior port, not a bugfix).
 */
export class Ship extends Transport {
  override handlesZeroCondition(): boolean {
    return true;
  }

  constructor(init: TransportInit = {}) {
    // 6 (Handysize's crew size) is the fallback for a generic/editor-authored
    // Ship not built from one of the SHIP_CLASSES presets below, each of
    // which passes its own crewRequirement explicitly.
    super({ name: "Standard Freighter", crewRequirement: 6, ...init });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Sea"];
  }
}

/**
 * Fraction of a Ship's plain speedUnitsPerDay it currently makes, given how
 * fully crewed it is -- 50% with just its Captain aboard, up to 100% at a
 * full complement (crewRequirement), linear in between. A Ship's Sailors are
 * hired for free while docked at a Port (see Captain.hireCrewIfPossible);
 * every other Transport type is always 100% -- crew fullness doesn't affect
 * it. Used both by Captain (to price/estimate a trip's actual travel time)
 * and the Transports UI panel (to show a Ship's current speed).
 */
export function crewSpeedFraction(transport: Transport): number {
  if (!(transport instanceof Ship)) return 1;
  const sailorsNeeded = transport.crewRequirement - 1;
  if (sailorsNeeded <= 0) return 1;
  const sailorsHired = transport.crew.length - 1;
  return 0.5 + 0.5 * Math.min(1, sailorsHired / sailorsNeeded);
}

export class WagonTrain extends Transport {
  constructor(init: TransportInit = {}) {
    super({
      name: "Freight Train",
      cargoCapacity: 25.0,
      speedUnitsPerDay: 450.0,
      fuelConsumptionPerUnitDistance: 0.002,
      repositionFuelConsumptionPerDistance: 0.018,
      fixedShipmentCost: 10.0,
      fuelCapacity: 60.0,
      ...init,
    });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Land"];
  }
}

export class Plane extends Transport {
  constructor(init: TransportInit = {}) {
    super({
      name: "Cargo Plane",
      cargoCapacity: 6.0,
      speedUnitsPerDay: 2200.0,
      fuelConsumptionPerUnitDistance: 0.009,
      repositionFuelConsumptionPerDistance: 0.07,
      fixedShipmentCost: 40.0,
      fuelCapacity: 40.0,
      ...init,
    });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Air"];
  }
}

export class Lorry extends Transport {
  constructor(init: TransportInit = {}) {
    super({
      name: "Box Lorry",
      cargoCapacity: 15.0,
      speedUnitsPerDay: 500.0,
      fuelConsumptionPerUnitDistance: 0.0035,
      repositionFuelConsumptionPerDistance: 0.03,
      fixedShipmentCost: 8.0,
      fuelCapacity: 50.0,
      ...init,
    });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Road"];
  }
}

export class FreightTrain extends Transport {
  constructor(init: TransportInit = {}) {
    super({
      name: "Freight Train",
      cargoCapacity: 40.0,
      speedUnitsPerDay: 550.0,
      fuelConsumptionPerUnitDistance: 0.0025,
      repositionFuelConsumptionPerDistance: 0.02,
      fixedShipmentCost: 12.0,
      fuelCapacity: 80.0,
      ...init,
    });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Railroad"];
  }
}

export class Spaceship extends Transport {
  constructor(init: TransportInit = {}) {
    super({
      name: "Star Freighter",
      cargoCapacity: 50.0,
      speedUnitsPerDay: 5000.0,
      fuelConsumptionPerUnitDistance: 0.012,
      repositionFuelConsumptionPerDistance: 0.1,
      fixedShipmentCost: 120.0,
      fuelCapacity: 200.0,
      ...init,
    });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Space"];
  }
}

/** cargoCapacity contribution from the party itself, before any porters/pack animals are counted -- see PorterParty. */
export const PORTER_PARTY_BASE_CAPACITY = 20.0;
/** cargoCapacity contributed by each porter -- see PorterParty. */
export const PORTER_PARTY_CAPACITY_PER_PORTER = 15.0;
/** cargoCapacity contributed by each pack animal -- see PorterParty. */
export const PORTER_PARTY_CAPACITY_PER_ANIMAL = 40.0;

export interface PorterPartyInit extends TransportInit {
  porterCount?: number;
  animalCount?: number;
}

/**
 * An on-foot expedition party (explorer game mode) -- travels Trail routes
 * only, uses the same multi-commodity `cargo` (CargoState) every other
 * Transport does (see Explorer, which trades under the same rules as a Ship
 * -- tradingAgent.ts), and burns no fuel at all (currentFuel stays null,
 * same treatment as SailingVessel -- needsRefuel() is always false).
 * cargoCapacity here is WEIGHT capacity, not a plain unit count: it's
 * computed once at construction from porterCount/animalCount (see
 * recomputeCapacity) -- dynamically changing headcount (hiring, desertion) is
 * out of scope for the exploration skeleton.
 */
export class PorterParty extends Transport {
  porterCount: number;
  animalCount: number;

  constructor(init: PorterPartyInit = {}) {
    super({
      name: "Porter Party",
      speedUnitsPerDay: 60.0,
      fuelConsumptionPerUnitDistance: 0.0,
      repositionFuelConsumptionPerDistance: 0.0,
      fixedShipmentCost: 0.0,
      fuelCapacity: 0.0,
      currentFuel: null,
      crewRequirement: 1,
      ...init,
    });
    this.porterCount = init.porterCount ?? 4;
    this.animalCount = init.animalCount ?? 0;
    this.recomputeCapacity();
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Trail"];
  }

  /** Recomputes cargoCapacity from the current porterCount/animalCount -- call after either changes (not automatic; this skeleton never changes them post-construction). */
  recomputeCapacity(): void {
    this.cargoCapacity =
      PORTER_PARTY_BASE_CAPACITY +
      PORTER_PARTY_CAPACITY_PER_PORTER * this.porterCount +
      PORTER_PARTY_CAPACITY_PER_ANIMAL * this.animalCount;
  }
}

/** Purchase price per unit of cargoCapacity -- see World.buyShipForCompany, the only thing that spends this. Calibrated against buildWorld's own cashPerShip (10,000, the typical starting capital allocated per initial-fleet ship) so a mid-size Panamax costs roughly one ship's worth of starting capital. */
const PURCHASE_PRICE_PER_CARGO_UNIT = 50.0;

// Off-the-shelf classes spanning the capacity/speed/efficiency trade-off
// space. Small and fast burns less fuel per trip but can't move much
// cargo; large and slow moves a lot but ties up more capital per voyage.
// purchasePrice is fixed per class (not computed at runtime), but set
// proportional to cargoCapacity -- see PURCHASE_PRICE_PER_CARGO_UNIT.
export const SHIP_CLASSES: Record<string, Ship> = {
  Speedster: new Ship({
    name: "Speedster", cargoCapacity: 80.0, speedUnitsPerDay: 800.0,
    fuelConsumptionPerUnitDistance: 0.003, repositionFuelConsumptionPerDistance: 0.025,
    fixedShipmentCost: 8.0, fuelCapacity: 60.0, currentFuel: 0.0, crewRequirement: 4,
    purchasePrice: 80.0 * PURCHASE_PRICE_PER_CARGO_UNIT,
  }),
  Handysize: new Ship({
    name: "Handysize", cargoCapacity: 120.0, speedUnitsPerDay: 600.0,
    fuelConsumptionPerUnitDistance: 0.0035, repositionFuelConsumptionPerDistance: 0.03,
    fixedShipmentCost: 10.0, fuelCapacity: 90.0, currentFuel: 0.0, crewRequirement: 6,
    purchasePrice: 120.0 * PURCHASE_PRICE_PER_CARGO_UNIT,
  }),
  Panamax: new Ship({
    name: "Panamax", cargoCapacity: 200.0, speedUnitsPerDay: 500.0,
    fuelConsumptionPerUnitDistance: 0.004, repositionFuelConsumptionPerDistance: 0.04,
    fixedShipmentCost: 15.0, fuelCapacity: 140.0, currentFuel: 0.0, crewRequirement: 9,
    purchasePrice: 200.0 * PURCHASE_PRICE_PER_CARGO_UNIT,
  }),
  Capesize: new Ship({
    name: "Capesize", cargoCapacity: 350.0, speedUnitsPerDay: 400.0,
    fuelConsumptionPerUnitDistance: 0.0045, repositionFuelConsumptionPerDistance: 0.05,
    fixedShipmentCost: 25.0, fuelCapacity: 220.0, currentFuel: 0.0, crewRequirement: 13,
    purchasePrice: 350.0 * PURCHASE_PRICE_PER_CARGO_UNIT,
  }),
  // Wind-powered -- burns no fuel at all, and leaves currentFuel at null,
  // so needsRefuel() is always false: never needs a refueling stop.
  SailingVessel: new Ship({
    name: "SailingVessel", cargoCapacity: 100.0, speedUnitsPerDay: 300.0,
    fuelConsumptionPerUnitDistance: 0.0, repositionFuelConsumptionPerDistance: 0.0,
    fixedShipmentCost: 5.0, fuelCapacity: 0.0, currentFuel: null, crewRequirement: 3,
    purchasePrice: 100.0 * PURCHASE_PRICE_PER_CARGO_UNIT,
  }),
};
