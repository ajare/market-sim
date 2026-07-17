/**
 * Faction<TMember>: the generic core shared by every crew-owning party in
 * the sim -- a name, a roster of crew members, and their money. FleetOwner is
 * its Captain-crewed branch (owns a fleet of Ships): Company (its actively
 * fleet-directing subclass, with SoloTrader a non-pooling variant) /
 * PirateBrigade (a raiding subclass) / PoliceFleet (a currently-passive
 * law-enforcement subclass). ExpeditionParty is the other branch, crewed by
 * a single Explorer instead. Ported from sim/faction.py (FleetOwner's side
 * of this hierarchy only -- ExpeditionParty is TS-only, no Python original).
 *
 * `poolsCash` is a GETTER, not a plain field: FleetOwner's constructor reads
 * `this.poolsCash` while running, and a plain class-field override
 * (`poolsCash = false` on SoloTrader/PirateBrigade) would not yet be
 * applied at that point -- JS initializes subclass fields only AFTER the
 * base constructor body finishes running, unlike Python's class-attribute
 * MRO lookup, which resolves an override immediately even during
 * `FleetOwner.__init__`. A getter on the prototype chain is resolved
 * dynamically (like Python's MRO), so it works correctly here.
 */
import { Captain, isShipLogEnabled, type Directive, type TradeDirective } from "./captain";
import type { Explorer } from "./explorer";
import { trimHistory } from "./historyRetention";
import { Sailor, SAILOR_MIN_AGE, SAILOR_MAX_AGE, JOURNEYS_PER_HIRE } from "./sailor";
import {
  Ship, MIN_ATTACK_CONDITION_DAMAGE, MAX_ATTACK_CONDITION_DAMAGE, CONDITION_REPAIR_THRESHOLD, type Transport, type CargoItem,
} from "./transport";
import { getRoutes } from "./routes";
import { getLocation, distanceBetween } from "./worldData";
import { findShortestPath } from "./pathfinding";
import { Market, marketKey } from "./markets";
import { randChoice, randRandom, randUniform } from "./simRandom";
import type { BulletinBoard, Contract, ContractType } from "./contracts";
import type { Location } from "./location";
import type { PoliticalEntity } from "./politicalEntity";
import { locationSupportsTransport } from "./companyHome";
import { round2 } from "./utils";
import { randomGender, type NameRng } from "./names";
import { randomBirthDate, type Person } from "./person";
import { hireFromSailorPool, addToSailorPool } from "./sailorPool";
import { randomNationality } from "./nationality";

export type FleetCrew = Array<[Transport, Captain, string]>;

/**
 * The minimal surface Faction's constructor-time registration needs from
 * a "crew member" -- satisfied by both Captain (via Person) and Explorer (via
 * Person) without either needing to know about the other. Everything beyond
 * this (cash-pool bookkeeping, contracts, condition/cargo) is specific to the
 * concrete FleetOwner subclass and lives there instead (see FleetOwner, below).
 */
export interface FactionMember {
  name: string;
  transport: Transport | null;
  boardTransport(transport: Transport): void;
  disembarkAt(location: Location): void;
}

/** 0-based index -> bijective base-26 letters: 0="A", 25="Z", 26="AA", 27="AB", ... -- see Faction.dedupeMemberName. */
function alphaSequenceBase(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * The generic core every concrete subclass shares -- FleetOwner (Captain-crewed) or
 * ExpeditionParty (Explorer-crewed): a name, a roster of crew members each
 * paired with the Transport they command, and the constructor-time
 * bookkeeping (placing the Transport, boarding the member, deduping display
 * names) that's identical regardless of what kind of member this is.
 * Everything Captain/Ship-specific (cash pooling via ownCash, contracts,
 * condition/cargo, sinking, repair) stays on `FleetOwner` itself (below)
 * rather than here, since none of it applies to a non-Captain member like
 * Explorer -- see ExpeditionParty, the other concrete subclass of this base.
 *
 * `captains` keeps its name (rather than something like `members`) even
 * though it holds Explorers for ExpeditionParty -- renaming it would ripple
 * through every existing external read of `faction.captains`/`company.captains`
 * for zero behavioral benefit, since those all only ever see the Captain
 * flavor of this base in practice.
 */
export abstract class Faction<TMember extends FactionMember> {
  /** Whether this Faction pools its crew members' cash into one shared balance (true) or leaves each to their own (false) -- true by default; overridden false on SoloTrader/PirateBrigade/ExpeditionParty. See the class doc on why this is a getter, not a plain field. */
  get poolsCash(): boolean {
    return true;
  }

  name: string;
  captains: TMember[] = [];
  /** The PoliticalEntity this Faction is affiliated with, or null for an independent operator (the default). Purely informational. */
  politicalEntity: PoliticalEntity | null = null;
  startingCash: number;
  /** Names already in use by this Faction's fleet, so a duplicate (whether from a name generator's small pool or hand-authored JSON) gets disambiguated -- see dedupeTransportName. */
  private readonly transportNames = new Set<string>();
  /** Names already in use by this Faction's crew members -- see dedupeMemberName. */
  private readonly memberNames = new Set<string>();

  constructor(name: string, crew: Array<[Transport, TMember, string]>, startingCash: number = 0.0) {
    this.name = name;
    for (const [transport, member, homeLocation] of crew) {
      transport.arriveAt(getLocation(homeLocation)!);
      member.boardTransport(transport);
      this.captains.push(member);
      this.dedupeTransportName(transport);
      this.dedupeMemberName(member);
    }
    this.startingCash = startingCash;
  }

  /**
   * Renames `transport` if its name collides with one already in this
   * Faction's fleet, appending " 2", " 3", etc. until unique -- so no two
   * Transports in the same Faction ever share a display name, whether the
   * collision came from a name generator's pool being smaller than the fleet
   * or from hand-authored JSON.
   */
  protected dedupeTransportName(transport: Transport): void {
    if (this.transportNames.has(transport.name)) {
      const base = transport.name;
      let suffix = 2;
      while (this.transportNames.has(`${base} ${suffix}`)) suffix += 1;
      transport.name = `${base} ${suffix}`;
    }
    this.transportNames.add(transport.name);
  }

  /**
   * Renames `member` if their name collides with one already in this
   * Faction, inserting a middle initial before the last name -- "A." for the
   * first collision, "B." for the next, and so on (falling back to "AA.",
   * "AB.", ... past "Z." for a long run of same-named members), replacing
   * any middle initial a prior dedupe pass already inserted. A name with no
   * space (no separate last name) just gets the initial appended.
   */
  protected dedupeMemberName(member: TMember): void {
    if (this.memberNames.has(member.name)) {
      const parts = member.name.trim().split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.length > 1 ? parts[parts.length - 1] : null;
      let index = 0;
      let candidate: string;
      do {
        const initial = alphaSequenceBase(index);
        candidate = lastName !== null ? `${firstName} ${initial}. ${lastName}` : `${firstName} ${initial}.`;
        index += 1;
      } while (this.memberNames.has(candidate));
      member.name = candidate;
    }
    this.memberNames.add(member.name);
  }

  /**
   * Per-day autonomous planning hook -- decide what this Faction's crew
   * should do today, called once per day by World.runDay, never manually.
   * Always keyed by `TMember` (a Captain or an Explorer, both Persons), so a
   * caller holding only a `Faction<TMember>`-typed reference can still
   * dispatch every returned Directive without knowing which concrete
   * subclass produced it. A no-op here (empty map); FleetOwner overrides it
   * with its own ship-fleet no-op default (further overridden by Company/
   * PirateBrigade/PoliceFleet with their real routing logic, one entry per
   * idle Captain), and ExpeditionParty overrides it directly with its own
   * single-Explorer planning (at most one entry, for its one Explorer). The
   * two branches' overrides still take different parameter lists (a
   * FleetOwner's needs the contract board/pirate-density counts;
   * ExpeditionParty's doesn't), so this base signature's parameters stay
   * loose (`unknown[]`) -- only the return type is unified, since that's
   * the shape every caller actually needs to rely on.
   */
  direct(..._args: unknown[]): Map<Person, Directive> {
    return new Map();
  }
}

/** Adapts the global sim RNG to the NameRng surface randomPersonName/randomGender need, so a newly crewed Sailor's name/gender/birth date draw off the same seeded stream as the rest of the simulation. */
const globalNameRng: NameRng = { random: randRandom, choice: randChoice };

/** Range (inclusive, as a fraction of seized quantity) a raid destroys outright before fencing -- rolled fresh per attack. See PirateBrigade.attack. */
export const MIN_CARGO_DESTRUCTION_FRACTION = 0.25;
export const MAX_CARGO_DESTRUCTION_FRACTION = 0.75;

/**
 * How a Company decides between servicing contracts and arbitraging
 * (default: "compare" -- see Company.contractStrategy):
 * - "compare": weigh each contract against the ship's own best arbitrage
 *   route (by expected profit per ship-day) and take whichever pays more --
 *   claiming a contract only at the moment a ship commits to it.
 * - "prioritise": claim and service due contracts first, then arbitrage with
 *   whatever ships are left (the original behaviour, before this toggle
 *   existed).
 */
export type ContractStrategy = "prioritise" | "compare";

export interface FactionNetWorthSnapshot {
  day: number;
  cash: number;
  netWorth: number;
}

export class FleetOwner extends Faction<Captain> {
  override get poolsCash(): boolean {
    return true;
  }

  /** Whether this FleetOwner's Captains can attempt to smuggle cargo through a closed port's black market instead of waiting for it to reopen -- see Captain.maybeSmuggle. False by default; only SoloTrader overrides it. */
  get canSmuggle(): boolean {
    return false;
  }

  /** Whether this FleetOwner's hired Sailors rotate out after JOURNEYS_PER_HIRE journeys (see Captain.advanceCrewRotation/hireCrewIfPossible) -- true for Company/SoloTrader, false (permanent crew) for PirateBrigade/PoliceFleet and by default here. */
  get rotatesCrew(): boolean {
    return false;
  }

  /** Whether this FleetOwner's Captains fence cargo (seized in a raid, at a Location's discounted fenceFraction) rather than sell it at the live market price -- see Captain.act/fenceCargoIfPossible. False by default; only PirateBrigade overrides it. */
  get fencesCargo(): boolean {
    return false;
  }

  /** Whether this FleetOwner's Ships accumulate condition decay/damage and can sink (see Transport.condition, Captain.act, PirateBrigade.attack, FleetOwner.sinkAtSea/sinkInPort). False here in the base class; every concrete FleetOwner (Company, inherited by SoloTrader; PirateBrigade; PoliceFleet) overrides it to true -- there is currently no FleetOwner kind that actually leaves this false. */
  get decaysCondition(): boolean {
    return false;
  }

  /** Whether a docked Ship's crew can be granted Shore Leave overnight (see World.runDay's end-of-day Shore Leave step). True by default; only PoliceFleet overrides it. */
  get grantsShoreLeave(): boolean {
    return true;
  }

  /**
   * The most `Sailor.piracy` a candidate can have and still be hired by this
   * FleetOwner (see sailorPool.hireFromSailorPool, called from both
   * Captain.hireCrewIfPossible and FleetOwner.fillExtraSeats) -- 0 (maximally
   * strict) by default here and on PoliceFleet, 0.1 on Company (inherited by
   * SoloTrader), 1 (accepts anyone, since piracy never exceeds 1) on
   * PirateBrigade.
   */
  get hirePiracyThreshold(): number {
    return 0.0;
  }

  /**
   * Cargo and cash are ALWAYS lost when a Ship sinks -- at sea or in port,
   * survived or not (per the grilled spec, no partial retention either way).
   * "Cash on board" only has a literal meaning for a non-pooling Captain
   * (SoloTrader) -- their own balance is wiped; a pooling FleetOwner's shared
   * purse isn't "on" any one Ship, so it's untouched by a single Ship's
   * loss (mirroring how a pirate attack already only ever steals from a
   * non-pooling victim -- see PirateBrigade.attack). Shared by sinkAtSea and
   * sinkInPort, both below.
   */
  private loseCargoAndCash(captain: Captain): void {
    if (captain.cargo !== null) {
      for (const item of captain.cargo.items) {
        if (item.contract !== null) {
          item.contract.cancelled = true;
          item.contract.inFlightCaptain = null;
        }
      }
      captain.cargo = null;
    }
    if (!this.poolsCash) captain.ownCash = 0.0;
  }

  /**
   * A Ship sinking while genuinely InTransit, from unrepaired condition
   * decay (see Captain.act) -- pirates can never cause this, since an attack
   * only ever lands on an already-AtLocation victim (see maybeAttackOnArrival
   * / sinkInPort). Fatal: the crew AND the Captain die, permanently -- this
   * only removes `captain` from THIS FleetOwner's own `captains`; the caller
   * (World.runDay) still has to splice it out of `world.shipCaptains` too.
   * Never actually reached unless decaysCondition is true (checked by every
   * caller -- Captain.act's InTransit decay, PirateBrigade.attack), so a
   * FleetOwner where decaysCondition stays false never sinks at all. Declared
   * here (not just on the FleetOwners that enable it) so callers holding only
   * a `FleetOwner`-typed reference (e.g. Captain.company) can invoke it
   * without a value import of any specific subclass.
   */
  sinkAtSea(captain: Captain, day: number): void {
    // Lost at sea, but still disembarked (not just nulled) at the last
    // Location its Transport passed through (kept live even mid-transit --
    // see Transport.location's own doc comment) -- purely for bookkeeping:
    // World.runDay's PoliceFleet/Company auto-replacement (the only readers
    // of a just-died Captain's `.location`) need SOME Location to spawn the
    // replacement at, even though this Captain itself is fully discarded
    // (not tracked anywhere after this) and never reactivated.
    const sunkTransport = captain.transport!;
    const lastLocation = sunkTransport.location;
    this.loseCargoAndCash(captain);
    this.removeTransport(captain);
    if (lastLocation !== null) captain.disembarkAt(lastLocation);
    else captain.transport = null;
    // Recorded AFTER transport is otherwise cleared -- see Captain.lastTransport.
    captain.lastTransport = sunkTransport;
    // This Captain's final Ship's Log entry -- World.runDay's own end-of-day
    // recordShipLog pass never runs for it (already spliced out of
    // world.shipCaptains by the time that pass would reach it), so this is the
    // only place this ever gets written. Gated the same as recordShipLog
    // itself (see isShipLogEnabled) -- off by default.
    if (isShipLogEnabled()) {
      captain.shipLog.push({ day, text: `The ${sunkTransport.name} went down at sea with all hands -- lost with everyone aboard.` });
    }
  }

  /**
   * A Ship sinking while docked (a Port or Platform) -- currently only
   * reachable via a pirate attack's condition damage (see PirateBrigade.attack),
   * since condition never decays while AtLocation. Survivable: the crew
   * disembarks into this Location's Sailor pool (exactly like a normal crew-
   * rotation departure -- see Captain.advanceCrewRotation) and the Captain is
   * benched into `inactiveCaptains`, disembarked (no Transport, no crew) at
   * this Location -- see the class doc on `inactiveCaptains`. Only removes
   * `captain` from THIS FleetOwner's own `captains`; the caller (World.runDay)
   * still has to splice it out of `world.shipCaptains` too.
   */
  sinkInPort(captain: Captain, day: number): void {
    const transport = captain.transport!;
    const location = transport.location!;
    this.loseCargoAndCash(captain);
    for (const member of transport.crew) {
      if (member === captain) continue;
      member.disembarkAt(location);
      addToSailorPool(location.name, member);
    }
    this.removeTransport(captain);
    captain.disembarkAt(location);
    this.inactiveCaptains.push(captain);
    // See Captain.lastTransport.
    captain.lastTransport = transport;
    // This Captain's final Ship's Log entry for this Ship -- World.runDay's
    // own end-of-day recordShipLog pass never runs for it today (already
    // spliced out of world.shipCaptains by the time that pass would reach it).
    // If a replacement Ship is bought later this same turn (see
    // World.acquireShip), that gets its own fresh entry via newShipDay.
    // Gated the same as recordShipLog itself (see isShipLogEnabled) -- off
    // by default.
    if (isShipLogEnabled()) {
      captain.shipLog.push({ day, text: `The ${transport.name} was lost at ${location.name} -- ${captain.name} and crew made it ashore safely.` });
    }
  }

  /**
   * Splits every idle-in-port Captain into those needing repair (assigned a
   * REPAIR Directive immediately, before any trade/contract/patrol/reposition
   * logic -- a Ship below CONDITION_REPAIR_THRESHOLD can't depart at all
   * today, see Captain.act's RepairDirective handling) and the rest, still
   * free to be assigned something else this turn. Shared by every
   * decaysCondition FleetOwner's own direct (Company, PirateBrigade,
   * PoliceFleet) -- pointless to call from a FleetOwner where decaysCondition
   * stays false, since its Ships' condition never moves off 1 and this would
   * just return every idle Captain in `idle`, none in the repair map.
   */
  protected partitionForRepair(closedLocations: ReadonlySet<string>): { idle: Captain[]; directives: Map<Person, Directive> } {
    const idleAll = this.captains.filter((t) => t.isIdleInPort(closedLocations));
    const directives = new Map<Person, Directive>();
    const idle: Captain[] = [];
    for (const captain of idleAll) {
      if (captain.transport!.condition < CONDITION_REPAIR_THRESHOLD) {
        directives.set(captain, { action: "REPAIR" });
      } else {
        idle.push(captain);
      }
    }
    return { idle, directives };
  }

  /**
   * Places a freshly bought Ship at `location` (validated Port/Platform-
   * compatible), going through `this.addTransport` polymorphically --
   * correct as-is for PirateBrigade/PoliceFleet, which have no
   * home-location-forcing `addTransport` override to bypass in the first
   * place. Company overrides this to explicitly bypass ITS OWN
   * addTransport override (which forces a fresh recruit to the Company's
   * fixed homeLocation) via `super.addTransport`. Only called by
   * World.acquireShip.
   */
  buyShipAt(transport: Transport, captain: Captain, location: string): Captain {
    const loc = getLocation(location);
    if (loc === undefined || !locationSupportsTransport(loc, transport)) {
      throw new Error(`'${this.name}': Location '${location}' does not have a TerminalType required by '${transport.name}'.`);
    }
    return this.addTransport(transport, captain, location, 0);
  }

  /**
   * Captains benched after their Ship sank in port (see sinkInPort) -- no
   * longer in `captains` (or `world.shipCaptains`; World.runDay excludes them
   * from the daily loop entirely) and no longer aboard anything (disembarked
   * at wherever the sinking happened -- see Person.disembarkAt), just
   * sitting here until a future Ship purchase at their Location reactivates
   * them (see World.buyShipForCompany/acquireShip) or (SoloTrader/PoliceFleet
   * only) an automatic replacement purchase does.
   */
  inactiveCaptains: Captain[] = [];
  /** The single shared pool every captain's `cash` reads/writes through -- only meaningful when poolsCash. */
  cash: number = 0;
  netWorthHistory: FactionNetWorthSnapshot[] = [];

  constructor(name: string, crew: FleetCrew, startingCash: number = 0.0) {
    // Faction's constructor handles the member-agnostic bookkeeping
    // (placing each Transport, boarding each Captain, deduping display
    // names); only the Captain-specific bits (the Sailor-typed crew seat,
    // and ownCash/company cash wiring) are left to do here.
    super(name, crew, startingCash);
    for (const [transport, captain] of crew) {
      // Only the Captain's own seat is filled here -- extra Sailor seats are
      // deferred to crewFleet(), since the world-wide Sailor pool can only be
      // sized correctly once every initial FleetOwner's demand (Company/
      // SoloTrader/PirateBrigade/PoliceFleet) is known (see
      // sailorPool.generateSailorPool / World's constructor, which calls
      // crewFleet() on every FleetOwner right after generating the pool).
      transport.crew = [captain];
    }
    if (this.poolsCash) {
      this.cash = startingCash;
      for (const captain of this.captains) {
        this.cash += captain.ownCash;
        captain.ownCash = 0.0;
        captain.company = this;
      }
    } else {
      if (startingCash && this.captains.length > 0) {
        const share = startingCash / this.captains.length;
        for (const captain of this.captains) {
          captain.ownCash += share;
        }
      }
      for (const captain of this.captains) {
        captain.company = this;
      }
    }
  }

  /** A Sailor with the old placeholder "${transport.name} Sailor N" name -- every non-Ship Transport type's crew (the pool/hiring/speed mechanic in captain.ts is Ship-specific, so these keep the plain placeholder rather than a pool-drawn name). Still needs a gender/nationality/birth date to satisfy Person's fields, so those are still rolled (nationality doesn't influence the placeholder name, unlike a pool Sailor's). */
  private placeholderSailor(transport: Transport, seatIndex: number): Sailor {
    const gender = randomGender(globalNameRng);
    const nationality = randomNationality(globalNameRng);
    const dateOfBirth = randomBirthDate(globalNameRng.random, SAILOR_MIN_AGE, SAILOR_MAX_AGE);
    return new Sailor({ name: `${transport.name} Sailor ${seatIndex + 2}`, gender, nationality, dateOfBirth });
  }

  /**
   * Fills every registered Transport's remaining crew seats (beyond the
   * Captain) from the world-wide Sailor pool -- deferred out of the
   * constructor (see it for why). Safe to call more than once; a no-op for
   * any Transport already at its crewRequirement. Called by World's
   * constructor right after generating the pool, and (for a FleetOwner already
   * live in a running World) implicitly via addTransport's single-recruit path.
   */
  crewFleet(): void {
    for (const captain of this.captains) {
      if (captain.transport !== null) this.fillExtraSeats(captain.transport);
    }
  }

  /**
   * Fills as many of `transport`'s open seats (beyond the Captain) as its
   * current dock's Sailor pool allows -- a Ship is left under-crewed for any
   * seat the local pool can't cover (see hireFromSailorPool), never
   * generated fresh. Every other Transport type is unaffected by the pool
   * (Ship-only feature) and still gets freshly generated placeholder crew.
   * Shared by crewFleet (initial) and addTransport (single-recruit).
   */
  private fillExtraSeats(transport: Transport): void {
    const extraSeats = Math.max(0, transport.crewRequirement - transport.crew.length);
    if (extraSeats <= 0) return;
    if (!(transport instanceof Ship)) {
      for (let i = 0; i < extraSeats; i++) {
        const sailor = this.placeholderSailor(transport, transport.crew.length - 1 + i);
        sailor.boardTransport(transport);
        transport.crew.push(sailor);
      }
      return;
    }
    const location = transport.location;
    if (location === null) return;
    const hired = hireFromSailorPool(location.name, extraSeats, this.hirePiracyThreshold);
    for (const sailor of hired) {
      if (this.rotatesCrew) sailor.journeysRemaining = JOURNEYS_PER_HIRE;
      sailor.boardTransport(transport);
      transport.crew.push(sailor);
    }
  }

  /**
   * Adds a single new Transport/Captain to this fleet at runtime -- the
   * single-recruit equivalent of what the constructor does for the whole
   * initial crew array. `startingCash` folds in the same way the
   * constructor's `startingCash` does: added to the shared pool if this
   * FleetOwner pools cash, or credited directly to the new captain's own
   * balance otherwise. Returns `captain` for convenience.
   */
  addTransport(transport: Transport, captain: Captain, homeLocation: string, startingCash: number = 0.0): Captain {
    transport.arriveAt(getLocation(homeLocation)!);
    captain.boardTransport(transport);
    this.captains.push(captain);
    this.dedupeTransportName(transport);
    this.dedupeMemberName(captain);
    transport.crew = [captain];
    // A single-recruit addition runs against an already-live World -- the
    // Sailor pool already exists (unlike the constructor's initial fleet, see
    // there), so extra seats are filled immediately, not deferred.
    this.fillExtraSeats(transport);

    if (this.poolsCash) {
      this.cash += startingCash + captain.ownCash;
      captain.ownCash = 0.0;
    } else {
      captain.ownCash += startingCash;
    }
    captain.company = this;
    return captain;
  }

  /** Removes `captain` (and its Transport) from this fleet. Returns true if it was actually part of this fleet, false otherwise (no-op). */
  removeTransport(captain: Captain): boolean {
    const idx = this.captains.indexOf(captain);
    if (idx === -1) return false;
    this.captains.splice(idx, 1);
    return true;
  }

  totalCash(): number {
    if (this.poolsCash) return this.cash;
    return this.captains.reduce((sum, c) => sum + c.cash, 0);
  }

  netWorth(sellMarkets: Map<string, Market>): number {
    let total = this.totalCash();
    for (const t of this.captains) {
      if (t.cargo === null) continue;
      const markLocation = t.status === "AtLocation" ? t.locationName : t.cargo.destination;
      for (const item of t.cargo.items) {
        // Contract-bound items are bought and paid for by the issuing
        // Location, not the Company (see Captain.executeContractDelivery) --
        // the Company only fronts fuel -- so each is excluded individually
        // (a voyage's hold can mix a contract item with open-market ones).
        if (item.contract !== null) continue;
        const market = sellMarkets.get(marketKey(markLocation, item.commodity));
        const unitValue = market !== undefined ? market.price : item.unitCost;
        total += unitValue * item.quantity;
      }
    }
    return total;
  }

  recordNetWorthSnapshot(day: number, sellMarkets: Map<string, Market>): void {
    this.netWorthHistory.push({ day, cash: this.totalCash(), netWorth: this.netWorth(sellMarkets) });
    trimHistory(this.netWorthHistory, day);
  }

  /**
   * A plain FleetOwner has no active routing strategy -- its ships plan and
   * execute trades entirely autonomously. Returning an empty Map has the
   * same net effect as Python's NotImplementedError-caught-and-skipped
   * (World.merges whatever's returned into directedRoutes either way).
   */
  direct(
    _day: number,
    _buyMarkets: Map<string, Market>,
    _sellMarkets: Map<string, Market>,
    _commodities: string[],
    _closedLocations: ReadonlySet<string>,
    _board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Person, Directive> {
    return new Map();
  }
}

/**
 * A FleetOwner that accepts Contracts from a BulletinBoard, filtered to the
 * ContractTypes it declares it can handle (`contractTypes` -- empty means it
 * never accepts anything, e.g. SoloTrader). `contracts` holds every Contract
 * this fulfiller has accepted but not yet had fulfilled.
 */
export class ContractFulfiller extends FleetOwner {
  /** Contract types this fulfiller can accept. Empty by default -- a plain ContractFulfiller (like SoloTrader) accepts nothing. */
  contractTypes: readonly ContractType[] = [];

  /** Contracts accepted by this fulfiller -- see availableContracts/acceptContract. */
  contracts: Contract[] = [];

  /** Postings on `board` this fulfiller is able to accept, per `contractTypes`. Never includes an already-accepted posting -- a board only ever holds unaccepted ones. */
  protected availableContracts(board: BulletinBoard): Contract[] {
    return board.open.filter((c) => this.contractTypes.includes(c.type));
  }

  /** Accept `contract`: remove it from `board`, stamp this fulfiller as its owner, and add it to `contracts`. */
  protected acceptContract(board: BulletinBoard, contract: Contract): void {
    board.remove(contract);
    contract.fulfiller = this;
    this.contracts.push(contract);
  }

  /** Drop contracts this fulfiller has already had fulfilled OR cancelled (its cargo was seized by pirates -- see PirateBrigade.attack) -- called at the top of a servicing pass. */
  protected pruneFulfilled(): void {
    this.contracts = this.contracts.filter((c) => !c.fulfilled && !c.cancelled);
  }
}

/**
 * A FleetOwner that actively directs its fleet: coordinated routing (every
 * idle transport's best local route is scored and assigned in descending
 * daily-return order, spreading coverage rather than piling onto one
 * route) plus shared capital (inherited from FleetOwner). Also the only kind
 * of ContractFulfiller that can accept anything by default (`contractTypes`,
 * emptied on SoloTrader) -- how an accepted contract is weighed against
 * arbitrage is per-Company, via `contractStrategy` (see ContractStrategy and
 * direct).
 */
export class Company extends ContractFulfiller {
  override contractTypes: readonly ContractType[] = ["Commodity"];

  /** Company/SoloTrader hires rotate out after JOURNEYS_PER_HIRE journeys -- see FleetOwner.rotatesCrew. */
  override get rotatesCrew(): boolean {
    return true;
  }

  /** Company/SoloTrader Ships accumulate condition decay and can sink -- see FleetOwner.decaysCondition. */
  override get decaysCondition(): boolean {
    return true;
  }

  /** Company/SoloTrader will hire a lightly piracy-tainted Sailor (up to 0.1), unlike PoliceFleet's zero tolerance -- see FleetOwner.hirePiracyThreshold. */
  override get hirePiracyThreshold(): number {
    return 0.1;
  }

  /**
   * Whether THIS Company prioritises contracts over arbitrage, or weighs the
   * two by expected profit -- see ContractStrategy and direct. A plain
   * instance field (not shared state), so each Company could in principle run
   * a different strategy; buildWorld currently starts every Company at the
   * same default ("compare"), and the UI's toggle pushes a single choice onto
   * all of them at once, but nothing stops per-Company variation.
   */
  contractStrategy: ContractStrategy = "compare";

  /** Backing field for the homeLocation getter -- see it for why this is a getter, not a plain field. */
  private readonly _homeLocation: string | null;

  /**
   * The Location this Company's whole fleet is based out of -- every Transport
   * in it must be compatible with this Location's TerminalTypes (see
   * validateHomeLocationCompatibility). A getter (like poolsCash/canSmuggle)
   * so SoloTrader can override it to always report null ("SoloTraders do not
   * have a home port") regardless of what was passed to the constructor.
   */
  get homeLocation(): string | null {
    return this._homeLocation;
  }

  constructor(name: string, crew: FleetCrew, startingCash: number = 0.0, homeLocation: string | null = null) {
    if (homeLocation !== null) {
      const location = getLocation(homeLocation);
      if (location === undefined) {
        throw new Error(`Company '${name}': home Location '${homeLocation}' does not exist.`);
      }
      for (const [transport] of crew) {
        if (!locationSupportsTransport(location, transport)) {
          throw new Error(
            `Company '${name}': home Location '${homeLocation}' does not have a TerminalType required by '${transport.name}'.`,
          );
        }
      }
    }
    super(name, crew, startingCash);
    this._homeLocation = homeLocation;
  }

  /** Throws if `transport` isn't compatible with this Company's home Location -- shared by the constructor (initial fleet) and addTransport (later additions). No-op when homeLocation is null (a SoloTrader, which has none). */
  private validateHomeLocationCompatibility(transport: Transport): void {
    if (this._homeLocation === null) return;
    const location = getLocation(this._homeLocation);
    if (location === undefined || !locationSupportsTransport(location, transport)) {
      throw new Error(
        `Company '${this.name}': home Location '${this._homeLocation}' does not have a TerminalType required by '${transport.name}'.`,
      );
    }
  }

  /**
   * Same as FleetOwner.addTransport, except: (1) a new Transport incompatible
   * with this Company's home Location throws, matching the constructor's
   * check; (2) the new Captain always starts at the Company's home Location
   * -- the caller-supplied `homeLocation` param is only honored when this
   * Company has none (a SoloTrader, which overrides homeLocation to null).
   */
  override addTransport(transport: Transport, captain: Captain, homeLocation: string, startingCash: number = 0.0): Captain {
    this.validateHomeLocationCompatibility(transport);
    return super.addTransport(transport, captain, this._homeLocation ?? homeLocation, startingCash);
  }

  /**
   * A purchased Ship starts at the Location it was bought at, NOT this
   * Company's fixed `homeLocation` -- unlike a fleet-synthesis/initial-fleet
   * addition (addTransport, above), which always forces the Company's own
   * home. Only called by World.acquireShip (buyShipForCompany's/the
   * PoliceFleet auto-replacement's shared engine); `location` is validated
   * here (not just by the caller's UI) since this bypasses addTransport's
   * own validateHomeLocationCompatibility check entirely, going straight to
   * `super.addTransport` -- see FleetOwner.buyShipAt for why PirateBrigade/
   * PoliceFleet don't need (or have) an override of their own.
   */
  override buyShipAt(transport: Transport, captain: Captain, location: string): Captain {
    const loc = getLocation(location);
    if (loc === undefined || !locationSupportsTransport(loc, transport)) {
      throw new Error(`Company '${this.name}': Location '${location}' does not have a TerminalType required by '${transport.name}'.`);
    }
    return super.addTransport(transport, captain, location, 0);
  }

  direct(
    _day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Person, Directive> {
    // Repair need is checked FIRST, before any trade/contract logic -- see
    // FleetOwner.partitionForRepair.
    const { idle, directives } = this.partitionForRepair(closedLocations);
    if (idle.length === 0) return directives;

    const assigned = new Set<Captain>();

    if (this.contractStrategy === "compare") {
      this.serviceContractsByProfit(
        idle, assigned, directives, buyMarkets, sellMarkets, commodities, closedLocations, board,
      );
    } else {
      this.claimOpenContracts(board);
      this.serviceContracts(idle, assigned, directives, buyMarkets, closedLocations);
    }

    const arbitrageIdle = idle.filter((t) => !assigned.has(t));
    if (arbitrageIdle.length === 0) return directives;

    const candidates: Array<[Captain, TradeDirective]> = [];
    for (const trader of arbitrageIdle) {
      const best = trader.findBestLocalRoute(buyMarkets, sellMarkets, commodities, closedLocations);
      if (best !== null) candidates.push([trader, best]);
    }
    if (candidates.length === 0) return directives;

    candidates.sort((a, b) => b[1].dailyReturnPct - a[1].dailyReturnPct);

    // Multiple ships may share a (commodity, destination) route -- capped by
    // how much of the destination's deficit is still uncovered, so fleet
    // coordination scales shipping with actual demand instead of capping
    // every route at a single ship. The first ship onto a route is always
    // let through regardless of deficit size, matching the old one-per-day
    // fallback for routes with no measurable deficit (e.g. fuel depots). A
    // bundle now carries several (commodity, destination) route keys at
    // once (one per item) -- it's only rescored/skipped when EVERY item in
    // it is already fully claimed; a partially-capped bundle still ships
    // whichever of its items still have headroom.
    const claimedQuantity = new Map<string, number>();
    const fullRoutes = new Set<string>();
    const routeKeysFor = (b: TradeDirective) => b.items.map((i) => `${i.commodity}||${b.destination}`);
    for (let [trader, best] of candidates) {
      if (directives.has(trader)) continue;
      if (routeKeysFor(best).every((k) => fullRoutes.has(k))) {
        const alt = trader.findBestLocalRoute(
          buyMarkets, sellMarkets, commodities, closedLocations, new Set(fullRoutes),
        );
        if (alt === null) continue;
        best = alt;
        if (routeKeysFor(best).every((k) => fullRoutes.has(k))) continue;
      }

      directives.set(trader, best);
      for (const item of best.items) {
        const routeKey = `${item.commodity}||${best.destination}`;
        const claimed = (claimedQuantity.get(routeKey) ?? 0) + item.quantity;
        claimedQuantity.set(routeKey, claimed);
        if (claimed >= this.remainingDemand(item.commodity, best.destination)) {
          fullRoutes.add(routeKey);
        }
      }
    }
    return directives;
  }

  /**
   * Accept any still-available Contract off `board`, capped at roughly one
   * contract's worth of dedicated capacity per ship (`contracts.length <
   * captains.length`) so a single Company (especially whichever happens to
   * act first each day) can't monopolize every contract in the world --
   * leaving the rest for other Companies to pick up.
   *
   * No affordability check: the issuing Location pays for the goods
   * directly (see Captain.executeContractDelivery), so a Company only ever
   * needs to afford fuel for a delivery it's already accepted -- checked at
   * departure time, not at accept time.
   */
  private claimOpenContracts(board: BulletinBoard): void {
    this.pruneFulfilled();
    for (const contract of this.availableContracts(board)) {
      if (this.contracts.length >= this.captains.length) break;
      this.acceptContract(board, contract);
    }
  }

  /**
   * Assign idle captains to due, not-already-in-flight contracts before any
   * arbitrage routing runs. Prefers a captain already sitting at a valid
   * producer (immediate CONTRACT_DELIVER); otherwise repositions the nearest
   * available idle captain toward the nearest valid producer, to be handed
   * the delivery once it arrives (a future day's direct call will find
   * it idle-at-producer and take the first branch).
   */
  private serviceContracts(
    idle: Captain[],
    assigned: Set<Captain>,
    directives: Map<Person, Directive>,
    buyMarkets: Map<string, Market>,
    closedLocations: ReadonlySet<string>,
  ): void {
    for (const contract of this.contracts) {
      if (assigned.size >= idle.length) break;
      if (contract.inFlightCaptain !== null) {
        // An Inactive transport never recovers (Captain.act's InTransit
        // branch flips it once and there's no path back) -- so a captain
        // frozen mid-delivery would otherwise deadlock this contract
        // forever, since inFlightCaptain !== null blocks any replacement.
        // Release it so another idle captain can pick up the delivery.
        if (contract.inFlightCaptain.transport?.status === "Inactive") {
          contract.cancelled = true;
          contract.inFlightCaptain = null;
        } else {
          continue;
        }
      }
      const readyCaptain = idle.find((c) => {
        if (assigned.has(c)) return false;
        const market = buyMarkets.get(marketKey(c.locationName, contract.commodity));
        return market !== undefined && market.isAvailable;
      });
      if (readyCaptain !== undefined) {
        directives.set(readyCaptain, { action: "CONTRACT_DELIVER", contract });
        assigned.add(readyCaptain);
        continue;
      }

      // Reachability must allow a multi-hop path, not just a direct edge --
      // otherwise a captain idle somewhere with no DIRECT route to any
      // producer never gets repositioned at all, and (never moving) never
      // discovers a route from anywhere else either, permanently starving
      // the contract. departEmptyTo already executes multi-hop repositions
      // (its distance/time math is coordinate-based, not edge-based), so
      // this search just needs to match what it can actually carry out.
      //
      // Candidates are ranked by how much of the contract a trip there could
      // actually deliver (capped at contract.quantity -- once a producer can
      // fully supply it, more stock on top doesn't matter), THEN by
      // distance. Pure nearest-first previously let a commodity with few,
      // geographically scattered producers get stuck repeatedly routing to
      // the same nearby-but-thin producer instead of a farther one with
      // ample stock -- every delivery would land far short of
      // contract.quantity, never letting the destination's stockpile
      // recover (see Simulation.md's Gold/Silver stockout finding).
      let best: { captain: Captain; destination: string; deliverable: number; distance: number } | null = null;
      for (const captain of idle) {
        if (assigned.has(captain)) continue;
        for (const market of buyMarkets.values()) {
          if (market.commodityName !== contract.commodity || !market.isAvailable) continue;
          if (closedLocations.has(market.locationName)) continue;
          const path = findShortestPath(captain.locationName, market.locationName, (r) => captain.transport!.canUseRoute(r));
          if (path === null) continue;
          const deliverable = Math.min(captain.transport!.cargoCapacity, contract.quantity, market.availableQuantity);
          const dist = distanceBetween(captain.locationName, market.locationName);
          const better =
            best === null ||
            deliverable > best.deliverable ||
            (deliverable === best.deliverable && dist < best.distance);
          if (better) {
            best = { captain, destination: market.locationName, deliverable, distance: dist };
          }
        }
      }
      if (best !== null) {
        directives.set(best.captain, { action: "REPOSITION", destination: best.destination });
        assigned.add(best.captain);
      }
    }
  }

  /**
   * "compare"-mode servicing: instead of claiming and prioritising contracts,
   * weigh each contract against the ship's own best arbitrage route and take
   * whichever earns more per ship-day. Candidate contracts are this Company's
   * already-claimed unfulfilled ones plus still-open (unclaimed) ones -- but a
   * still-open contract is only actually claimed at the moment a ship commits
   * to it, so contracts we never find profitable stay open for other Companies
   * (and expire / re-tender normally) rather than being hoarded unserviced.
   */
  private serviceContractsByProfit(
    idle: Captain[],
    assigned: Set<Captain>,
    directives: Map<Person, Directive>,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    commodities: string[],
    closedLocations: ReadonlySet<string>,
    board: BulletinBoard,
  ): void {
    this.pruneFulfilled();
    const candidateContracts = [...this.contracts, ...this.availableContracts(board)];
    if (candidateContracts.length === 0) return;

    // The bar each contract must clear: the captain's best arbitrage $/day
    // (expected net profit over the trip, per day of ship-time). -Infinity
    // means the captain has no viable arbitrage right now, so any profitable
    // contract wins.
    const arbPerDay = new Map<Captain, number>();
    for (const captain of idle) {
      const best = captain.findBestLocalRoute(buyMarkets, sellMarkets, commodities, closedLocations);
      arbPerDay.set(captain, best !== null && best.travelDays > 0 ? best.expectedProfit / best.travelDays : -Infinity);
    }

    interface Option { captain: Captain; contract: Contract; producer: string; ready: boolean; perDay: number; }
    const options: Option[] = [];
    for (const contract of candidateContracts) {
      if (contract.inFlightCaptain !== null) {
        // Same Inactive-transport release valve as serviceContracts.
        if (contract.inFlightCaptain.transport?.status === "Inactive") {
          contract.cancelled = true;
          contract.inFlightCaptain = null;
        } else continue;
      }
      for (const captain of idle) {
        if (assigned.has(captain)) continue;
        const readyMarket = buyMarkets.get(marketKey(captain.locationName, contract.commodity));
        let producer: string | null;
        let ready = false;
        if (readyMarket !== undefined && readyMarket.isAvailable && !closedLocations.has(captain.locationName)) {
          producer = captain.locationName;
          ready = true;
        } else {
          producer = this.bestProducer(captain, contract, buyMarkets, closedLocations);
        }
        if (producer === null) continue;
        const perDay = captain.estimateContractProfitPerDay(contract, producer, buyMarkets);
        if (perDay === null) continue;
        if (perDay < (arbPerDay.get(captain) ?? -Infinity)) continue; // arbitrage is the better use of this ship
        options.push({ captain, contract, producer, ready, perDay });
      }
    }

    // Assign the most profitable options first, one ship per contract and one
    // contract per ship.
    options.sort((a, b) => b.perDay - a.perDay);
    const usedContracts = new Set<Contract>();
    for (const opt of options) {
      if (assigned.has(opt.captain) || usedContracts.has(opt.contract)) continue;
      if (opt.contract.fulfiller === null) {
        // Accept now, at commit time -- capped like claimOpenContracts so one
        // Company can't monopolise every contract.
        if (this.contracts.length >= this.captains.length) continue;
        this.acceptContract(board, opt.contract);
      }
      directives.set(
        opt.captain,
        opt.ready
          ? { action: "CONTRACT_DELIVER", contract: opt.contract }
          : { action: "REPOSITION", destination: opt.producer },
      );
      assigned.add(opt.captain);
      usedContracts.add(opt.contract);
    }
  }

  /**
   * Best producer for `captain` to source `contract.commodity` from: reachable,
   * ranked by how much of the contract a trip there could deliver (capped at
   * the contract quantity) then by distance -- the same ranking serviceContracts
   * uses, but resolved per-captain for serviceContractsByProfit.
   */
  private bestProducer(
    captain: Captain,
    contract: Contract,
    buyMarkets: Map<string, Market>,
    closedLocations: ReadonlySet<string>,
  ): string | null {
    let best: { destination: string; deliverable: number; distance: number } | null = null;
    for (const market of buyMarkets.values()) {
      if (market.commodityName !== contract.commodity || !market.isAvailable) continue;
      if (closedLocations.has(market.locationName)) continue;
      const path = findShortestPath(captain.locationName, market.locationName, (r) => captain.transport!.canUseRoute(r));
      if (path === null) continue;
      const deliverable = Math.min(captain.transport!.cargoCapacity, contract.quantity, market.availableQuantity);
      const dist = distanceBetween(captain.locationName, market.locationName);
      const better =
        best === null ||
        deliverable > best.deliverable ||
        (deliverable === best.deliverable && dist < best.distance);
      if (better) best = { destination: market.locationName, deliverable, distance: dist };
    }
    return best === null ? null : best.destination;
  }

  /** Deficit still open at a destination for a commodity -- floors at 0 so a destination already at/above its minimum doesn't block the first ship either. */
  private remainingDemand(commodity: string, destination: string): number {
    const location = getLocation(destination);
    if (location === undefined) return 0;
    const deficit = (location.minStockpiles[commodity] ?? 0) - (location.stockpiles[commodity] ?? 0);
    return Math.max(deficit, 0);
  }
}

/**
 * A Company that still gets coordinated routing but does NOT pool its
 * fleet's cash into one shared balance -- each captain keeps their own
 * private balance. Also opts out of the Contract system entirely, via an
 * empty `contractTypes` -- `availableContracts` then always returns nothing,
 * so a SoloTrader never accepts a posting regardless of what's on the board.
 * In exchange for being locked out of Contracts, it's the only FleetOwner that
 * can smuggle (`canSmuggle`) -- an independent operator with no corporate
 * oversight is willing to run a blockade a Company wouldn't touch.
 */
export class SoloTrader extends Company {
  constructor(name: string, crew: FleetCrew, startingCash: number = 0.0) {
    if (crew.length !== 1) {
      throw new Error(`SoloTrader '${name}' must have exactly one Transport/Captain, got ${crew.length}`);
    }
    super(name, crew, startingCash, null);
  }

  override get poolsCash(): boolean {
    return false;
  }

  /** SoloTraders do not have a home port, regardless of what Company's constructor stored -- always null. */
  override get homeLocation(): string | null {
    return null;
  }

  override contractTypes: readonly ContractType[] = [];

  /** SoloTrader's one distinctive edge over a plain Company: it'll run a closed port's blockade instead of just waiting -- see Captain.maybeSmuggle. */
  override get canSmuggle(): boolean {
    return true;
  }
}

/**
 * The exploration-mode analog of SoloTrader: manages exactly one Explorer
 * (in the "captain" role) commanding exactly one PorterParty (its single
 * Transport) -- non-pooling, like SoloTrader, since a lone expedition has no
 * fleet to pool cash across. Unlike SoloTrader, this doesn't extend `FleetOwner`
 * itself (which is hardcoded to Captain's Ship/cargo/contract machinery --
 * none of it applies to an Explorer); it extends the shared `Faction<TMember>`
 * core directly, the same base `FleetOwner` itself is built on.
 *
 * An Explorer already boards its PorterParty the moment it's constructed
 * (see Explorer's own constructor) and manages its own `cash` directly --
 * this wrapper doesn't move money around or re-place the Transport, it just
 * gives the expedition a Faction-shaped handle (name, `captains` -- here
 * always exactly one Explorer -- `politicalEntity`, `startingCash`) for
 * anything that expects one, and a home for future hiring machinery (e.g.
 * recruiting more porters from a village) to be added onto, the same way
 * SoloTrader is the natural home for Captain-side crew hiring today.
 */
export interface ExpeditionPartyOptions {
  startingCash?: number;
  /** Whether this party trades/moves autonomously (see direct) rather than waiting on the player's manual UI actions -- false (player-controlled) by default, so no existing World changes behavior unless explicitly opted into. */
  aiControlled?: boolean;
}

export class ExpeditionParty extends Faction<Explorer> {
  aiControlled: boolean;

  constructor(name: string, explorer: Explorer, options: ExpeditionPartyOptions = {}) {
    super(name, [[explorer.transport!, explorer, explorer.locationName]], options.startingCash ?? 0.0);
    this.aiControlled = options.aiControlled ?? false;
    // Mirrors FleetOwner's own constructor doing `captain.company = this` --
    // lets Explorer read `aiControlled` (see Explorer.arrive/tick) without
    // World having to thread it through separately.
    explorer.company = this;
  }

  /** Always false -- a lone expedition has no fleet to pool cash across, matching SoloTrader. */
  override get poolsCash(): boolean {
    return false;
  }

  /** The Explorer this party manages -- always exactly one, set at construction and never replaced (mirrors SoloTrader's single Captain). */
  get explorer(): Explorer {
    return this.captains[0];
  }

  /**
   * Default AI behavior for an aiControlled ExpeditionParty, called only the
   * day AFTER an arrival (this.explorer.destination only goes null once
   * Explorer.tick has already processed today's arrival -- see World.runDay's
   * expeditionParties loop and Explorer.tick's own doc comment for why this
   * ordering is a deliberate guarantee, not incidental): first restocks
   * gift-worthy goods out of necessity, not profit (see
   * Explorer.restockGiftsIfNeeded -- unlike Company's ships, this doesn't
   * depend on which destination gets picked, so it happens BEFORE the pick
   * below, not after); then picks a uniformly random direct Trail neighbor
   * (excluding closed Locations) and returns a bare REPOSITION Directive for
   * it -- no profit motive drives WHICH destination to pick, no idle-
   * partitioning, no fleet-wide per-route demand capping, since there's no
   * "fleet" here to direct anyway, just this one Explorer/PorterParty pair.
   * Stops for good the moment this Explorer's `cash` reaches zero (it can no
   * longer afford whatever passage toll or gift the next village might
   * demand): returns empty, permanently idle wherever it happens to be.
   * (Explorer.findBestLocalRoute/planTradeTo/executeTradeDirective still
   * exist and still work -- see the Leader interface -- they're just not
   * what this default AI calls anymore.)
   */
  direct(
    _day: number,
    buyMarkets: Map<string, Market>,
    _sellMarkets: Map<string, Market>,
    _commodities: string[],
    closedLocations: ReadonlySet<string>,
  ): Map<Person, Directive> {
    const directives = new Map<Person, Directive>();
    if (this.explorer.cash <= 0) return directives;
    if (this.explorer.destination !== null) return directives;
    this.explorer.restockGiftsIfNeeded(buyMarkets);
    const here = this.explorer.locationName;
    const candidates = this.explorer.reachableNeighbors.filter(
      (r) => !closedLocations.has(r.origin === here ? r.destination : r.origin),
    );
    if (candidates.length === 0) return directives;
    const route = randChoice(candidates);
    const destination = route.origin === here ? route.destination : route.origin;
    directives.set(this.explorer, { action: "REPOSITION", destination });
    return directives;
  }
}

export class PirateBrigade extends FleetOwner {
  override get poolsCash(): boolean {
    return false;
  }

  override get fencesCargo(): boolean {
    return true;
  }

  /** Pirates hire anyone -- 1 is the max possible piracy, so this never excludes a candidate. See FleetOwner.hirePiracyThreshold. */
  override get hirePiracyThreshold(): number {
    return 1.0;
  }

  /** Pirate Ships accumulate condition decay and can sink, same as Company -- see FleetOwner.decaysCondition. */
  override get decaysCondition(): boolean {
    return true;
  }

  targets: Company[];
  laziness: number;
  raidFraction: number;
  policeFleets: PoliceFleet[];
  /** Fraction of tracked Company/SoloTrader ship-presence at each Location, as of the last scan -- see direct's density-matching reposition logic. */
  private cachedTargetDensity: Map<string, number> | null = null;
  private lastScanDay: number | null = null;
  /**
   * Pirates that have already attacked SOMEONE today, reset once per day at
   * the top of direct (which -- like every FleetOwner's -- still runs
   * exactly once per day, before any Captain's own act()). Needed because
   * groundedDaysRemaining alone isn't a reliable one-attack-per-day gate: a
   * pirate's own act() call (wherever it falls in today's randomized
   * agentOrderFn order) decrements it back to 0 the same day it was set,
   * which -- without this set -- would let that pirate attack a SECOND,
   * later-arriving victim the same day if its own turn happened to fall
   * between the two arrivals.
   */
  private attackedToday = new Set<Captain>();

  constructor(
    name: string,
    crew: FleetCrew,
    targets: Company[],
    startingCash: number = 0.0,
    laziness: number = 1,
    raidFraction: number = 0.1,
    policeFleets: PoliceFleet[] | null = null,
  ) {
    const nonShips = crew.filter(([transport]) => !(transport instanceof Ship)).map(([, captain]) => captain.name);
    if (nonShips.length > 0) {
      throw new Error(
        `PirateBrigade '${name}' can only crew Ships -- non-Ship Transports on: ${nonShips.join(", ")}`,
      );
    }
    super(name, crew, startingCash);
    this.targets = targets;
    this.laziness = laziness;
    this.raidFraction = raidFraction;
    this.policeFleets = policeFleets ?? [];
  }

  /** Same Ship-only restriction as the constructor -- see its check above. */
  override addTransport(transport: Transport, captain: Captain, homeLocation: string, startingCash: number = 0.0): Captain {
    if (!(transport instanceof Ship)) {
      throw new Error(`PirateBrigade '${this.name}' can only crew Ships -- got a non-Ship Transport for captain '${captain.name}'`);
    }
    return super.addTransport(transport, captain, homeLocation, startingCash);
  }

  private targetShipCountsByLocation(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const company of this.targets) {
      for (const captain of company.captains) {
        const loc = captain.status === "AtLocation" ? captain.locationName : captain.destination;
        if (loc === null) continue;
        counts.set(loc, (counts.get(loc) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** This brigade's own current distribution across Locations, in the same AtLocation-or-heading-toward convention as targetShipCountsByLocation -- what direct compares against the target density to find under-covered spots. */
  private pirateShipCountsByLocation(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const captain of this.captains) {
      const loc = captain.status === "AtLocation" ? captain.locationName : captain.destination;
      if (loc === null) continue;
      counts.set(loc, (counts.get(loc) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * A Police Ship tied up on a REPAIR directive doesn't deter -- physically
   * present but not actually standing guard (see Captain.act's
   * RepairDirective handling, and PirateBrigade.isEligibleAttacker's
   * mirror-image "a repairing pirate can't attack" check). condition <
   * CONDITION_REPAIR_THRESHOLD is a reliable stand-in for "assigned a
   * REPAIR directive today" -- see FleetOwner.partitionForRepair, which always
   * issues one to every eligible idle-in-port Ship under threshold.
   */
  private policePresentAt(location: string): boolean {
    for (const policeFleet of this.policeFleets) {
      for (const captain of policeFleet.captains) {
        if (
          captain.status === "AtLocation" && captain.locationName === location &&
          captain.transport!.condition >= CONDITION_REPAIR_THRESHOLD
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** Whether `pirateCaptain` is fit to raid right now -- independent of its own InTransit/AtLocation status (see maybeAttackOnArrival). A Ship tied up on a REPAIR directive can't attack -- see policePresentAt's doc comment for why condition < CONDITION_REPAIR_THRESHOLD is used as the "repairing today" signal. */
  private isEligibleAttacker(pirateCaptain: Captain): boolean {
    return (
      pirateCaptain.groundedDaysRemaining === 0 &&
      !this.attackedToday.has(pirateCaptain) &&
      pirateCaptain.transport!.condition >= CONDITION_REPAIR_THRESHOLD &&
      !this.policePresentAt(pirateCaptain.locationName)
    );
  }

  /**
   * Called by Captain.act() the instant a tracked Company/SoloTrader captain
   * genuinely arrives somewhere, BEFORE it sells/delivers its cargo that same
   * act() call -- this is now the ONLY way a pirate ever attacks (a docked
   * ship that's already sold its cargo has nothing left worth raiding, so
   * there's no separate "ambush a stationary ship" path anymore -- see
   * PirateBrigade.direct, which now only repositions). Picks the first
   * eligible co-located pirate; a victim can only genuinely arrive once per
   * day, so no same-day dedup is needed on that side (see attackedToday for
   * the attacker side, which does still need one).
   */
  maybeAttackOnArrival(day: number, victimCaptain: Captain): void {
    if (!(victimCaptain.company instanceof Company) || !this.targets.includes(victimCaptain.company)) return;
    for (const pirateCaptain of this.captains) {
      if (pirateCaptain.locationName !== victimCaptain.locationName) continue;
      if (!this.isEligibleAttacker(pirateCaptain)) continue;
      this.attack(day, pirateCaptain, victimCaptain);
      this.attackedToday.add(pirateCaptain);
      pirateCaptain.groundedDaysRemaining = Math.max(pirateCaptain.groundedDaysRemaining, 1);
      return;
    }
  }

  /**
   * Steals cash outright and, if the victim is carrying cargo, seizes it onto
   * `pirateCaptain`'s own `cargo` -- exactly the same field a merchant uses
   * for its own trades. The destruction fraction (some of the haul is
   * damaged/dumped in the raid) is rolled here, at the moment of seizure, but
   * fencing the survivors for cash happens later THIS SAME DAY, in this
   * captain's own sell step (see Captain.act's fenceCargoIfPossible) -- same
   * turn a merchant would sell cargo it's just arrived with, priced fresh at
   * that point rather than snapshotted here.
   */
  private attack(day: number, pirateCaptain: Captain, victimCaptain: Captain): void {
    const victimPoolsCash = victimCaptain.company !== null && victimCaptain.company.poolsCash;
    const stolenCash = victimPoolsCash ? 0.0 : round2(victimCaptain.cash * this.raidFraction);
    victimCaptain.cash -= stolenCash;
    pirateCaptain.cash += stolenCash;

    // On top of the robbery, the raid itself damages the hull -- rolled
    // fresh per attack (see MIN/MAX_ATTACK_CONDITION_DAMAGE). Checked (not
    // applied) here; the actual sink -- always the survivable "in port"
    // case, since an attack only ever lands on an already-AtLocation victim
    // -- is deferred to the very end of this method, AFTER every remaining
    // `.locationName` read below (sinking disembarks the Captain, and
    // `.locationName` throws once there's no Transport left to read it off).
    let sinks = false;
    if (victimCaptain.transport!.handlesZeroCondition() && victimCaptain.company?.decaysCondition === true) {
      victimCaptain.transport!.condition -= randUniform(MIN_ATTACK_CONDITION_DAMAGE, MAX_ATTACK_CONDITION_DAMAGE);
      victimCaptain.transport!.recordCondition(day, "pirate");
      sinks = victimCaptain.transport!.condition <= 0;
    }

    interface SeizedItem { commodity: string; seizedQuantity: number; destroyedQuantity: number; }
    const seizedItems: SeizedItem[] = [];
    if (victimCaptain.cargo !== null) {
      const cargo = victimCaptain.cargo;

      // A raid is messy -- some of the haul gets damaged, dumped, or lost in
      // the scuffle before it ever reaches the fence, rolled fresh per
      // attack (see MIN/MAX_CARGO_DESTRUCTION_FRACTION). One shared roll for
      // the whole hold -- a raid isn't messier for one commodity than
      // another in the same hold. Only what survives boards the pirate
      // ship; the rest is gone for good.
      const destructionFraction = randUniform(MIN_CARGO_DESTRUCTION_FRACTION, MAX_CARGO_DESTRUCTION_FRACTION);
      const survivingCargoItems: CargoItem[] = [];
      for (const item of cargo.items) {
        const destroyedQuantity = round2(item.quantity * destructionFraction);
        const survivingQuantity = round2(item.quantity - destroyedQuantity);
        seizedItems.push({ commodity: item.commodity, seizedQuantity: item.quantity, destroyedQuantity });

        // Contract-bound cargo never reaches its destination either way
        // (fenced or destroyed), so the delivery is cancelled outright --
        // the fulfiller is never paid (fulfillContract only pays out on
        // actual arrival, which can no longer happen now that cargo is
        // null) and the pair becomes eligible for a fresh tender again (see
        // World's activeContractKeys / ContractFulfiller.pruneFulfilled).
        if (item.contract !== null) {
          item.contract.cancelled = true;
          item.contract.inFlightCaptain = null;
        }
        if (survivingQuantity > 0) {
          survivingCargoItems.push({ commodity: item.commodity, quantity: survivingQuantity, unitCost: 0, contract: null });
        }
      }
      victimCaptain.cargo = null;

      if (survivingCargoItems.length > 0) {
        pirateCaptain.cargo = {
          items: survivingCargoItems,
          origin: pirateCaptain.locationName,
          destination: pirateCaptain.locationName,
          distance: 0,
          routeType: "none",
          travelDays: 0,
          fuelPricePaid: 0,
          fuelUnitsConsumed: 0,
          fuelCostTotal: 0,
          totalCost: 0,
          departureDay: day,
        };
      }
    }

    // Even an otherwise-empty raid (no cash, no cargo) is still worth
    // logging/resolving if it happened to sink the Ship.
    if (stolenCash <= 0 && seizedItems.length === 0 && !sinks) return;

    if (seizedItems.length > 0) {
      // The stolen-cash profit is recorded once, on the first item's row --
      // it's a single lump sum for the whole raid, not per commodity.
      seizedItems.forEach((s, i) => {
        pirateCaptain.tradeLog.push({
          day,
          action: "ATTACK",
          commodity: s.commodity,
          location: pirateCaptain.locationName,
          destination: victimCaptain.name,
          quantity: round2(s.seizedQuantity),
          price: null,
          distance: null,
          routeType: null,
          travelDays: null,
          fuelPrice: null,
          fuelUnitsConsumed: null,
          fuelCostPaid: 0.0,
          profit: i === 0 ? round2(stolenCash) : null,
        });
      });
    } else {
      pirateCaptain.tradeLog.push({
        day,
        action: "ATTACK",
        commodity: null,
        location: pirateCaptain.locationName,
        destination: victimCaptain.name,
        quantity: 0,
        price: null,
        distance: null,
        routeType: null,
        travelDays: null,
        fuelPrice: null,
        fuelUnitsConsumed: null,
        fuelCostPaid: 0.0,
        profit: round2(stolenCash),
      });
    }

    let detail = stolenCash > 0 ? `-$${stolenCash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} cash` : "cash pooled -- untouchable";
    if (seizedItems.length > 0) {
      const itemsDesc = seizedItems
        .map((s) => `${s.seizedQuantity.toFixed(1)} ${s.commodity} (${s.destroyedQuantity.toFixed(1)} destroyed)`)
        .join(", ");
      detail += `, ${itemsDesc} seized`;
    }
    if (sinks) detail += ", and the Ship sank";
    victimCaptain.agentEventLog.push({
      day,
      location: victimCaptain.locationName,
      name: `Pirate attack by ${pirateCaptain.name} (${this.name})`,
      kind: "cash_loss",
      detail,
    });

    // Must come LAST -- sinking disembarks victimCaptain (clears its
    // Transport), and every `.locationName` read above requires one.
    if (sinks) victimCaptain.company?.sinkInPort(victimCaptain, day);
  }

  direct(
    day: number,
    _buyMarkets: Map<string, Market>,
    _sellMarkets: Map<string, Market>,
    _commodities: string[],
    closedLocations: ReadonlySet<string>,
    _board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Person, Directive> {
    this.attackedToday = new Set();

    const needsScan = this.lastScanDay === null || day - this.lastScanDay >= this.laziness;
    if (needsScan) {
      const targetCounts = this.targetShipCountsByLocation();
      const totalTargets = [...targetCounts.values()].reduce((a, b) => a + b, 0);
      this.cachedTargetDensity = totalTargets > 0
        ? new Map([...targetCounts.entries()].map(([loc, count]) => [loc, count / totalTargets]))
        : new Map();
      this.lastScanDay = day;
    }

    const targetDensity = this.cachedTargetDensity;
    if (targetDensity === null || targetDensity.size === 0) return new Map();

    // Tracks this brigade's own distribution as directives are handed out
    // below, so multiple idle ships assigned within the same day's pass see
    // each other's moves and spread out, rather than every one of them
    // independently piling onto whichever single spot looked most
    // under-covered at the start of the day.
    const pirateCounts = this.pirateShipCountsByLocation();
    const totalPirates = this.captains.length;

    // Repair need is checked FIRST, before reposition -- see
    // FleetOwner.partitionForRepair. Attacking is no longer decided here -- see
    // maybeAttackOnArrival, the only remaining attack trigger (a ship
    // already sitting in port has nothing left worth raiding, having
    // already sold on arrival). This loop now purely repositions idle,
    // condition-permitting ships toward under-covered targets.
    const { idle, directives } = this.partitionForRepair(closedLocations);
    for (const captain of idle) {
      // Rank every Location with Company/SoloTrader presence by how far
      // short of its target-density share this brigade's OWN ship count
      // there currently falls (desired - current), most-deficient first --
      // matching pirate density to target density instead of the old
      // winner-take-all chase of a single busiest hotspot.
      const ranked = [...targetDensity.entries()]
        .map(([loc, density]) => ({ loc, deficit: density * totalPirates - (pirateCounts.get(loc) ?? 0) }))
        .sort((a, b) => b.deficit - a.deficit);

      for (const { loc } of ranked) {
        if (loc === captain.locationName || closedLocations.has(loc)) continue;
        if (!getRoutes(captain.locationName, loc).some((r) => captain.transport!.canUseRoute(r))) continue;
        directives.set(captain, { action: "REPOSITION", destination: loc });
        pirateCounts.set(loc, (pirateCounts.get(loc) ?? 0) + 1);
        pirateCounts.set(captain.locationName, Math.max(0, (pirateCounts.get(captain.locationName) ?? 0) - 1));
        break;
      }
    }
    return directives;
  }
}

/**
 * A law-enforcement FleetOwner -- currently pure random-wandering patrol.
 * Government-funded: always pools cash into a bottomless, infinite pool.
 */
export class PoliceFleet extends FleetOwner {
  override get poolsCash(): boolean {
    return true;
  }

  /** Zero tolerance -- FleetOwner's own base default (0) already means this, but stated explicitly here since Company relaxes it to 0.1. See FleetOwner.hirePiracyThreshold. */
  override get hirePiracyThreshold(): number {
    return 0.0;
  }

  /** Police Ships accumulate condition decay and can sink, same as Company -- see FleetOwner.decaysCondition. A sunk Police Ship is replaced immediately regardless of outcome -- see World.runDay's post-act() cleanup. */
  override get decaysCondition(): boolean {
    return true;
  }

  /** Police crews stay aboard on duty overnight -- no Shore Leave, unlike Company/SoloTrader/PirateBrigade. See FleetOwner.grantsShoreLeave. */
  override get grantsShoreLeave(): boolean {
    return false;
  }

  targets: PirateBrigade[];
  patrolIntervalDays: number;
  private lastPatrolDay = new Map<Captain, number>();

  constructor(
    name: string,
    crew: FleetCrew,
    targets: PirateBrigade[] | null = null,
    patrolIntervalDays: number = 5,
  ) {
    super(name, crew, Infinity);
    this.targets = targets ?? [];
    this.patrolIntervalDays = patrolIntervalDays;
  }

  private randomPatrolDestination(
    captain: Captain,
    allLocations: ReadonlySet<string>,
    closedLocations: ReadonlySet<string>,
  ): string | null {
    const candidates = [...allLocations].filter(
      (loc) =>
        loc !== captain.locationName &&
        !closedLocations.has(loc) &&
        getRoutes(captain.locationName, loc).some((r) => captain.transport!.canUseRoute(r)),
    );
    if (candidates.length === 0) return null;
    return randChoice(candidates);
  }

  direct(
    day: number,
    buyMarkets: Map<string, Market>,
    sellMarkets: Map<string, Market>,
    _commodities: string[],
    closedLocations: ReadonlySet<string>,
    _board: BulletinBoard,
    _pirateCounts: ReadonlyMap<string, number> = new Map(),
  ): Map<Person, Directive> {
    const allLocations = new Set<string>();
    for (const m of buyMarkets.values()) allLocations.add(m.locationName);
    for (const m of sellMarkets.values()) allLocations.add(m.locationName);

    // Repair need is checked FIRST, before patrol assignment -- see
    // FleetOwner.partitionForRepair.
    const { idle, directives } = this.partitionForRepair(closedLocations);
    for (const captain of idle) {
      const lastPatrolDay = this.lastPatrolDay.get(captain);
      if (lastPatrolDay !== undefined && day - lastPatrolDay < this.patrolIntervalDays) continue;

      const destination = this.randomPatrolDestination(captain, allLocations, closedLocations);
      if (destination === null) continue;

      directives.set(captain, { action: "REPOSITION", destination });
      this.lastPatrolDay.set(captain, day);
    }
    return directives;
  }
}
