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
import { Ship, SHIP_CLASSES, type Transport } from "./transport";
import { Captain, isRepairDirective, isRepositionDirective, isTradeDirective, type Directive } from "./captain";
import type { Leader } from "./tradingAgent";
import { ENGLISH_NAMES, SPANISH_NAMES, randomPersonName, type Gender, type NamePool, type NameRng } from "./names";
import { ENGLISH_SHIP_NAMES, SPANISH_SHIP_NAMES, randomShipName } from "./shipNames";
import { randomLocationName } from "./locationNames";
import { NATIONALITY_POOLS, randomNationality, type Nationality } from "./nationality";
import { FleetOwner, Company, SoloTrader, ContractFulfiller, PirateBrigade, PoliceFleet, ExpeditionParty } from "./faction";
import type { Explorer } from "./explorer";
import type { PendingDecision } from "./decisions";
import { generateSailorPool, addToSailorPool, tickPoolPiracy, isSeaCapable } from "./sailorPool";
import { locationSupportsTransport } from "./companyHome";
import type { PoliticalEntity } from "./politicalEntity";
import { primeRouteGraphCache } from "./pathfinding";
import { randChoice, randInt, randRandom, randShuffle, seedSimRandom, randSample, randUniform } from "./simRandom";
import { randomBirthDate, type Person } from "./person";
import {
  SAILOR_MIN_AGE, SAILOR_MAX_AGE, PIRACY_INCREASE_PER_DAY, PIRACY_DECAY_PER_DAY, SHORE_LEAVE_PROBABILITY,
} from "./sailor";
import {
  LOCATIONS, LOCATION_COORDINATES, COMMODITIES, setGeography, getLocation, getDistanceConfig, FUEL_BASE_PRICE,
  setWorldStartDate, getWorldStartDate,
} from "./worldData";
import { Route, ROUTES, setRoutes, addRouteToNetwork, routeKey } from "./routes";
import {
  planSeaRoutes, seaRoutesBlockedBy, DEFAULT_START_DATE, type RoutePlannerLocation, type RoutePlannerRoute,
} from "@market-sim/shared";

/** Adapts the global sim RNG to the NameRng surface randomPersonName needs, so pirate/police captains draw names off the same live stream as the rest of the simulation. */
const globalNameRng: NameRng = { random: randRandom, choice: randChoice };
import { BulletinBoard, contractKey, type Contract, type TenderContractsOptions } from "./contracts";

/** A freshly rolled name/gender (from `pool`, tagged with `nationality` for display) plus a plausible birth date -- the Person fields every new Captain constructed directly in this file (pirate/police fleets, addPirateShip/addPoliceShip, addLocation's fleet top-up) needs alongside its homeLocation. */
function randomCaptainPersonFields(
  pool: NamePool,
  nationality: Nationality,
): { name: string; gender: Gender; nationality: Nationality; dateOfBirth: Date } {
  const { name, gender } = randomPersonName(globalNameRng, pool);
  const dateOfBirth = randomBirthDate(globalNameRng.random, SAILOR_MIN_AGE, SAILOR_MAX_AGE);
  return { name, gender, nationality, dateOfBirth };
}
import { round2, clamp01 } from "./utils";
import { WeatherSystem } from "./weather";
import { StormSystem } from "./storms";
import { trimHistory } from "./historyRetention";

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
  factions?: FleetOwner[];
  agentOrderFn?: AgentOrderFn;
  numPoliceShips?: number;
  /** Ship count for the single World-built PirateBrigade -- see numPoliceShips for the analogous Coast Guard knob. Default 0 (no pirates). */
  numPirateShips?: number;
  /** Starting cash for the whole PirateBrigade (split evenly across its captains -- PirateBrigade.poolsCash is false, see FleetOwner's constructor). Default 0. */
  pirateStartingCash?: number;
  /** Overrides for Location.tenderContracts' tunable knobs (expiry, fee curve, quantity multiplier) -- defaults to contracts.ts's module constants if omitted. */
  contractOptions?: TenderContractsOptions;
  /** The in-world date/time of day 1, as an ISO 8601 string -- see startDate/currentDate. Default DEFAULT_START_DATE. */
  startDate?: string;
  /** A standalone weather field bounded to this World's map -- see weather.ts. Null (default) for a World with no bounds to query weather against, e.g. a JSON world that predates this field. */
  weather?: WeatherSystem | null;
  /** Discrete storm/cyclone entities driven by `weather` -- see storms.ts. Null (default) if this World has no WeatherSystem to drive them (StormSystem needs one; the two are always constructed together). */
  storms?: StormSystem | null;
  /** Exploration-mode expedition parties (see faction.ts's ExpeditionParty, explorer.ts) -- empty by default, fully independent of the shipCaptains/factions/locations loops below. */
  expeditionParties?: ExpeditionParty[];
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
  factions: FleetOwner[];
  pirateBrigade: PirateBrigade | null;
  policeFleet: PoliceFleet | null;
  /** Every Captain currently crewing a Ship in this World -- see the public `leaders` getter for the unified Captain+Explorer view (both satisfy tradingAgent.ts's `Leader`). Kept as its own field (not derived) since it's mutated directly by ship purchases/sinkings/replacements throughout this class. */
  shipCaptains: Captain[];
  agentOrderFn: AgentOrderFn;
  bulletinBoard = new BulletinBoard();
  contractOptions: TenderContractsOptions;
  weather: WeatherSystem | null;
  storms: StormSystem | null;
  /** Exploration-mode expedition parties -- see faction.ts's ExpeditionParty. Ticked once per day in runDay, fully independent of the shipCaptains/factions/locations loops. */
  expeditionParties: ExpeditionParty[];

  /** Read-only convenience view of `expeditionParties`' Explorers -- every existing consumer (ExplorerPanel, decisions.ts, buildWorldFromJson) just wants the Explorer, not the ExpeditionParty wrapper managing it. */
  get explorers(): Explorer[] {
    return this.expeditionParties.map((party) => party.explorer);
  }

  /** Every Leader in this World -- every Captain crewing a Ship plus every Explorer leading an expedition, regardless of which kind of Faction owns it. Computed fresh each access (not stored) since `shipCaptains` and `explorers` are each already the live source of truth. */
  get leaders(): Leader[] {
    return [...this.shipCaptains, ...this.explorers];
  }
  /**
   * A decision the player must resolve before the simulation can advance
   * any further -- set by Explorer.arrive() on arrival at a Village (see
   * decisions.ts's buildPassageTaxDecision) or by the UI's "Choose next leg"
   * action (buildLegChoiceDecision). While non-null, runDay refuses to do
   * anything at all (see its very first statement) -- companies, other
   * captains, weather, everything pauses, not just the expedition. Cleared
   * by whatever resolves the Choice (see useSimStore.resolveDecision).
   */
  pendingDecision: PendingDecision | null = null;
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
    this.weather = init.weather ?? null;
    this.storms = init.storms ?? null;

    this.factions = init.factions ? [...init.factions] : [];

    // Pirates/police only ever base out of a Port or Platform, same as any
    // other Ship -- see isSeaCapable. Computed once, shared by both blocks
    // below (and by addPirateShip/addPoliceShip later).
    const seaCapableLocations = init.locations.filter(isSeaCapable);

    // A single World-wide PirateBrigade, built the same way as the Coast
    // Guard PoliceFleet below (random home ports, one flat ship count) --
    // must run BEFORE the PoliceFleet block so its `this.factions.filter(f
    // => f instanceof PirateBrigade)` target lookup actually finds it. A
    // World with no sea-capable Location at all (e.g. a hand-authored
    // land-only exploration-mode world) simply gets none -- silently
    // treated the same as numPirateShips being 0, not a hard error, since
    // this World is still perfectly valid without any Ships in it at all.
    const numPirateShips = seaCapableLocations.length > 0 ? (init.numPirateShips ?? 0) : 0;
    this.pirateShipStartingCash = numPirateShips > 0 ? (init.pirateStartingCash ?? 0) / numPirateShips : (init.pirateStartingCash ?? 0);
    if (numPirateShips > 0) {
      const pirateCrew: Array<[Ship, Captain, string]> = [];
      for (let i = 0; i < numPirateShips; i++) {
        const homeLocation = randChoice(seaCapableLocations);
        const ship = new Ship({ name: randomShipName(globalNameRng, SPANISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
        const captain = new Captain({ ...randomCaptainPersonFields(SPANISH_NAMES, "Spanish"), homeLocation });
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

    // Same graceful skip as numPirateShips above -- no sea-capable Location
    // means no Coast Guard, not a hard error.
    const numPoliceShips = seaCapableLocations.length > 0 ? (init.numPoliceShips ?? 3) : 0;
    if (numPoliceShips > 0) {
      const policeCrew: Array<[Ship, Captain, string]> = [];
      for (let i = 0; i < numPoliceShips; i++) {
        const homeLocation = randChoice(seaCapableLocations);
        const ship = new Ship({ name: randomShipName(globalNameRng, ENGLISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
        const captain = new Captain({ ...randomCaptainPersonFields(ENGLISH_NAMES, "English"), homeLocation });
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

    // Every initial FleetOwner (Company/SoloTrader from init.factions, plus the
    // PirateBrigade/PoliceFleet just built above) has registered its
    // Transports but only seated its Captains so far -- crewFleet() (which
    // fills the remaining seats from the Sailor pool) hasn't run yet, so the
    // pool can be sized off every FleetOwner's true demand before any of them
    // draw from it. See sailorPool.generateSailorPool / FleetOwner.crewFleet.
    generateSailorPool(this.factions);
    for (const faction of this.factions) faction.crewFleet();

    this.shipCaptains = [...(init.traders ?? []), ...this.factions.flatMap((f) => f.captains)];
    this.agentOrderFn = init.agentOrderFn ?? randomAgentOrder;
    this.expeditionParties = init.expeditionParties ?? [];

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
   * cash as the initial fleet (see pirateShipStartingCash). Returns null,
   * a no-op, if this World has no sea-capable (Port/Platform) Location at
   * all for it to be based out of.
   */
  addPirateShip(): Captain | null {
    const seaCapableLocations = this.locations.filter(isSeaCapable);
    if (seaCapableLocations.length === 0) return null;
    if (this.pirateBrigade === null) {
      this.pirateBrigade = new PirateBrigade(
        "Pirate Brigade",
        [],
        this.factions.filter((f): f is Company => f instanceof Company),
      );
      this.factions.push(this.pirateBrigade);
      if (this.policeFleet !== null) this.policeFleet.targets.push(this.pirateBrigade);
    }
    const homeLocationObj = randChoice(seaCapableLocations);
    const ship = new Ship({ name: randomShipName(globalNameRng, SPANISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
    const captain = new Captain({ ...randomCaptainPersonFields(SPANISH_NAMES, "Spanish"), homeLocation: homeLocationObj });
    this.pirateBrigade.addTransport(ship, captain, homeLocationObj.name, this.pirateShipStartingCash);
    this.shipCaptains.push(captain);
    return captain;
  }

  /** Removes a random Ship/Captain from the PirateBrigade. Returns the removed Captain, or null if there is no PirateBrigade (or it's already empty). */
  removePirateShip(): Captain | null {
    if (this.pirateBrigade === null || this.pirateBrigade.captains.length === 0) return null;
    const captain = randChoice(this.pirateBrigade.captains);
    this.pirateBrigade.removeTransport(captain);
    const idx = this.shipCaptains.indexOf(captain);
    if (idx !== -1) this.shipCaptains.splice(idx, 1);
    return captain;
  }

  /** Recruits a new Coast Guard Ship/Captain at a random Location -- lazily creating the PoliceFleet if numPoliceShips was 0 at construction. Mirrors addPirateShip, including returning null (a no-op) if this World has no sea-capable Location at all. */
  addPoliceShip(): Captain | null {
    const seaCapableLocations = this.locations.filter(isSeaCapable);
    if (seaCapableLocations.length === 0) return null;
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
    const homeLocationObj = randChoice(seaCapableLocations);
    const ship = new Ship({ name: randomShipName(globalNameRng, ENGLISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
    const captain = new Captain({ ...randomCaptainPersonFields(ENGLISH_NAMES, "English"), homeLocation: homeLocationObj });
    this.policeFleet.addTransport(ship, captain, homeLocationObj.name);
    this.shipCaptains.push(captain);
    return captain;
  }

  /** Removes a random Ship/Captain from the PoliceFleet. Returns the removed Captain, or null if there is no PoliceFleet (or it's already empty). */
  removePoliceShip(): Captain | null {
    if (this.policeFleet === null || this.policeFleet.captains.length === 0) return null;
    const captain = randChoice(this.policeFleet.captains);
    this.policeFleet.removeTransport(captain);
    const idx = this.shipCaptains.indexOf(captain);
    if (idx !== -1) this.shipCaptains.splice(idx, 1);
    return captain;
  }

  /**
   * Manual "Buy Ship" action (see BuyShipPanel) -- a Company spends its own
   * funds on a brand-new Ship of `shipClassName` (a SHIP_CLASSES key),
   * starting at `locationName` (validated as Port/Platform-compatible by
   * Company.buyShipAt, which also places the ship there instead of the
   * Company's fixed homeLocation). The new Captain draws its name/ship name
   * from the Company's own politicalEntity nationality, same as addLocation's
   * fleet top-up. Crew fills for free from that Location's Sailor pool (see
   * FleetOwner.addTransport/fillExtraSeats) -- only the hull itself costs cash.
   * Throws if shipClassName is unknown, the Company can't afford it, or the
   * Location doesn't exist/support a Ship. Not available for a SoloTrader
   * (its own ship replacement is automatic -- see the private
   * buySoloTraderReplacement, triggered by Captain.act's condition-decay
   * check/PirateBrigade.attack, never this manual entry point).
   */
  buyShipForCompany(company: Company, locationName: string, shipClassName: string): Captain {
    if (company instanceof SoloTrader) {
      throw new Error(`'${company.name}' is a SoloTrader -- capped at one Ship, and its replacement is automatic, not a manual purchase.`);
    }
    const shipClass = SHIP_CLASSES[shipClassName];
    if (shipClass === undefined) {
      throw new Error(`Unknown ship class '${shipClassName}'.`);
    }
    if (company.cash < shipClass.purchasePrice) {
      throw new Error(
        `'${company.name}' cannot afford a ${shipClassName} ($${shipClass.purchasePrice.toLocaleString()}, has $${company.cash.toLocaleString()}).`,
      );
    }
    const location = getLocation(locationName);
    if (location === undefined) {
      throw new Error(`Location '${locationName}' does not exist.`);
    }

    company.cash -= shipClass.purchasePrice;
    const day = this.currentSimDay();
    const captain = this.acquireShip(company, location, shipClass, false, day);
    // A manual purchase happens between days (the UI action isn't part of
    // any runDay call), so no later end-of-day recordShipLog pass is coming
    // for `day` to consume the newShipDay flag acquireShip just set -- write
    // this Captain's first Ship's Log entry right now instead.
    captain.recordShipLog(day);
    return captain;
  }

  /** "The day something happened," for a manual UI action taken between simulated days (not itself inside a runDay call) -- the last day that actually finished running, or day 1 if none has yet. See buyShipForCompany, its only caller. */
  private currentSimDay(): number {
    return Math.max(1, this.nextDay - 1);
  }

  /**
   * Picks the Captain for a freshly bought Ship (manual Company purchase,
   * the SoloTrader auto-replacement, or the PoliceFleet auto-replacement):
   * if an inactive Captain (see FleetOwner.inactiveCaptains/sinkInPort) is
   * sitting right at `location`, they become the new Captain -- longest-
   * benched first -- instead of generating a fresh one, per the grilled
   * spec. Otherwise generates a new Captain from `nationality`'s name pool,
   * same as addLocation's fleet top-up. `FleetOwner`-typed (not `Company`) so
   * PoliceFleet -- which doesn't extend Company -- can use this too.
   */
  private captainForNewShip(faction: FleetOwner, location: Location, nationality: Nationality): Captain {
    const idx = faction.inactiveCaptains.findIndex((c) => c.location?.name === location.name);
    if (idx !== -1) return faction.inactiveCaptains.splice(idx, 1)[0];
    const pools = NATIONALITY_POOLS[nationality];
    return new Captain({ ...randomCaptainPersonFields(pools.names, nationality), homeLocation: location });
  }

  /**
   * Shared by buyShipForCompany (manual, always crews for free), the
   * SoloTrader auto-replacement, and the PoliceFleet auto-replacement
   * (`noCrew`, per the grilled spec -- the new Ship starts with nobody but
   * its Captain aboard, for both). Registers the new Captain in
   * `this.shipCaptains` either way (a reused inactive Captain was removed from
   * it when benched -- see sinkInPort -- so it always needs re-adding, same
   * as a brand new one). `FleetOwner`-typed (not `Company`) so PoliceFleet can
   * use this too -- see FleetOwner.buyShipAt for how a FleetOwner with no
   * home-location-forcing `addTransport` override (PirateBrigade/
   * PoliceFleet) still places the Ship at exactly `location`.
   */
  private acquireShip(faction: FleetOwner, location: Location, shipClass: Ship, noCrew: boolean, day: number): Captain {
    const nationality = faction.politicalEntity?.nationality ?? randomNationality(globalNameRng);
    const ship = shipClass.clone({ name: randomShipName(globalNameRng, NATIONALITY_POOLS[nationality].ships) });
    const captain = this.captainForNewShip(faction, location, nationality);

    faction.buyShipAt(ship, captain, location.name);
    if (noCrew) {
      for (const member of [...ship.crew]) {
        if (member === captain) continue;
        ship.removeCrewMember(member);
        member.disembarkAt(location);
        addToSailorPool(location.name, member);
      }
    }
    this.shipCaptains.push(captain);
    // Consumed by this Captain's own recordShipLog -- either later THIS SAME
    // day (an automatic replacement, called from inside runDay's per-captain
    // loop) or immediately by the caller (a manual purchase -- see
    // buyShipForCompany, the only caller not itself inside runDay).
    captain.newShipDay = day;
    return captain;
  }

  /**
   * Triggered immediately (same day, same turn) when a SoloTrader's Captain
   * survives its Ship sinking in port (see World.runDay's post-act() check,
   * the only caller). Tries the cheapest SHIP_CLASSES entry, at the
   * sinking's own Location, with no crew -- per the grilled spec, this is
   * NOT a manual purchase (buyShipForCompany refuses a SoloTrader outright)
   * and doesn't check `targetShipsPerLocation` or any other gate, just raw
   * affordability. `captain` is already sitting in `soloTrader.
   * inactiveCaptains` (pushed there by sinkInPort) and at `captain.location`
   * -- acquireShip's own captainForNewShip lookup will find and reuse this
   * SAME Captain (a SoloTrader only ever has one). If even the cheapest
   * Ship is unaffordable, the SoloTrader is dissolved outright instead.
   *
   * NOTE: sinkInPort (the only caller's caller) already zeroes `captain`'s
   * own cash as part of the sinking itself (see Company.loseCargoAndCash --
   * "no cash survives a sinking" applies here too, deliberately, per the
   * grilled spec). That means the affordability check below is, under
   * today's SHIP_CLASSES prices, effectively unreachable -- a freshly-sunk
   * SoloTrader Captain always has $0 the instant this runs, so dissolution
   * is the only outcome that ever actually fires in practice. This is
   * intentional, not a bug: the branch stays here, correctly implemented,
   * for whatever future mechanic might leave a survivor with cash (a $0
   * Ship class, a windfall between sinking and this check, etc.).
   */
  private buySoloTraderReplacementIfPossible(soloTrader: SoloTrader, captain: Captain, day: number): void {
    const cheapest = Object.values(SHIP_CLASSES).reduce((a, b) => (a.purchasePrice <= b.purchasePrice ? a : b));
    const location = captain.location;
    // SoloTrader.poolsCash is false -- its real money lives on the
    // Captain's OWN balance (captain.cash resolves to captain.ownCash),
    // never on the FleetOwner-level `cash` field a pooling Company would use.
    if (location !== null && captain.cash >= cheapest.purchasePrice) {
      captain.cash -= cheapest.purchasePrice;
      this.acquireShip(soloTrader, location, cheapest, true, day);
    } else {
      this.dissolveSoloTrader(soloTrader, captain);
    }
  }

  /**
   * A SoloTrader whose Captain survived a sinking but can't afford even the
   * cheapest replacement Ship (see buySoloTraderReplacementIfPossible) is
   * dissolved outright -- removed from `this.factions` entirely (nothing
   * else currently does this to a FleetOwner mid-simulation). All cash is
   * lost -- zeroed on `captain` directly (SoloTrader.poolsCash is false, so
   * that's where its real money lives, not the unused FleetOwner-level `cash`
   * field), not returned anywhere. The Captain disappears for good --
   * already out of `this.shipCaptains` (see World.runDay) and now dropped from
   * `inactiveCaptains` too, so nothing references it anymore.
   */
  private dissolveSoloTrader(soloTrader: SoloTrader, captain: Captain): void {
    const idx = this.factions.indexOf(soloTrader);
    if (idx !== -1) this.factions.splice(idx, 1);
    soloTrader.inactiveCaptains = [];
    captain.cash = 0.0;
  }

  /**
   * Triggered immediately (same day, same turn) whenever a Police Ship
   * sinks -- UNCONDITIONALLY, unlike the SoloTrader case, which only fires
   * if the Captain survived. Buys the cheapest SHIP_CLASSES entry, at the
   * sinking's own Location, with no crew -- same purchase mechanics as the
   * SoloTrader auto-replacement, just always taken. `captain` is either
   * still around (benched in `policeFleet.inactiveCaptains`, sunk in port --
   * acquireShip's captainForNewShip lookup reuses it) or already fully
   * discarded (dead, sunk at sea -- a fresh Captain is generated instead);
   * either way `captain.location` is set (see FleetOwner.sinkAtSea, which
   * disembarks even a fatally-lost Captain purely so this has somewhere to
   * spawn the replacement). No affordability check or dissolution fallback
   * -- PoliceFleet is hardcoded to Infinity cash (see its constructor), so
   * this always succeeds.
   */
  private buyPoliceReplacementImmediately(policeFleet: PoliceFleet, captain: Captain, day: number): void {
    const location = captain.location;
    if (location === null) return; // defensive; should always be set per sinkAtSea/sinkInPort
    const cheapest = Object.values(SHIP_CLASSES).reduce((a, b) => (a.purchasePrice <= b.purchasePrice ? a : b));
    policeFleet.cash -= cheapest.purchasePrice;
    this.acquireShip(policeFleet, location, cheapest, true, day);
  }

  /**
   * The `SHIP_CLASSES` entry that best matches `sunk` -- exact on
   * `cargoCapacity` (unique per class, and every real in-game Ship is a
   * direct `shipClass.clone()`, see `buildWorld`/`acquireShip`, so this is
   * an exact hit in practice), falling back to the closest `cargoCapacity`
   * for a Ship that never came from a preset at all (a hand-authored World
   * editor Ship with bespoke stats). Always returns something, since
   * `SHIP_CLASSES` is never empty.
   */
  private matchingShipClass(sunk: Transport): Ship {
    const classes = Object.values(SHIP_CLASSES);
    const exact = classes.find((c) => c.cargoCapacity === sunk.cargoCapacity);
    if (exact !== undefined) return exact;
    return classes.reduce((a, b) =>
      Math.abs(a.cargoCapacity - sunk.cargoCapacity) <= Math.abs(b.cargoCapacity - sunk.cargoCapacity) ? a : b,
    );
  }

  /**
   * `target`, or the next cheapest `SHIP_CLASSES` entry the Company can
   * actually afford -- never a class MORE expensive than `target` (this
   * never "upgrades" past what was lost). Null if even the cheapest class
   * in the whole roster is unaffordable.
   */
  private affordableShipClass(company: Company, target: Ship): Ship | null {
    const cheaperOrEqual = Object.values(SHIP_CLASSES)
      .filter((c) => c.purchasePrice <= target.purchasePrice)
      .sort((a, b) => b.purchasePrice - a.purchasePrice);
    return cheaperOrEqual.find((c) => company.cash >= c.purchasePrice) ?? null;
  }

  /**
   * Triggered immediately (same day, same turn) whenever a plain (non-
   * SoloTrader) Company's Ship sinks -- UNCONDITIONALLY, whether `captain`
   * survived (benched in `company.inactiveCaptains`, sunk in port) or died
   * (sunk at sea) -- see World.runDay's post-act() check, the only caller.
   * Location depends on which: sunk IN PORT buys the replacement right
   * there (`captain.location`, exactly like SoloTrader/PoliceFleet); sunk AT
   * SEA (no dock to buy at) instead falls back to the Company's own
   * `homeLocation` -- unlike SoloTrader/PoliceFleet, a plain Company always
   * has one. Tries to match the sunk Ship's own class first
   * (`matchingShipClass`, off `captain.lastTransport` -- see its doc comment
   * for why `captain.transport` itself is already null here), falling back
   * to progressively cheaper classes if the Company can't afford it
   * (`affordableShipClass`); does nothing at all if even the cheapest class
   * is unaffordable, or if there's nowhere to buy it (a homeLocation-less
   * Company -- shouldn't happen for a real multi-ship Company, but the type
   * allows it). Crews normally (unlike SoloTrader/PoliceFleet's deliberate
   * `noCrew`), matching the manual "Buy Ship" UI action's own behavior --
   * see `buyShipForCompany`. `captainForNewShip` (inside `acquireShip`)
   * already implements "reuse the longest-benched inactive Captain at this
   * Location, else generate a new one," so no separate logic is needed here
   * for that part.
   */
  private buyCompanyReplacementIfPossible(company: Company, captain: Captain, day: number): void {
    const sunkTransport = captain.lastTransport;
    if (sunkTransport === null) return; // defensive; always set by sinkAtSea/sinkInPort
    const sunkInPort = company.inactiveCaptains.includes(captain);
    const locationName = sunkInPort ? captain.location?.name ?? null : company.homeLocation;
    if (locationName === null) return;
    const location = getLocation(locationName);
    if (location === undefined) return;

    const target = this.matchingShipClass(sunkTransport);
    const shipClass = this.affordableShipClass(company, target);
    if (shipClass === null) return;

    company.cash -= shipClass.purchasePrice;
    this.acquireShip(company, location, shipClass, false, day);
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
    const shipsBefore = this.shipCaptains.filter((c) => c.transport !== null).length;
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
        const captain = new Captain({ ...randomCaptainPersonFields(pools.names, nationality), homeLocation: getLocation(home)! });
        target.addTransport(ship, captain, home, 0);
        this.shipCaptains.push(captain);
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
    for (const captain of this.shipCaptains) {
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

  /**
   * Advance the simulation by exactly one day, tracking its own day counter
   * across calls. A no-op while pendingDecision is set -- doesn't advance
   * nextDay/currentDate either, not just runDay's own internal work,
   * matching "the day counter is frozen" while a decision is pending (see
   * pendingDecision's own doc comment). Returns the last-completed day
   * number unchanged in that case (0 if no day has ever completed yet).
   */
  step(): number {
    if (this.pendingDecision !== null) return this.nextDay - 1;
    const commoditiesPresent = this.commoditiesPresent();
    this.runDay(this.nextDay, commoditiesPresent);
    this.nextDay += 1;
    return this.nextDay - 1;
  }

  private runDay(day: number, commoditiesPresent: string[]): void {
    // A pending exploration decision pauses EVERYTHING -- the whole day is a
    // no-op (companies, other captains, weather, all of it) until the
    // player resolves it. Must be the very first check, before anything
    // else in this method runs. See pendingDecision's own doc comment.
    if (this.pendingDecision !== null) return;

    // Contracts are pruned/tendered at the very start of the day, before any
    // FleetOwner acts, against yesterday's closing stockpile levels -- so
    // FleetOwners see today's fresh offers (and never a stale/expired one).
    this.bulletinBoard.prune(this.locations, day);
    // A Location must not re-tender for a pair some ContractFulfiller has
    // already accepted (even though it's no longer on the board) -- so the
    // dedup key set spans both the board and every fulfiller's own list,
    // excluding contracts fulfilled or cancelled (its in-flight cargo was
    // seized by pirates -- see PirateBrigade.attack) since a fulfiller only
    // prunes those lazily inside its own next direct call (after this
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

    // Storms/cyclones (see storms.ts) move/intensify/spawn/dissipate before
    // any Captain acts today, so a departure this turn sees today's actual
    // storm positions, not yesterday's stale ones. Needs `weather` to drive
    // spawn odds/movement/cyclone formation -- the two are always
    // constructed together (see buildWorld.ts/buildWorldFromJson.ts), so a
    // World with `storms` but no `weather` is not expected to occur.
    if (this.storms !== null && this.weather !== null) {
      this.storms.simulateDay(day, this.weather, getWorldStartDate());
    }

    const closedLocations = new Set(this.closedLocations.keys());

    // Formal day-order step 2 (see CLAUDE.md): crew hiring for every ship
    // ALREADY sitting in port -- a global pass over the whole fleet, before
    // any FleetOwner plans (step 3) or any Captain acts today, so direct's
    // route-economics see this crew, not yesterday's. A ship that instead
    // arrives (or finishes a crew rotation) today gets its hire folded into
    // its own act() call instead -- see Captain.act's justArrived handling.
    for (const captain of this.shipCaptains) {
      if (captain.status !== "AtLocation") continue;
      if (closedLocations.has(captain.locationName)) continue;
      if (captain.groundedDaysRemaining > 0) continue;
      captain.hireCrewIfPossible();
    }

    // Traders act first, against the previous day's closing prices.
    const directedRoutes = new Map<Person, Directive>();
    for (const faction of this.factions) {
      const directives = faction.direct(
        day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations, this.bulletinBoard,
        this.pirateCountsByLocation,
      );
      for (const [captain, directive] of directives) directedRoutes.set(captain, directive);
    }

    const todaysOrder = this.agentOrderFn(this.shipCaptains, day);
    for (const trader of todaysOrder) {
      trader.act(
        day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations,
        directedRoutes.get(trader) ?? null, this.pirateBrigade, this.weather, this.storms,
      );
      for (const e of trader.eventLog) {
        if (e.day === day) this.eventLog.push(e);
      }

      // A Ship sinking this turn (see FleetOwner.sinkAtSea/sinkInPort) leaves
      // its Captain transport-less -- either dead (at sea) or benched (in
      // port, pushed onto FleetOwner.inactiveCaptains). Either way it no
      // longer belongs in the daily loop's own captains list. A benched
      // SoloTrader Captain gets an immediate shot at a replacement Ship
      // (see buySoloTraderReplacementIfPossible) if it survived; a sunk
      // PoliceFleet or plain Company Ship gets one UNCONDITIONALLY, survived
      // or not (see buyPoliceReplacementImmediately/
      // buyCompanyReplacementIfPossible) -- only a PirateBrigade Captain
      // (dead or benched) leaves a permanent gap; it has no replacement
      // mechanism at all.
      if (trader.transport === null) {
        const idx = this.shipCaptains.indexOf(trader);
        if (idx !== -1) this.shipCaptains.splice(idx, 1);
        if (trader.company instanceof SoloTrader && trader.company.inactiveCaptains.includes(trader)) {
          this.buySoloTraderReplacementIfPossible(trader.company, trader, day);
        } else if (trader.company instanceof PoliceFleet) {
          this.buyPoliceReplacementImmediately(trader.company, trader, day);
        } else if (trader.company instanceof Company) {
          this.buyCompanyReplacementIfPossible(trader.company, trader, day);
        }
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
    // positions (after every FleetOwner/Captain has acted), the same timing
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
    // One trim per day (not per market) -- combinedHistory is day-ordered
    // across the whole batch just pushed above, so a single pass here is
    // equivalent to trimming after every push but far cheaper.
    trimHistory(this.combinedHistory, day);

    for (const trader of this.shipCaptains) trader.recordPortfolioSnapshot(day, this.sellMarkets);
    for (const faction of this.factions) faction.recordNetWorthSnapshot(day, this.sellMarkets);

    // Daily piracy tick (see Sailor.piracy/FleetOwner.hirePiracyThreshold): every
    // currently-crewing Sailor (including the Captain -- Captain extends
    // Sailor) rises if the Ship it's aboard belongs to a PirateBrigade, falls
    // otherwise; every pool Sailor (not aboard anything) falls too. A single
    // pass at the end of the day, once every Ship's crew is settled, rather
    // than folded into any one FleetOwner's own turn.
    for (const captain of this.shipCaptains) {
      if (captain.transport === null) continue;
      const delta = captain.company instanceof PirateBrigade ? PIRACY_INCREASE_PER_DAY : -PIRACY_DECAY_PER_DAY;
      for (const member of captain.transport.crew) member.piracy = clamp01(member.piracy + delta);
    }
    tickPoolPiracy();

    // Shore Leave -- the final act of the day (see World.runDay's own doc
    // comment on the formal day order): a single per-ship coin flip for
    // every Ship still docked tonight, skipping FleetOwners that don't grant it
    // (PoliceFleet -- see FleetOwner.grantsShoreLeave) and any Ship that spent
    // today repairing (see isRepairDirective/Company.direct's
    // partitionForRepair) -- a repairing crew never gets leave, roll or not.
    for (const captain of this.shipCaptains) {
      if (captain.status !== "AtLocation") continue;
      if (!captain.company?.grantsShoreLeave) continue;
      const directive = directedRoutes.get(captain);
      if (directive !== undefined && isRepairDirective(directive)) continue;
      if (randRandom() >= SHORE_LEAVE_PROBABILITY) continue;
      for (const member of captain.transport!.crew) {
        if (member === captain) continue;
        member.shoreLeave();
      }
      captain.shoreLeaveGrantedToday = day;
    }

    // Ship's Log -- the true final act of the day: one narrative entry per
    // Captain still around tonight, built off everything recorded above
    // (tradeLog/agentEventLog/the shore-leave flag just set) plus the
    // arrivedToday/repairedToday/newShipDay flags set earlier in today's
    // act()/acquireShip calls -- see Captain.recordShipLog. A Captain whose
    // Ship sank today isn't in `this.shipCaptains` any more by this point (see
    // the post-act() cleanup above), so it already got its own final entry
    // written directly by FleetOwner.sinkAtSea/sinkInPort instead.
    for (const captain of this.shipCaptains) captain.recordShipLog(day);

    // Exploration-mode expedition parties -- a fully independent pass, not
    // folded into the captains/factions loops above. Each party's own daily
    // cycle is a deliberate two-step guarantee, not an accident of this
    // loop's ordering: arrival ("evening") is handled entirely by tick()/
    // arrive() below -- the passage-tax talk with the Location's leader (if
    // any), "camp" is narrative only, no separate state -- and only THEN,
    // the following day ("morning"), does direct() restock/choose a new
    // route, since its own `destination === null` check can only pass once
    // tick() has already cleared today's arrival. A pending decision (a
    // player-controlled party only -- see Explorer.arrive) simply means the
    // NEXT runDay call (not this one) is the one that pauses.
    for (const party of this.expeditionParties) {
      if (party.aiControlled && party.explorer.destination === null) {
        const directives = party.direct(day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations);
        const directive = directives.get(party.explorer);
        if (directive !== undefined) {
          // isTradeDirective is unreachable via the default AI today (see
          // ExpeditionParty.direct) but kept -- executeTradeDirective still
          // exists and works, just isn't called by this default anymore.
          if (isTradeDirective(directive)) {
            party.explorer.executeTradeDirective(directive, day, this.buyMarkets, this.sellMarkets);
          } else if (isRepositionDirective(directive)) {
            party.explorer.departToward(directive.destination);
          }
        }
      }
      party.explorer.tick(day, this);
    }
  }
}
