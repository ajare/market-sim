/**
 * Sailor: a Person who crews a Transport (Person's Crew-class replacement --
 * see person.ts). Captain is a Sailor whose rank is always "Captain"; every
 * other crew member is an "Able Seaman".
 */
import { Person, type PersonInit } from "./person";

export type Rank = "Captain" | "Able Seaman";

/** Fallback per-day wage for a Sailor whose init doesn't specify one -- unchanged from the old Crew/Sailor default. Captain overrides this back to 0 (Captains are unpaid, see captain.ts). */
export const DEFAULT_SAILOR_DAILY_WAGE = 20.0;

/** Min/max age (years) a newly generated Sailor/Captain's birth date is drawn from, relative to the World's own start date -- see person.ts's randomBirthDate. Applies to Captains too, since Captain extends Sailor. */
export const SAILOR_MIN_AGE = 18;
export const SAILOR_MAX_AGE = 50;

/** Journeys a Company/SoloTrader hire is good for before disembarking at the next dock and rejoining that Location's Sailor pool -- see Captain's advanceCrewRotation/hireCrewIfPossible and Faction.rotatesCrew. */
export const JOURNEYS_PER_HIRE = 5;

/** How much a Sailor's `piracy` rises for every day it spends aboard a PirateBrigade Ship's crew -- see World.runDay's daily piracy tick. */
export const PIRACY_INCREASE_PER_DAY = 0.01;
/** How much a Sailor's `piracy` falls for every day it spends NOT aboard a PirateBrigade Ship (aboard any other Faction's Ship, or sitting in a Location's pool) -- see World.runDay's daily piracy tick. */
export const PIRACY_DECAY_PER_DAY = 0.02;

/** Chance a docked Ship's Captain grants Shore Leave for the night -- see World.runDay's end-of-day Shore Leave step. */
export const SHORE_LEAVE_PROBABILITY = 0.5;

export class Sailor extends Person {
  rank: Rank = "Able Seaman";
  /** Journeys left before this Sailor's hire term is up (Company/SoloTrader hires only -- see JOURNEYS_PER_HIRE/Faction.rotatesCrew). Null means permanent crew: the Captain, a PirateBrigade/PoliceFleet hire, or a pool Sailor not yet hired by anyone. */
  journeysRemaining: number | null = null;
  /**
   * [0, 1] -- how "tainted" by piracy this Sailor currently is. Starts at 0
   * for everyone. Ticks up while crewing a PirateBrigade Ship, down
   * otherwise (see World.runDay's daily piracy tick, PIRACY_INCREASE_PER_DAY/
   * PIRACY_DECAY_PER_DAY), clamped to [0, 1]. Gates hiring -- see
   * Faction.hirePiracyThreshold/sailorPool.hireFromSailorPool.
   */
  piracy = 0.0;

  constructor(init: PersonInit) {
    super({ dailyWage: DEFAULT_SAILOR_DAILY_WAGE, ...init });
  }

  /** Placeholder for whatever a Sailor granted Shore Leave does ashore -- see World.runDay's end-of-day Shore Leave step. */
  shoreLeave(): void {}
}
