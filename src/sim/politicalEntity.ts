/**
 * PoliticalEntity: a group of Locations that share one cash balance --
 * Locations don't keep their own once they join a PoliticalEntity; every
 * member's `cash` (see `location.ts`) redirects to `PoliticalEntity.cash`
 * instead, the same way a Faction's Captains share its pool. TypeScript-only;
 * no Python original.
 */
import type { Location } from "./location";

/** Default starting cash for a newly built PoliticalEntity -- see PoliticalEntity's constructor. */
export const DEFAULT_POLITICAL_ENTITY_CASH = 10_000_000_000;

/** The scale a PoliticalEntity groups Locations at, from broadest to narrowest. */
export type PoliticalEntityType = "Universal" | "Planet" | "Country" | "State";

export const POLITICAL_ENTITY_TYPES: PoliticalEntityType[] = ["Universal", "Planet", "Country", "State"];

export const DEFAULT_POLITICAL_ENTITY_TYPE: PoliticalEntityType = "Universal";

export class PoliticalEntity {
  name: string;
  locations: Location[] = [];
  /** The single shared balance every member Location's `cash` property reads/writes through. */
  cash: number;
  type: PoliticalEntityType;

  constructor(
    name: string,
    locations: readonly Location[],
    cash: number = DEFAULT_POLITICAL_ENTITY_CASH,
    type: PoliticalEntityType = DEFAULT_POLITICAL_ENTITY_TYPE,
  ) {
    this.name = name;
    this.cash = cash;
    this.type = type;
    for (const location of locations) {
      this.locations.push(location);
      location.politicalEntity = this;
    }
  }
}
