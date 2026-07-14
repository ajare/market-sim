/**
 * Transport: the physical vehicle (capacity, speed, fuel efficiency, fees)
 * decoupled from the trading agent (Captain) that operates it -- plus its
 * Ship/WagonTrain/Plane subclasses and the off-the-shelf SHIP_CLASSES presets.
 * Ported from sim/transport.py.
 */
import type { Route, RouteType } from "./routes";
import type { Sailor } from "./sailor";
import type { Location } from "./location";

export type TransportStatus = "AtLocation" | "InTransit" | "Inactive";

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

// Off-the-shelf classes spanning the capacity/speed/efficiency trade-off
// space. Small and fast burns less fuel per trip but can't move much
// cargo; large and slow moves a lot but ties up more capital per voyage.
export const SHIP_CLASSES: Record<string, Ship> = {
  Speedster: new Ship({
    name: "Speedster", cargoCapacity: 80.0, speedUnitsPerDay: 800.0,
    fuelConsumptionPerUnitDistance: 0.003, repositionFuelConsumptionPerDistance: 0.025,
    fixedShipmentCost: 8.0, fuelCapacity: 60.0, currentFuel: 0.0, crewRequirement: 4,
  }),
  Handysize: new Ship({
    name: "Handysize", cargoCapacity: 120.0, speedUnitsPerDay: 600.0,
    fuelConsumptionPerUnitDistance: 0.0035, repositionFuelConsumptionPerDistance: 0.03,
    fixedShipmentCost: 10.0, fuelCapacity: 90.0, currentFuel: 0.0, crewRequirement: 6,
  }),
  Panamax: new Ship({
    name: "Panamax", cargoCapacity: 200.0, speedUnitsPerDay: 500.0,
    fuelConsumptionPerUnitDistance: 0.004, repositionFuelConsumptionPerDistance: 0.04,
    fixedShipmentCost: 15.0, fuelCapacity: 140.0, currentFuel: 0.0, crewRequirement: 9,
  }),
  Capesize: new Ship({
    name: "Capesize", cargoCapacity: 350.0, speedUnitsPerDay: 400.0,
    fuelConsumptionPerUnitDistance: 0.0045, repositionFuelConsumptionPerDistance: 0.05,
    fixedShipmentCost: 25.0, fuelCapacity: 220.0, currentFuel: 0.0, crewRequirement: 13,
  }),
  // Wind-powered -- burns no fuel at all, and leaves currentFuel at null,
  // so needsRefuel() is always false: never needs a refueling stop.
  SailingVessel: new Ship({
    name: "SailingVessel", cargoCapacity: 100.0, speedUnitsPerDay: 300.0,
    fuelConsumptionPerUnitDistance: 0.0, repositionFuelConsumptionPerDistance: 0.0,
    fixedShipmentCost: 5.0, fuelCapacity: 0.0, currentFuel: null, crewRequirement: 3,
  }),
};
