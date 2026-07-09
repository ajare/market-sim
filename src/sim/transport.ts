/**
 * Transport: the physical vehicle (capacity, speed, fuel efficiency, fees)
 * decoupled from the trading agent (Captain) that operates it -- plus its
 * Ship/Train/Plane subclasses and the off-the-shelf SHIP_CLASSES presets.
 * Ported from sim/transport.py.
 */
import type { Route, RouteType } from "./routes";
import type { Crew } from "./crew";

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
  crew: Crew[] = [];

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
    super({ name: "Standard Freighter", ...init });
  }

  override allowedRouteTypes(): RouteType[] | null {
    return ["Sea"];
  }
}

export class Train extends Transport {
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
    return ["Railroad"];
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

// Off-the-shelf classes spanning the capacity/speed/efficiency trade-off
// space. Small and fast burns less fuel per trip but can't move much
// cargo; large and slow moves a lot but ties up more capital per voyage.
export const SHIP_CLASSES: Record<string, Ship> = {
  Speedster: new Ship({
    name: "Speedster", cargoCapacity: 80.0, speedUnitsPerDay: 800.0,
    fuelConsumptionPerUnitDistance: 0.003, repositionFuelConsumptionPerDistance: 0.025,
    fixedShipmentCost: 8.0, fuelCapacity: 60.0, currentFuel: 0.0,
  }),
  Handysize: new Ship({
    name: "Handysize", cargoCapacity: 120.0, speedUnitsPerDay: 600.0,
    fuelConsumptionPerUnitDistance: 0.0035, repositionFuelConsumptionPerDistance: 0.03,
    fixedShipmentCost: 10.0, fuelCapacity: 90.0, currentFuel: 0.0,
  }),
  Panamax: new Ship({
    name: "Panamax", cargoCapacity: 200.0, speedUnitsPerDay: 500.0,
    fuelConsumptionPerUnitDistance: 0.004, repositionFuelConsumptionPerDistance: 0.04,
    fixedShipmentCost: 15.0, fuelCapacity: 140.0, currentFuel: 0.0,
  }),
  Capesize: new Ship({
    name: "Capesize", cargoCapacity: 350.0, speedUnitsPerDay: 400.0,
    fuelConsumptionPerUnitDistance: 0.0045, repositionFuelConsumptionPerDistance: 0.05,
    fixedShipmentCost: 25.0, fuelCapacity: 220.0, currentFuel: 0.0,
  }),
  // Wind-powered -- burns no fuel at all, and leaves currentFuel at null,
  // so needsRefuel() is always false: never needs a refueling stop.
  SailingVessel: new Ship({
    name: "SailingVessel", cargoCapacity: 100.0, speedUnitsPerDay: 300.0,
    fuelConsumptionPerUnitDistance: 0.0, repositionFuelConsumptionPerDistance: 0.0,
    fixedShipmentCost: 5.0, fuelCapacity: 0.0, currentFuel: null,
  }),
};
