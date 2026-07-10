/**
 * World: orchestrates every (location, commodity) market together --
 * scheduling events/closures, running the day loop. Ported from
 * sim/world.py, minus its console/CSV/matplotlib reporting methods
 * (build_daily_agent_log / build_location_daily_reports /
 * build_company_daily_reports / save_*_csv / plot_* / print_*) -- pure
 * data-shaping code with no new simulation logic, deferred to whichever
 * phase-2 panel first needs it.
 */
import { COMMODITIES } from "./worldData";
import {
  type Event, MarketEvent, LocationClosure, CompanyEvent,
  LOCATION_EVENT_TEMPLATES, WORLD_EVENT_TEMPLATES,
  LOCATION_CLOSURE_TEMPLATES, COMPANY_EVENT_TEMPLATES,
} from "./events";
import type { Location } from "./location";
import { Market, marketKey, type MarketRecord } from "./markets";
import { Ship } from "./transport";
import { Captain, type Directive } from "./captain";
import { ENGLISH_FIRST_NAMES, ENGLISH_LAST_NAMES } from "./names";
import { Faction, Company, ContractFulfiller, PirateBrigade, PoliceFleet } from "./faction";
import { primeRouteGraphCache } from "./pathfinding";
import { randRandom, randChoice, randInt, randShuffle, seedSimRandom } from "./simRandom";
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
  policeFleet: PoliceFleet | null;
  captains: Captain[];
  agentOrderFn: AgentOrderFn;
  bulletinBoard = new BulletinBoard();
  contractOptions: TenderContractsOptions;
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

    const numPoliceShips = init.numPoliceShips ?? 3;
    if (numPoliceShips > 0) {
      const policeCrew: Array<[Ship, Captain, string]> = [];
      for (let i = 0; i < numPoliceShips; i++) {
        const homeLocation = randChoice(init.locations).name;
        const ship = new Ship({ name: `Police Ship ${i + 1}`, crewRequirement: randInt(1, 5) });
        const captainName = `${randChoice(ENGLISH_FIRST_NAMES)} ${randChoice(ENGLISH_LAST_NAMES)}`;
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
        const basePrice = location.basePrices[commodity];
        const market = new Market(commodity, location.name, location, basePrice, basePrice, "buy", localEventProbability);
        this.buyMarkets.set(marketKey(location.name, commodity), market);
      }
      for (const commodity of Object.keys(location.consumedCommodities)) {
        const basePrice = location.basePrices[commodity];
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

  private maybeTriggerGlobalEvent(day: number): void {
    if (randRandom() >= this.globalEventProbability) return;
    const commodity = randChoice(this.commoditiesPresent());
    const commodityData = COMMODITIES[commodity];
    if (commodityData === undefined || commodityData.eventTemplates.length === 0) return;
    const template = randChoice(commodityData.eventTemplates);
    const affectedMarkets = this.allMarkets().filter((m) => m.commodityName === commodity);
    if (affectedMarkets.length === 0) return;
    for (const market of affectedMarkets) {
      market.applyEvent(new MarketEvent({ ...template, location: null, commodity }));
    }
    const trackingEvent = new MarketEvent({ ...template, location: null, commodity });
    trackingEvent.day = day;
    trackingEvent.type = "Global";
    this.eventLog.push(trackingEvent);
    this.activeBroadEvents.push({ scope: "Global", subject: commodity, startDay: day, event: trackingEvent });
    this.broadEventLog.push({ scope: "Global", subject: commodity, name: template.name, startDay: day, durationDays: template.durationDays });
  }

  private maybeTriggerLocationEvent(day: number): void {
    if (randRandom() >= this.locationEventProbability) return;
    const location = randChoice(this.locations).name;
    const template = randChoice(LOCATION_EVENT_TEMPLATES);
    const affectedMarkets = this.allMarkets().filter((m) => m.locationName === location);
    if (affectedMarkets.length === 0) return;
    for (const market of affectedMarkets) {
      market.applyEvent(new MarketEvent({ ...template, location }));
    }
    const trackingEvent = new MarketEvent({ ...template, location });
    trackingEvent.day = day;
    trackingEvent.type = "Location";
    this.eventLog.push(trackingEvent);
    this.activeBroadEvents.push({ scope: "Location", subject: location, startDay: day, event: trackingEvent });
    this.broadEventLog.push({ scope: "Location", subject: location, name: template.name, startDay: day, durationDays: template.durationDays });
  }

  private maybeTriggerWorldwideEvent(day: number): void {
    if (randRandom() >= this.worldwideEventProbability) return;
    const template = randChoice(WORLD_EVENT_TEMPLATES);
    const affectedMarkets = this.allMarkets();
    if (affectedMarkets.length === 0) return;
    for (const market of affectedMarkets) {
      market.applyEvent(new MarketEvent({ ...template, location: null }));
    }
    const trackingEvent = new MarketEvent({ ...template, location: null });
    trackingEvent.day = day;
    trackingEvent.type = "Worldwide";
    this.eventLog.push(trackingEvent);
    this.activeBroadEvents.push({ scope: "Worldwide", subject: "Global", startDay: day, event: trackingEvent });
    this.broadEventLog.push({ scope: "Worldwide", subject: "Global", name: template.name, startDay: day, durationDays: template.durationDays });
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

  private maybeTriggerLocationClosure(day: number): void {
    if (randRandom() >= this.locationClosureProbability) return;
    const candidates = this.locations.map((l) => l.name).filter((name) => !this.closedLocations.has(name));
    if (candidates.length === 0) return;
    const location = randChoice(candidates);
    const template = randChoice(LOCATION_CLOSURE_TEMPLATES);
    const closure = new LocationClosure(template);
    closure.day = day;
    closure.scope = location;
    closure.subject = location;
    this.closedLocations.set(location, closure);
    this.eventLog.push(closure);
    this.closureLog.push({ day, location, event: closure.name, durationDays: closure.durationDays });
  }

  private maybeTriggerCompanyEvents(day: number): void {
    for (const faction of this.factions) {
      // `type(faction) is Company` in Python (exact type, not isinstance --
      // SoloTrader extends Company but doesn't pool cash). Compared via
      // Object.getPrototypeOf rather than `faction.constructor !== Company`
      // to sidestep TS narrowing `faction` to `never` from that pattern.
      if (Object.getPrototypeOf(faction) !== Company.prototype) continue;
      if (randRandom() >= this.companyEventProbability) continue;
      const template = randChoice(COMPANY_EVENT_TEMPLATES);
      const event = new CompanyEvent(template);
      event.day = day;
      event.subject = faction.name;
      if (event.kind === "cash_gain") {
        faction.cash += event.magnitude;
      } else {
        faction.cash = Math.max(0.0, faction.cash - event.magnitude);
      }
      this.eventLog.push(event);
    }
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
    // excluding contracts fulfilled since a fulfiller only prunes those
    // lazily inside its own next directFleet call (after this loop).
    const activeContractKeys = new Set<string>([
      ...this.bulletinBoard.open.map((c) => contractKey(c.location, c.commodity)),
      ...this.factions
        .flatMap((f) => (f instanceof ContractFulfiller ? f.contracts.filter((c) => !c.fulfilled) : []))
        .map((c) => contractKey(c.location, c.commodity)),
    ]);
    for (const location of this.locations) {
      location.tenderContracts(day, this.bulletinBoard, activeContractKeys, this.contractOptions);
    }

    // Location closures resolve before anyone acts today.
    this.tickLocationClosures();
    this.tickBroadEvents();
    this.maybeTriggerLocationClosure(day);
    this.maybeTriggerCompanyEvents(day);

    // Traders act first, against the previous day's closing prices.
    const closedLocations = new Set(this.closedLocations.keys());
    const directedRoutes = new Map<Captain, Directive>();
    for (const faction of this.factions) {
      const directives = faction.directFleet(
        day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations, this.bulletinBoard,
      );
      for (const [captain, directive] of directives) directedRoutes.set(captain, directive);
    }

    const todaysOrder = this.agentOrderFn(this.captains, day);
    for (const trader of todaysOrder) {
      trader.act(day, this.buyMarkets, this.sellMarkets, commoditiesPresent, closedLocations, directedRoutes.get(trader) ?? null);
      for (const e of trader.eventLog) {
        if (e.day === day) this.eventLog.push(e);
      }
    }

    this.maybeTriggerGlobalEvent(day);
    this.maybeTriggerLocationEvent(day);
    this.maybeTriggerWorldwideEvent(day);

    // Production/consumption keep happening regardless of whether the port
    // can currently load or unload anyone -- only actual trading is
    // blocked by a closure.
    for (const location of this.locations) location.dailyUpdate();

    for (const market of this.allMarkets()) {
      const record = market.simulateDay(day, this.isLocationOpen(market.locationName));
      this.combinedHistory.push(record);
      if (market.lastTriggeredEvent !== null) this.eventLog.push(market.lastTriggeredEvent);
    }

    for (const trader of this.captains) trader.recordPortfolioSnapshot(day, this.sellMarkets);
    for (const faction of this.factions) faction.recordNetWorthSnapshot(day, this.sellMarkets);
  }
}
