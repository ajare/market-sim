/**
 * World: orchestrates every (location, commodity) market together --
 * scheduling events/closures, running the day loop. Ported from
 * sim/world.py, minus its console/CSV/matplotlib reporting methods
 * (build_daily_agent_log / build_location_daily_reports /
 * build_company_daily_reports / save_*_csv / plot_* / print_*) -- pure
 * data-shaping code with no new simulation logic, deferred to whichever
 * phase-2 panel first needs it.
 */
import { type Event, MarketEvent, LocationClosure } from "./events";
import { Location } from "./location";
import { Market, marketKey, type MarketRecord } from "./markets";
import { Ship } from "./transport";
import { Captain, type Directive } from "./captain";
import { ENGLISH_NAMES, SPANISH_NAMES, randomPersonName, type Gender, type NamePool, type NameRng } from "./names";
import { ENGLISH_SHIP_NAMES, SPANISH_SHIP_NAMES, randomShipName } from "./shipNames";
import { randomLocationName } from "./locationNames";
import { NATIONALITY_POOLS, randomNationality } from "./nationality";
import { Faction, Company, ContractFulfiller, PirateBrigade, PoliceFleet } from "./faction";
import { generateSailorPool } from "./sailorPool";
import { locationSupportsTransport } from "./companyHome";
import type { PoliticalEntity } from "./politicalEntity";
import { primeRouteGraphCache } from "./pathfinding";
import { randChoice, randInt, randRandom, randShuffle, seedSimRandom, randSample, randUniform } from "./simRandom";
import { randomBirthDate } from "./person";
import { SAILOR_MIN_AGE, SAILOR_MAX_AGE } from "./sailor";
import {
  LOCATIONS, LOCATION_COORDINATES, COMMODITIES, setGeography, getLocation, getDistanceConfig, FUEL_BASE_PRICE,
  setWorldStartDate,
} from "./worldData";
import { Route, ROUTES, setRoutes, addRouteToNetwork, routeKey } from "./routes";
import {
  planSeaRoutes, seaRoutesBlockedBy, DEFAULT_START_DATE, type RoutePlannerLocation, type RoutePlannerRoute,
} from "@market-sim/shared";

/** Adapts the global sim RNG to the NameRng surface randomPersonName needs, so pirate/police captains draw names off the same live stream as the rest of the simulation. */
const globalNameRng: NameRng = { random: randRandom, choice: randChoice };
import { BulletinBoard, contractKey, type Contract, type TenderContractsOptions } from "./contracts";

/** A freshly rolled name/gender (from `pool`) plus a plausible birth date -- the Person fields every new Captain constructed directly in this file (pirate/police fleets, addPirateShip/addPoliceShip, addLocation's fleet top-up) needs alongside its homeLocation. */
function randomCaptainPersonFields(pool: NamePool): { name: string; gender: Gender; dateOfBirth: Date } {
  const { name, gender } = randomPersonName(globalNameRng, pool);
  const dateOfBirth = randomBirthDate(globalNameRng.random, SAILOR_MIN_AGE, SAILOR_MAX_AGE);
  return { name, gender, dateOfBirth };
}
import { round2 } from "./utils";

// Locations must fall within this range. Calibrated via seed-averaged
// stockpile-ratio sweeps (see analysis.ts / npm run sweep): below ~20 total
// locations, the stockpile-vs-minimum target becomes structurally
// unreachable (it plateaus well under 1.0 even with a much larger fleet --
// a 10-hub/13-location world tops out around 0.88 mean ratio at 3x the
// calibrated ships/location ratio); the default 33-location world and
// larger comfortably clear the target at the calibrated fleet size.
export const MIN_LOCATIONS = 20;
export const MAX_LOCATIONS = 50;

export type AgentOrderFn = (traders: Captain[], day: number) => Captain[];

/** Default act-order strategy: shuffle the fleet freshly each day so no agent structurally gets first crack at a shared market. */
export function randomAgentOrder(traders: Captain[], _day: number): Captain[] {
  const order = [...traders];
  randShuffle(order);
  return order;
}

/** Always acts in the same (list) order -- useful for deterministic debugging, at the cost of first-mover bias. */
export function fixedAgentOrder(traders: Captain[], _day: number): Captain[] {
  return [...traders];
}

interface BroadEventEntry {
  scope: string;
  subject: string;
  startDay: number;
  event: MarketEvent;
}

interface BroadEventLogEntry {
  scope: string;
  subject: string;
  name: string;
  startDay: number;
  durationDays: number;
}

export interface NamedEvent {
  scope: string;
  subject: string;
  name: string;
  startDay: number | null;
  daysRemaining: number;
  durationDays: number;
}

export interface WorldInit {
  locations: Location[];
  globalEventProbability?: number;
  localEventProbability?: number;
  locationEventProbability?: number;
  worldwideEventProbability?: number;
  locationClosureProbability?: number;
  companyEventProbability?: number;
  seed?: number;
  traders?: Captain[];
  factions?: Faction[];
  agentOrderFn?: AgentOrderFn;
  numPoliceShips?: number;
  /** Ship count for the single World-built PirateBrigade -- see numPoliceShips for the analogous Coast Guard knob. Default 0 (no pirates). */
  numPirateShips?: number;
  /** Starting cash for the whole PirateBrigade (split evenly across its captains -- PirateBrigade.poolsCash is false, see Faction's constructor). Default 0. */
  pirateStartingCash?: number;
  /** Overrides for Location.tenderContracts' tunable knobs (expiry, fee curve, quantity multiplier) -- defaults to contracts.ts's module constants if omitted. */
  contractOptions?: TenderContractsOptions;
  /** The in-world date/time of day 1, as an ISO 8601 string -- see startDate/currentDate. Default DEFAULT_START_DATE. */
  startDate?: string;
}

export { DEFAULT_START_DATE };

export class World {
  locations: Location[];
  globalEventProbability: number;
  locationEventProbability: number;
  worldwideEventProbability: number;
  locationClosureProbability: number;
  companyEventProbability: number;
  /** Per-Market event probability new Markets are created with -- remembered so addLocation's new Markets match the rest of this World's, not a hardcoded default. */
  private localEventProbability: number;
  closedLocations = new Map<string, LocationClosure>();
  closureLog: Array<{ day: number; location: string; event: string; durationDays: number }> = [];
  buyMarkets = new Map<string, Market>();
  sellMarkets = new Map<string, Market>();
  combinedHistory: MarketRecord[] = [];
  activeBroadEvents: BroadEventEntry[] = [];
  broadEventLog: BroadEventLogEntry[] = [];
  eventLog: Event[] = [];
  factions: Faction[];
  pirateBrigade: PirateBrigade | null;
  policeFleet: PoliceFleet | null;
  captains: Captain[];
  agentOrderFn: AgentOrderFn;
  bulletinBoard = new BulletinBoard();
  contractOptions: TenderContractsOptions;
  /** Per-ship average starting cash, remembered from init.pirateStartingCash so addPirateShip can give a freshly recruited ship the same average stake as the initial fleet. */
  private pirateShipStartingCash: number;
  /**
   * Pirate ships AtLocation, by Location name, as of the end of the last
   * completed day -- recomputed at the end of every runDay call (see the
   * Market-pricing step) and read again at the START of the next day's
   * tenderContracts pass, so a freshly tendered Contract's deliveryFee can
   * factor in the same up-to-date risk picture Market prices already use.
   * Empty on day 1 (no completed day yet to observe positions from).
   */
  private pirateCountsByLocation = new Map<string, number>();
  private nextDay = 1;
  /** The calendar date/time of day 1 -- currentDate advances from this by exactly one day per completed step(). */
  private startDate: Date;

  /** The in-world date/time as of the start of the next unsimulated day (i.e. day 1's date before any step() call). Time-of-day is carried from startDate; only the calendar date is meant for display (see ControlsPanel). */
  get currentDate(): Date {
    const date = new Date(this.startDate);
    date.setUTCDate(date.getUTCDate() + (this.nextDay - 1));
    return date;
  }

  /** Every Contract currently in play: open board postings plus every ContractFulfiller's accepted-but-not-yet-fulfilled ones (a just-fulfilled contract stays visible here for the rest of the day it was delivered -- it's only pruned from its fulfiller's own list at the start of that fulfiller's next servicing pass). */
  get contracts(): Contract[] {
    return [
      ...this.bulletinBoard.open,
      ...this.factions.flatMap((f) => (f instanceof ContractFulfiller ? f.contracts : [])),
    ];
  }

  constructor(init: WorldInit) {
    if (init.locations.length < MIN_LOCATIONS || init.locations.length > MAX_LOCATIONS) {
      throw new Error(
        `World: locations.length must be between ${MIN_LOCATIONS} and ${MAX_LOCATIONS} (got ${init.locations.length}).`,
      );
    }
    if (init.seed !== undefined) {
      // World's own seed reseeds the shared sim RNG separately from the
      // (already-generated, independently-seeded) network geography --
      // see simRandom.ts / rng.ts.
      seedSimRandom(init.seed);
    }
    primeRouteGraphCache();

    this.locations = init.locations;
    this.contractOptions = init.contractOptions ?? {};
    this.globalEventProbability = init.globalEventProbability ?? 0.006;
    this.locationEventProbability = init.locationEventProbability ?? 0.004;
    this.worldwideEventProbability = init.worldwideEventProbability ?? 0.002;
    this.locationClosureProbability = init.locationClosureProbability ?? 0.001;
    this.companyEventProbability = init.companyEventProbability ?? 0.005;
    const localEventProbability = init.localEventProbability ?? 0.008;
    this.localEventProbability = localEventProbability;
    this.startDate = new Date(init.startDate ?? DEFAULT_START_DATE);
    setWorldStartDate(this.startDate);

    this.factions = init.factions ? [...init.factions] : [];

    // A single World-wide PirateBrigade, built the same way as the Coast
    // Guard PoliceFleet below (random home ports, one flat ship count) --
    // must run BEFORE the PoliceFleet block so its `this.factions.filter(f
    // => f instanceof PirateBrigade)` target lookup actually finds it.
    const numPirateShips = init.numPirateShips ?? 0;
    this.pirateShipStartingCash = numPirateShips > 0 ? (init.pirateStartingCash ?? 0) / numPirateShips : (init.pirateStartingCash ?? 0);
    if (numPirateShips > 0) {
      const pirateCrew: Array<[Ship, Captain, string]> = [];
      for (let i = 0; i < numPirateShips; i++) {
        const homeLocation = randChoice(init.locations);
        const ship = new Ship({ name: randomShipName(globalNameRng, SPANISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
        const captain = new Captain({ ...randomCaptainPersonFields(SPANISH_NAMES), homeLocation });
        pirateCrew.push([ship, captain, homeLocation.name]);
      }
      this.pirateBrigade = new PirateBrigade(
        "Pirate Brigade",
        pirateCrew,
        this.factions.filter((f): f is Company => f instanceof Company),
        init.pirateStartingCash ?? 0,
      );
      this.factions.push(this.pirateBrigade);
    } else {
      this.pirateBrigade = null;
    }

    const numPoliceShips = init.numPoliceShips ?? 3;
    if (numPoliceShips > 0) {
      const policeCrew: Array<[Ship, Captain, string]> = [];
      for (let i = 0; i < numPoliceShips; i++) {
        const homeLocation = randChoice(init.locations);
        const ship = new Ship({ name: randomShipName(globalNameRng, ENGLISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
        const captain = new Captain({ ...randomCaptainPersonFields(ENGLISH_NAMES), homeLocation });
        policeCrew.push([ship, captain, homeLocation.name]);
      }
      this.policeFleet = new PoliceFleet(
        "Coast Guard",
        policeCrew,
        this.factions.filter((f): f is PirateBrigade => f instanceof PirateBrigade),
      );
      this.factions.push(this.policeFleet);
      for (const faction of this.factions) {
        if (faction instanceof PirateBrigade) faction.policeFleets.push(this.policeFleet);
      }
    } else {
      this.policeFleet = null;
    }

    // Every initial Faction (Company/SoloTrader from init.factions, plus the
    // PirateBrigade/PoliceFleet just built above) has registered its
    // Transports but only seated its Captains so far -- crewFleet() (which
    // fills the remaining seats from the Sailor pool) hasn't run yet, so the
    // pool can be sized off every Faction's true demand before any of them
    // draw from it. See sailorPool.generateSailorPool / Faction.crewFleet.
    generateSailorPool(this.factions);
    for (const faction of this.factions) faction.crewFleet();

    this.captains = [...(init.traders ?? []), ...this.factions.flatMap((f) => f.captains)];
    this.agentOrderFn = init.agentOrderFn ?? randomAgentOrder;

    for (const location of init.locations) {
      for (const commodity of Object.keys(location.producedCommodities)) {
        const basePrice = location.basePrice(commodity);
        const market = new Market(commodity, location.name, location, basePrice, basePrice, "buy", localEventProbability);
        this.buyMarkets.set(marketKey(location.name, commodity), market);
      }
      for (const commodity of Object.keys(location.consumedCommodities)) {
        const basePrice = location.basePrice(commodity);
        const market = new Market(commodity, location.name, location, basePrice, basePrice, "sell", localEventProbability);
        this.sellMarkets.set(marketKey(location.name, commodity), market);
      }
      const fuelMarket = new Market(
        "Fuel", location.name, location, location.fuelPrice, location.fuelPrice, "buy",
        localEventProbability, true,
      );
      this.buyMarkets.set(marketKey(location.name, "Fuel"), fuelMarket);
    }
  }

  /**
   * Recruits a new pirate Ship/Captain at a random Location and adds it to
   * the single World-wide PirateBrigade -- lazily creating that brigade if
   * numPirateShips was 0 at construction (e.g. a pirate-free world whose UI
   * later asks to add one). The new ship gets the same average starting
   * cash as the initial fleet (see pirateShipStartingCash).
   */
  addPirateShip(): Captain {
    if (this.pirateBrigade === null) {
      this.pirateBrigade = new PirateBrigade(
        "Pirate Brigade",
        [],
        this.factions.filter((f): f is Company => f instanceof Company),
      );
      this.factions.push(this.pirateBrigade);
      if (this.policeFleet !== null) this.policeFleet.targets.push(this.pirateBrigade);
    }
    const homeLocationObj = randChoice(this.locations);
    const ship = new Ship({ name: randomShipName(globalNameRng, SPANISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
    const captain = new Captain({ ...randomCaptainPersonFields(SPANISH_NAMES), homeLocation: homeLocationObj });
    this.pirateBrigade.addTransport(ship, captain, homeLocationObj.name, this.pirateShipStartingCash);
    this.captains.push(captain);
    return captain;
  }

  /** Removes a random Ship/Captain from the PirateBrigade. Returns the removed Captain, or null if there is no PirateBrigade (or it's already empty). */
  removePirateShip(): Captain | null {
    if (this.pirateBrigade === null || this.pirateBrigade.captains.length === 0) return null;
    const captain = randChoice(this.pirateBrigade.captains);
    this.pirateBrigade.removeTransport(captain);
    const idx = this.captains.indexOf(captain);
    if (idx !== -1) this.captains.splice(idx, 1);
    return captain;
  }

  /** Recruits a new Coast Guard Ship/Captain at a random Location -- lazily creating the PoliceFleet if numPoliceShips was 0 at construction. Mirrors addPirateShip. */
  addPoliceShip(): Captain {
    if (this.policeFleet === null) {
      this.policeFleet = new PoliceFleet(
        "Coast Guard",
        [],
        this.factions.filter((f): f is PirateBrigade => f instanceof PirateBrigade),
      );
      this.factions.push(this.policeFleet);
      for (const faction of this.factions) {
        if (faction instanceof PirateBrigade) faction.policeFleets.push(this.policeFleet);
      }
    }
    const homeLocationObj = randChoice(this.locations);
    const ship = new Ship({ name: randomShipName(globalNameRng, ENGLISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
    const captain = new Captain({ ...randomCaptainPersonFields(ENGLISH_NAMES), homeLocation: homeLocationObj });
    this.policeFleet.addTransport(ship, captain, homeLocationObj.name);
    this.captains.push(captain);
    return captain;
  }

  /** Removes a random Ship/Captain from the PoliceFleet. Returns the removed Captain, or null if there is no PoliceFleet (or it's already empty). */
  removePoliceShip(): Captain | null {
    if (this.policeFleet === null || this.policeFleet.captains.length === 0) return null;
    const captain = randChoice(this.policeFleet.captains);
    this.policeFleet.removeTransport(captain);
    const idx = this.captains.indexOf(captain);
    if (idx !== -1) this.captains.splice(idx, 1);
    return captain;
  }

  /**
   * Adds a brand-new Location at (x, y) (world-unit coordinates), affiliated
   * with `politicalEntity` -- the live-simulation counterpart of the editor's
   * click-to-place (see NetworkView.tsx). Named from the entity's
   * nationality (deduped against every existing Location name, world-wide --
   * Location names are live engine keys), given a Port terminal and
   * randomly-generated produced commodities only (drawn the same
   * per-location way generateLocations does, but WITHOUT its world-wide
   * production/consumption rebalance -- every other Location's numbers are
   * left untouched). Connects it to existing sea-capable Locations via the
   * shared route planner (the same max-distance/detour-distance rule the
   * editor's auto-connect uses), removes any existing Sea route the new port
   * now sits too close to, and tops up the fleet (round(current ships /
   * current locations) new Ships, $0 starting cash, distributed round-robin
   * across eligible multi-ship Companies at THEIR OWN home Location) to keep
   * the ships-per-location ratio roughly constant. Returns the new Location.
   */
  addLocation(
    x: number,
    y: number,
    politicalEntity: PoliticalEntity,
    detourDistance: number,
    maxDistance: number,
  ): Location {
    // 1. Name, world-wide unique.
    const pool = NATIONALITY_POOLS[politicalEntity.nationality].locations;
    const name = randomLocationName(globalNameRng, pool, this.locations.map((l) => l.name));

    // 2. Randomly-generated produced commodities only -- no consumed
    // commodities, no world-wide rebalance (see this method's doc comment).
    const commodityNames = Object.keys(COMMODITIES);
    const produced = randSample(commodityNames, Math.min(randInt(2, 4), commodityNames.length));
    const producedCommodities: Record<string, number> = {};
    const stockpiles: Record<string, number> = {};
    const basePriceModifiers: Record<string, number> = {};
    for (const c of produced) {
      const modifier = round2(randUniform(0.7, 1.3));
      producedCommodities[c] = modifier;
      const effectiveRate = COMMODITIES[c].baseProductionRate * modifier;
      stockpiles[c] = round2(effectiveRate * randUniform(10, 25));
      basePriceModifiers[c] = round2(randUniform(0.85, 1.15));
    }

    const location = new Location({
      name,
      producedCommodities,
      consumedCommodities: {},
      stockpiles,
      minStockpiles: {},
      basePriceModifiers,
      fuelPrice: FUEL_BASE_PRICE,
      terminalTypes: new Set(["Port"]),
    });

    // 3. Register: PoliticalEntity, worldData's module-level geography, this
    // World's own locations/Markets.
    politicalEntity.locations.push(location);
    location.politicalEntity = politicalEntity;

    this.locations.push(location);
    setGeography([...LOCATIONS, location], { ...LOCATION_COORDINATES, [name]: [x, y] });

    for (const commodity of Object.keys(location.producedCommodities)) {
      const basePrice = location.basePrice(commodity);
      const market = new Market(commodity, location.name, location, basePrice, basePrice, "buy", this.localEventProbability);
      this.buyMarkets.set(marketKey(location.name, commodity), market);
    }
    const fuelMarket = new Market(
      "Fuel", location.name, location, location.fuelPrice, location.fuelPrice, "buy", this.localEventProbability, true,
    );
    this.buyMarkets.set(marketKey(location.name, "Fuel"), fuelMarket);

    // 4. Route planning: connect the new port to existing sea-capable
    // Locations (shared max-distance/detour-distance rule), then remove any
    // existing Sea route the new port now sits too close to. ROUTES is
    // reassigned to a brand-new Map instance (setRoutes) so pathfinding's
    // WeakMap-keyed adjacency cache naturally misses and rebuilds -- mutating
    // the existing Map in place would leave stale cached adjacency behind.
    const config = getDistanceConfig();
    const plannerLocations: RoutePlannerLocation[] = this.locations.map((l) => {
      const [lx, ly] = LOCATION_COORDINATES[l.name];
      return { id: l.name, x: lx, y: ly, terminalTypes: [...l.terminalTypes] };
    });
    const existingRoutes: RoutePlannerRoute[] = [...ROUTES.values()]
      .flat()
      .map((r) => ({ locationAId: r.origin, locationBId: r.destination, routeType: r.routeType }));

    const newPortPlanner = plannerLocations.find((l) => l.id === name)!;
    const blocked = seaRoutesBlockedBy(newPortPlanner, plannerLocations, existingRoutes, detourDistance, config);
    const newPairs = planSeaRoutes(plannerLocations, existingRoutes, detourDistance, maxDistance, config);

    const updatedRoutes = new Map<string, Route[]>();
    for (const [key, list] of ROUTES) updatedRoutes.set(key, [...list]);
    for (const b of blocked) {
      const key = routeKey(b.locationAId, b.locationBId);
      const remaining = (updatedRoutes.get(key) ?? []).filter((r) => r.routeType !== "Sea");
      if (remaining.length > 0) updatedRoutes.set(key, remaining);
      else updatedRoutes.delete(key);
    }
    for (const pair of newPairs) {
      addRouteToNetwork(updatedRoutes, new Route(pair.locationAId, pair.locationBId, "Sea"));
    }
    setRoutes(updatedRoutes);
    primeRouteGraphCache();

    // 5. Fleet top-up: keep the ships-per-location ratio roughly constant.
    // Only real (multi-ship) Companies with a home Location that can host a
    // Ship are eligible -- a SoloTrader's homeLocation is always null (see
    // faction.ts), so it's naturally excluded without an extra check.
    const shipsBefore = this.captains.filter((c) => c.transport !== null).length;
    const locationsBefore = this.locations.length - 1;
    const shipsToAdd = locationsBefore > 0 ? Math.round(shipsBefore / locationsBefore) : 0;
    const probeShip = new Ship({ name: "_ProbeShip" });
    const eligibleCompanies: Company[] = [];
    for (const f of this.factions) {
      if (!(f instanceof Company) || f.homeLocation === null) continue;
      const home = getLocation(f.homeLocation);
      if (home !== undefined && locationSupportsTransport(home, probeShip)) eligibleCompanies.push(f);
    }
    if (eligibleCompanies.length > 0) {
      for (let i = 0; i < shipsToAdd; i++) {
        const target = eligibleCompanies[i % eligibleCompanies.length];
        const home = target.homeLocation!;
        const nationality = target.politicalEntity?.nationality ?? randomNationality(globalNameRng);
        const pools = NATIONALITY_POOLS[nationality];
        const ship = new Ship({ name: randomShipName(globalNameRng, pools.ships), crewRequirement: randInt(1, 5) });
        const captain = new Captain({ ...randomCaptainPersonFields(pools.names), homeLocation: getLocation(home)! });
        target.addTransport(ship, captain, home, 0);
        this.captains.push(captain);
      }
    }

    return location;
  }

  private allMarkets(): Market[] {
    return [...this.buyMarkets.values(), ...this.sellMarkets.values()];
  }

  isLocationOpen(locationName: string): boolean {
    return !this.closedLocations.has(locationName);
  }

  private commoditiesPresent(): string[] {
    const seen: string[] = [];
    for (const location of this.locations) {
      for (const c of [...Object.keys(location.producedCommodities), ...Object.keys(location.consumedCommodities)]) {
        if (!seen.includes(c)) seen.push(c);
      }
    }
    return seen;
  }

  private tickBroadEvents(): void {
    this.activeBroadEvents = this.activeBroadEvents.filter((entry) => entry.event.tick());
  }

  /**
   * Every currently active Global/Location-wide/Worldwide MarketEvent and
   * per-Captain TransportEvent (only the two discount kinds persist over
   * multiple days), sorted oldest-first.
   */
  activeNamedEvents(): NamedEvent[] {
    const result: NamedEvent[] = this.activeBroadEvents.map((entry) => ({
      scope: entry.scope,
      subject: entry.subject,
      name: entry.event.name,
      startDay: entry.startDay,
      daysRemaining: entry.event.daysRemaining,
      durationDays: entry.event.durationDays,
    }));
    for (const captain of this.captains) {
      for (const event of captain.activeAgentEvents) {
        result.push({
          scope: "Agent",
          subject: captain.name,
          name: event.name,
          startDay: event.startedDay,
          daysRemaining: event.daysRemaining,
          durationDays: event.durationDays,
        });
      }
    }
    result.sort((a, b) => (a.startDay ?? 0) - (b.startDay ?? 0));
    return result;
  }

  private tickLocationClosures(): string[] {
    const reopened: string[] = [];
    for (const locationName of [...this.closedLocations.keys()]) {
      if (!this.closedLocations.get(locationName)!.tick()) {
        this.closedLocations.delete(locationName);
        reopened.push(locationName);
      }
    }
    return reopened;
  }

  run(numDays: number): MarketRecord[] {
    const commoditiesPresent = this.commoditiesPresent();
    for (let day = 1; day <= numDays; day++) {
      this.runDay(day, commoditiesPresent);
    }
    return this.combinedHistory;
  }

  /** Advance the simulation by exactly one day, tracking its own day counter across calls. */
  step(): number {
    const commoditiesPresent = this.commoditiesPresent();
    this.runDay(this.nextDay, commoditiesPresent);
    this.nextDay += 1;
    return this.nextDay - 1;
  }

  private runDay(day: number, commoditiesPresent: string[]): void {
    // Contracts are pruned/tendered at the very start of the day, before any
    // Faction acts, against yesterday's closing stockpile levels -- so
    // Factions see today's fresh offers (and never a stale/expired one).
    this.bulletinBoard.prune(this.locations, day);
    // A Location must not re-tender for a pair some ContractFulfiller has
    // already accepted (even though it's no longer on the board) -- so the
    // dedup key set spans both the board and every fulfiller's own list,
    // excluding contracts fulfilled or cancelled (its in-flight cargo was
    // seized by pirates -- see PirateBrigade.attack) since a fulfiller only
    // prunes those lazily inside its own next directFleet call (after this
    // loop).
    const activeContractKeys = new Set<string>([
      ...this.bulletinBoard.open.map((c) => contractKey(c.location, c.commodity)),
      ...this.factions
        .flatMap((f) => (f instanceof ContractFulfiller ? f.contracts.filter((c) => !c.fulfilled && !c.cancelled) : []))
        .map((c) => contractKey(c.location, c.commodity)),
    ]);
    for (const location of this.locations) {
      const pirateCount = this.pirateCountsByLocation.get(location.name) ?? 0;
      location.tenderContracts(day, this.bulletinBoard, activeContractKeys, this.contractOptions, pirateCount);
    }

    // Location closures resolve before anyone acts today. No new closures or
    // Company/Market/Transport events are ever randomly rolled -- events are
    // disabled -- but already-active ones (from a loaded scenario) still tick.
    this.tickLocationClosures();
    this.tickBroadEvents();

    // Traders act first, against the previous day's closing prices.
    const closedLocations = new Set(this.closedLocations.keys());
    const directedRoutes = new Map<Captain, Directive>();
    for (const faction of this.factions) {
      const directives = faction.directFleet(
        day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations, this.bulletinBoard,
        this.pirateCountsByLocation,
      );
      for (const [captain, directive] of directives) directedRoutes.set(captain, directive);
    }

    const todaysOrder = this.agentOrderFn(this.captains, day);
    for (const trader of todaysOrder) {
      trader.act(
        day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations,
        directedRoutes.get(trader) ?? null, this.pirateBrigade,
      );
      for (const e of trader.eventLog) {
        if (e.day === day) this.eventLog.push(e);
      }
    }

    // Production/consumption keep happening regardless of whether the port
    // can currently load or unload anyone -- only actual trading is
    // blocked by a closure.
    for (const location of this.locations) location.dailyUpdate();

    // Pirates currently sitting AtLocation make it cheaper to buy and more
    // profitable to sell there (see Market.pirateMultiplier), and richer
    // delivery fees on any Contract tendered there tomorrow (see
    // Location.tenderContracts) -- recomputed once per day, off end-of-day
    // positions (after every Faction/Captain has acted), the same timing
    // Market events already use. Persisted on the instance (rather than a
    // local var) so tomorrow's tenderContracts pass, which runs before
    // anyone's had a chance to move, can still read today's picture.
    this.pirateCountsByLocation = new Map();
    if (this.pirateBrigade !== null) {
      for (const captain of this.pirateBrigade.captains) {
        if (captain.status !== "AtLocation") continue;
        this.pirateCountsByLocation.set(
          captain.locationName, (this.pirateCountsByLocation.get(captain.locationName) ?? 0) + 1,
        );
      }
    }

    for (const market of this.allMarkets()) {
      const record = market.simulateDay(day, this.isLocationOpen(market.locationName), this.pirateCountsByLocation.get(market.locationName) ?? 0);
      this.combinedHistory.push(record);
      if (market.lastTriggeredEvent !== null) this.eventLog.push(market.lastTriggeredEvent);
    }

    for (const trader of this.captains) trader.recordPortfolioSnapshot(day, this.sellMarkets);
    for (const faction of this.factions) faction.recordNetWorthSnapshot(day, this.sellMarkets);
  }
}
