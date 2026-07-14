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

export class Sailor extends Person {
  rank: Rank = "Able Seaman";
  /** Journeys left before this Sailor's hire term is up (Company/SoloTrader hires only -- see JOURNEYS_PER_HIRE/Faction.rotatesCrew). Null means permanent crew: the Captain, a PirateBrigade/PoliceFleet hire, or a pool Sailor not yet hired by anyone. */
  journeysRemaining: number | null = null;

  constructor(init: PersonInit) {
    super({ dailyWage: DEFAULT_SAILOR_DAILY_WAGE, ...init });
  }
}
