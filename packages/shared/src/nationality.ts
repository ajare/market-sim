/**
 * The five nationalities the name generators cover, and a map from each to its
 * person-name / ship-name / company-name / location-name pools (see names.ts,
 * shipNames.ts, companyNames.ts, locationNames.ts). Lets a caller pick names
 * "in" a nationality without knowing which pool constants back it -- used when
 * synthesizing a fleet for a loaded JSON world, where each Company's
 * nationality comes from its PoliticalEntity (or a seeded-random one for
 * Independent factions), and by the editor's per-nationality name generators.
 */
import {
  ENGLISH_NAMES, FRENCH_NAMES, SPANISH_NAMES, DUTCH_NAMES, PORTUGUESE_NAMES,
  type NamePool, type NameRng,
} from "./names";
import {
  ENGLISH_SHIP_NAMES, FRENCH_SHIP_NAMES, SPANISH_SHIP_NAMES, DUTCH_SHIP_NAMES, PORTUGUESE_SHIP_NAMES,
} from "./shipNames";
import {
  ENGLISH_COMPANY_NAMES, FRENCH_COMPANY_NAMES, SPANISH_COMPANY_NAMES, DUTCH_COMPANY_NAMES, PORTUGUESE_COMPANY_NAMES,
  type CompanyNamePool,
} from "./companyNames";
import {
  ENGLISH_LOCATION_NAMES, FRENCH_LOCATION_NAMES, SPANISH_LOCATION_NAMES, DUTCH_LOCATION_NAMES, PORTUGUESE_LOCATION_NAMES,
} from "./locationNames";

export type Nationality = "English" | "French" | "Spanish" | "Dutch" | "Portuguese";

export const NATIONALITIES: Nationality[] = ["English", "French", "Spanish", "Dutch", "Portuguese"];

export const DEFAULT_NATIONALITY: Nationality = "English";

/** The name pools backing a nationality: captain names, ship names, chartered-company names, and location names. */
export interface NationalityPools {
  names: NamePool;
  ships: string[];
  companies: CompanyNamePool;
  locations: string[];
}

export const NATIONALITY_POOLS: Record<Nationality, NationalityPools> = {
  English: {
    names: ENGLISH_NAMES, ships: ENGLISH_SHIP_NAMES, companies: ENGLISH_COMPANY_NAMES, locations: ENGLISH_LOCATION_NAMES,
  },
  French: {
    names: FRENCH_NAMES, ships: FRENCH_SHIP_NAMES, companies: FRENCH_COMPANY_NAMES, locations: FRENCH_LOCATION_NAMES,
  },
  Spanish: {
    names: SPANISH_NAMES, ships: SPANISH_SHIP_NAMES, companies: SPANISH_COMPANY_NAMES, locations: SPANISH_LOCATION_NAMES,
  },
  Dutch: {
    names: DUTCH_NAMES, ships: DUTCH_SHIP_NAMES, companies: DUTCH_COMPANY_NAMES, locations: DUTCH_LOCATION_NAMES,
  },
  Portuguese: {
    names: PORTUGUESE_NAMES, ships: PORTUGUESE_SHIP_NAMES, companies: PORTUGUESE_COMPANY_NAMES,
    locations: PORTUGUESE_LOCATION_NAMES,
  },
};

/** Whether `value` is one of the five supported nationalities. */
export function isNationality(value: unknown): value is Nationality {
  return typeof value === "string" && (NATIONALITIES as string[]).includes(value);
}

/** A random nationality drawn from `rng` (seeded for reproducibility). */
export function randomNationality(rng: NameRng): Nationality {
  return rng.choice(NATIONALITIES);
}
