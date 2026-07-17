/**
 * PoliticalEntity: a group of Locations that share one cash balance --
 * Locations don't keep their own once they join a PoliticalEntity; every
 * member's `cash` (see `location.ts`) redirects to `PoliticalEntity.cash`
 * instead, the same way a FleetOwner's Captains share its pool. TypeScript-only;
 * no Python original.
 */
import type { Location } from "./location";
import { DEFAULT_NATIONALITY, type Nationality } from "./nationality";
import {
  POLITICAL_ENTITY_TYPES, DEFAULT_POLITICAL_ENTITY_TYPE, type PoliticalEntityType,
} from "@market-sim/shared/politicalEntity";
export { POLITICAL_ENTITY_TYPES, DEFAULT_POLITICAL_ENTITY_TYPE, type PoliticalEntityType };

/** Default starting cash for a newly built PoliticalEntity -- see PoliticalEntity's constructor. */
export const DEFAULT_POLITICAL_ENTITY_CASH = 10_000_000_000;

export class PoliticalEntity {
  name: string;
  locations: Location[] = [];
  /** The single shared balance every member Location's `cash` property reads/writes through. */
  cash: number;
  type: PoliticalEntityType;
  /** Cultural nationality this entity's affiliated Companies draw ship/captain names from when a fleet is synthesized (see buildWorldFromJson). */
  nationality: Nationality;

  constructor(
    name: string,
    locations: readonly Location[],
    cash: number = DEFAULT_POLITICAL_ENTITY_CASH,
    type: PoliticalEntityType = DEFAULT_POLITICAL_ENTITY_TYPE,
    nationality: Nationality = DEFAULT_NATIONALITY,
  ) {
    this.name = name;
    this.cash = cash;
    this.type = type;
    this.nationality = nationality;
    for (const location of locations) {
      this.locations.push(location);
      location.politicalEntity = this;
    }
  }
}
