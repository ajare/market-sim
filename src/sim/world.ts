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
import type { Location } from "./location";
import { Market, marketKey, type MarketRecord } from "./markets";
import { Ship } from "./transport";
import { Captain, type Directive } from "./captain";
import { ENGLISH_NAMES, SPANISH_NAMES, randomName, type NameRng } from "./names";
import { ENGLISH_SHIP_NAMES, SPANISH_SHIP_NAMES, randomShipName } from "./shipNames";
import { Faction, Company, ContractFulfiller, PirateBrigade, PoliceFleet } from "./faction";
import { primeRouteGraphCache } from "./pathfinding";
import { randChoice, randInt, randRandom, randShuffle, seedSimRandom } from "./simRandom";

/** Adapts the global sim RNG to the NameRng surface randomName needs, so pirate/police captains draw names off the same live stream as the rest of the simulation. */
const globalNameRng: NameRng = { random: randRandom, choice: randChoice };
import { BulletinBoard, contractKey, type Contract, type TenderContractsOptions } from "./contracts";

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
}

export class World {
  locations: Location[];
  globalEventProbability: number;
  locationEventProbability: number;
  worldwideEventProbability: number;
  locationClosureProbability: number;
  companyEventProbability: number;
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
        const homeLocation = randChoice(init.locations).name;
        const ship = new Ship({ name: randomShipName(globalNameRng, SPANISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
        const captainName = randomName(globalNameRng, SPANISH_NAMES);
        const captain = new Captain(captainName, homeLocation);
        pirateCrew.push([ship, captain, homeLocation]);
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
        const homeLocation = randChoice(init.locations).name;
        const ship = new Ship({ name: randomShipName(globalNameRng, ENGLISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
        const captainName = randomName(globalNameRng, ENGLISH_NAMES);
        const captain = new Captain(captainName, homeLocation);
        policeCrew.push([ship, captain, homeLocation]);
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
    const homeLocation = randChoice(this.locations).name;
    const ship = new Ship({ name: randomShipName(globalNameRng, SPANISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
    const captain = new Captain(randomName(globalNameRng, SPANISH_NAMES), homeLocation);
    this.pirateBrigade.addTransport(ship, captain, homeLocation, this.pirateShipStartingCash);
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
    const homeLocation = randChoice(this.locations).name;
    const ship = new Ship({ name: randomShipName(globalNameRng, ENGLISH_SHIP_NAMES), crewRequirement: randInt(1, 5) });
    const captain = new Captain(randomName(globalNameRng, ENGLISH_NAMES), homeLocation);
    this.policeFleet.addTransport(ship, captain, homeLocation);
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
        this.pirateCountsByLocation.set(captain.location, (this.pirateCountsByLocation.get(captain.location) ?? 0) + 1);
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
