/**
 * Country: a group of Locations that share one cash balance -- Locations
 * don't keep their own once they join a Country; every member's `cash`
 * (see `location.ts`) redirects to `Country.cash` instead, the same way a
 * Faction's Captains share its pool. TypeScript-only; no Python original.
 */
import type { Location } from "./location";

/** Default starting cash for a newly built Country -- see Country's constructor. */
export const DEFAULT_COUNTRY_CASH = 10_000_000_000;

export class Country {
  name: string;
  locations: Location[] = [];
  /** The single shared balance every member Location's `cash` property reads/writes through. */
  cash: number;

  constructor(name: string, locations: readonly Location[], cash: number = DEFAULT_COUNTRY_CASH) {
    this.name = name;
    this.cash = cash;
    for (const location of locations) {
      this.locations.push(location);
      location.country = this;
    }
  }
}
