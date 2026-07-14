/**
 * Person: the base identity for anyone in the simulation who occupies a
 * place in the world -- either physically at a Location, or aboard a
 * Transport (never both, never neither, once actually placed somewhere).
 * Sailor (and its Captain subclass) are the only concrete subtypes today;
 * Person itself is never instantiated directly.
 */
import type { Location } from "./location";
import type { Transport } from "./transport";
import { randomGender, type Gender } from "./names";
import type { Nationality } from "./nationality";
import { getWorldStartDate } from "./worldData";

export type { Gender };

export interface PersonInit {
  name: string;
  nickname?: string | null;
  gender: Gender;
  /** Cultural background used to draw this Person's name/ship/company pools at generation time (see nationality.ts) -- purely informational once set, kept for display. Null for the rare Person built without ever picking one (most existing test fixtures). */
  nationality?: Nationality | null;
  dateOfBirth: Date;
  dailyWage?: number;
  location?: Location | null;
  transport?: Transport | null;
}

export class Person {
  name: string;
  nickname: string | null;
  gender: Gender;
  nationality: Nationality | null;
  dateOfBirth: Date;
  dailyWage: number;
  location: Location | null;
  transport: Transport | null;

  constructor(init: PersonInit) {
    this.name = init.name;
    this.nickname = init.nickname ?? null;
    this.gender = init.gender;
    this.nationality = init.nationality ?? null;
    this.dateOfBirth = init.dateOfBirth;
    this.dailyWage = init.dailyWage ?? 0.0;
    this.location = init.location ?? null;
    this.transport = init.transport ?? null;
  }

  /** Boards `transport` -- clears `location` (see the class doc's AT/ON invariant). */
  boardTransport(transport: Transport): void {
    this.transport = transport;
    this.location = null;
  }

  /** Disembarks at `location` -- clears `transport`. */
  disembarkAt(location: Location): void {
    this.location = location;
    this.transport = null;
  }

  /**
   * Where this Person actually is right now: their own `location` if set,
   * else wherever their `transport` currently is (see Transport.location).
   * Null only if this Person has never been placed anywhere at all.
   */
  currentLocation(): Location | null {
    return this.location ?? this.transport?.location ?? null;
  }
}

/** Days in a year, for randomBirthDate's whole-years-before-`reference` math -- deliberately not calendar-leap-aware, a birth date has no other consumer that cares about the difference. */
const DAYS_PER_YEAR = 365.25;

/**
 * A birth date `minAge`-`maxAge` years before `reference` (inclusive,
 * uniform over the whole range in days) -- used to give a newly created
 * Sailor/Captain a plausible adult age. `reference` is normally the World's
 * own start date (see worldData.getWorldStartDate), not "now", so a Sailor
 * hired on day 3000 doesn't get a birth date implausibly close to the
 * present moment of an in-progress simulation.
 */
export function randomBirthDate(random: () => number, minAge: number, maxAge: number, reference: Date = getWorldStartDate()): Date {
  const minDays = minAge * DAYS_PER_YEAR;
  const maxDays = maxAge * DAYS_PER_YEAR;
  const ageDays = minDays + random() * (maxDays - minDays);
  return new Date(reference.getTime() - ageDays * 24 * 60 * 60 * 1000);
}

/**
 * Whole years between `dateOfBirth` and `reference` -- the simulated age to
 * display for a Person. `reference` is normally the World's own CURRENT date
 * (World.currentDate), not "now" or the World's start date, so a Sailor's
 * displayed age keeps advancing as the simulation runs.
 */
export function ageInYears(dateOfBirth: Date, reference: Date): number {
  let age = reference.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthdayThisYear =
    reference.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (reference.getUTCMonth() === dateOfBirth.getUTCMonth() && reference.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

export { randomGender };
