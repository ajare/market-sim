/**
 * The world-wide pool of unhired Sailors, distributed one bucket per
 * Sea-capable Location (Port or Platform) -- a Ship draws its crew from
 * whichever bucket sits at its current dock (see Faction.crewFleet/
 * Captain.hireCrewIfPossible) instead of a fresh Sailor being generated on
 * the spot. Module-level `let`, mirroring worldData.ts's LOCATIONS/
 * DISTANCE_CONFIG pattern -- reassigned wholesale by generateSailorPool once
 * per World build.
 */
import type { Location } from "./location";
import type { Faction } from "./faction";
import { Ship } from "./transport";
import { Sailor, SAILOR_MIN_AGE, SAILOR_MAX_AGE, PIRACY_DECAY_PER_DAY } from "./sailor";
import { randomBirthDate } from "./person";
import { NATIONALITY_POOLS, randomNationality } from "./nationality";
import { randChoice, randRandom } from "./simRandom";
import type { NameRng } from "./names";
import { LOCATIONS } from "./worldData";
import { clamp01 } from "./utils";

/** Adapts the global sim RNG to the NameRng surface pool generation needs, and (via its `.random()`) to hireFromSailorPool's own random-pick surface -- so both draw off the same live seeded stream as the rest of the simulation. */
const globalNameRng: NameRng = { random: randRandom, choice: randChoice };

/** Minimum Sailors kept in a Sea-capable Location's pool even when no initial Ship demands crew there. */
export const SAILOR_POOL_FLOOR = 10;

let SAILOR_POOL: Map<string, Sailor[]> = new Map();

/** Wholesale-reassigns the pool (called once by generateSailorPool per World build). */
export function setSailorPool(pool: Map<string, Sailor[]>): void {
  SAILOR_POOL = pool;
}

/** Every not-currently-hired Sailor sitting at `locationName` right now. */
export function getSailorPoolAt(locationName: string): readonly Sailor[] {
  return SAILOR_POOL.get(locationName) ?? [];
}

/**
 * Decays every pool Sailor's `piracy` by PIRACY_DECAY_PER_DAY (clamped to
 * [0, 1]) -- the "sitting in a pool" half of World.runDay's daily piracy
 * tick; the "aboard a PirateBrigade Ship" half is handled there directly
 * (this module has no visibility into who's currently crewing what).
 */
export function tickPoolPiracy(): void {
  for (const list of SAILOR_POOL.values()) {
    for (const sailor of list) sailor.piracy = clamp01(sailor.piracy - PIRACY_DECAY_PER_DAY);
  }
}

/** Adds a Sailor to `locationName`'s pool (e.g. a rotated-out or disembarked hire rejoining it -- see Captain.advanceCrewRotation). */
export function addToSailorPool(locationName: string, sailor: Sailor): void {
  const list = SAILOR_POOL.get(locationName);
  if (list === undefined) SAILOR_POOL.set(locationName, [sailor]);
  else list.push(sailor);
}

/**
 * Removes and returns up to `count` random Sailors from `locationName`'s pool
 * whose `piracy` is at most `maxPiracy` (see Faction.hirePiracyThreshold) --
 * fewer than requested (down to none) if the pool doesn't have that many
 * eligible candidates, leaving the caller under-crewed rather than
 * generating anyone fresh or hiring someone too piracy-tainted (see
 * Faction.fillExtraSeats/Captain.hireCrewIfPossible). Defaults to 1.0 (hire
 * anyone, since piracy never exceeds 1) for any caller that doesn't care.
 */
export function hireFromSailorPool(
  locationName: string, count: number, maxPiracy: number = 1.0, rng: { random(): number } = globalNameRng,
): Sailor[] {
  if (count <= 0) return [];
  const list = SAILOR_POOL.get(locationName);
  if (list === undefined || list.length === 0) return [];
  const hired: Sailor[] = [];
  for (let i = 0; i < count; i++) {
    const eligible: number[] = [];
    for (let j = 0; j < list.length; j++) if (list[j].piracy <= maxPiracy) eligible.push(j);
    if (eligible.length === 0) break;
    const idx = eligible[Math.floor(rng.random() * eligible.length)];
    hired.push(list.splice(idx, 1)[0]);
  }
  return hired;
}

/** A freshly generated pool Sailor: uniformly random nationality, always Male (per the grilled spec -- not the usual 75/25 randomPersonName roll), name drawn from that nationality's male first-name pool, a plausible birth date, null nickname. */
function randomPoolSailor(): Sailor {
  const nationality = randomNationality(globalNameRng);
  const pool = NATIONALITY_POOLS[nationality].names;
  const name = `${globalNameRng.choice(pool.maleFirstNames)} ${globalNameRng.choice(pool.lastNames)}`;
  const dateOfBirth = randomBirthDate(globalNameRng.random, SAILOR_MIN_AGE, SAILOR_MAX_AGE);
  return new Sailor({ name, gender: "Male", nationality, dateOfBirth });
}

function isSeaCapable(location: Location): boolean {
  return location.terminalTypes.has("Port") || location.terminalTypes.has("Platform");
}

/** Final per-Location pool size is scaled up by this factor -- a buffer against Faction.hirePiracyThreshold shrinking the effective merchant/police-hireable pool over time as piracy-tainted Sailors accumulate (pirates themselves already drew from this same pool before that filter existed; this isn't about new pirate demand). */
export const SAILOR_POOL_SIZE_MULTIPLIER = 1.25;

/**
 * Builds and installs a fresh world-wide Sailor pool, sized per Sea-capable
 * Location (Port or Platform) at max(SAILOR_POOL_FLOOR, 2 x that Location's
 * total initial Ship crew demand) x SAILOR_POOL_SIZE_MULTIPLIER -- demand
 * summed across every already-registered Faction's Ships (Company/SoloTrader/
 * PirateBrigade/PoliceFleet), counting only seats beyond the Captain (a
 * fresh Faction's transport.crew is always just [captain] at this point --
 * see Faction's constructor/crewFleet). Must run after every initial
 * Faction/Ship has been constructed (so `transport.location`/
 * `crewRequirement` are set) but BEFORE any Faction.crewFleet() call, so the
 * pool exists by the time crewing actually draws from it. Called once by
 * World's constructor.
 */
export function generateSailorPool(factions: readonly Faction[]): void {
  const demandByLocation = new Map<string, number>();
  for (const faction of factions) {
    for (const captain of faction.captains) {
      const transport = captain.transport;
      if (transport === null || !(transport instanceof Ship) || transport.location === null) continue;
      const extraSeats = Math.max(0, transport.crewRequirement - transport.crew.length);
      demandByLocation.set(
        transport.location.name, (demandByLocation.get(transport.location.name) ?? 0) + extraSeats,
      );
    }
  }

  const pool = new Map<string, Sailor[]>();
  for (const location of LOCATIONS) {
    if (!isSeaCapable(location)) continue;
    const demand = demandByLocation.get(location.name) ?? 0;
    const size = Math.round(Math.max(SAILOR_POOL_FLOOR, 2 * demand) * SAILOR_POOL_SIZE_MULTIPLIER);
    const sailors: Sailor[] = [];
    for (let i = 0; i < size; i++) {
      const sailor = randomPoolSailor();
      sailor.disembarkAt(location);
      sailors.push(sailor);
    }
    pool.set(location.name, sailors);
  }
  setSailorPool(pool);
}
