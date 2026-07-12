/**
 * Nationality-based name generators for the editor: captain names, ship
 * names, company names in the style of the 16th-18th century chartered
 * merchant companies, and colonial-era location names.
 *
 * The pools and generation algorithms themselves now live in
 * @market-sim/shared (shared with the simulation engine's own name
 * generation, see src/sim/names.ts etc.) -- this module just adapts them to
 * the editor's calling convention: every shared generator takes an explicit
 * NameRng, so this file supplies a Math.random()-backed one (the editor has
 * no seeded-RNG reproducibility requirement, unlike the sim).
 */
import { NATIONALITY_POOLS, NATIONALITIES, DEFAULT_NATIONALITY, type Nationality } from "@market-sim/shared/nationality";
import { randomName, MALE_FIRST_NAME_FRACTION, type NameRng } from "@market-sim/shared/names";
import { randomShipName } from "@market-sim/shared/shipNames";
import { randomCompanyName } from "@market-sim/shared/companyNames";
import { randomLocationName } from "@market-sim/shared/locationNames";

export { NATIONALITIES, DEFAULT_NATIONALITY, MALE_FIRST_NAME_FRACTION };
export type { Nationality };

/** Every shared generator in this package takes an explicit NameRng -- this is the editor's non-reproducible Math.random()-backed one. */
const mathRandomRng: NameRng = {
  random: () => Math.random(),
  choice: <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)],
};

/** A "First Last" captain name for `nationality`; the first name is male MALE_FIRST_NAME_FRACTION (75%) of the time. */
export function generateCaptainName(nationality: Nationality): string {
  return randomName(mathRandomRng, NATIONALITY_POOLS[nationality].names);
}

/** A ship name for `nationality`. */
export function generateShipName(nationality: Nationality): string {
  return randomShipName(mathRandomRng, NATIONALITY_POOLS[nationality].ships);
}

/** A chartered-merchant-company name for `nationality`. */
export function generateCompanyName(nationality: Nationality): string {
  return randomCompanyName(mathRandomRng, NATIONALITY_POOLS[nationality].companies);
}

/** A colonial-era settlement/port name for `nationality`, unique against `existingNames` -- see @market-sim/shared/locationNames.ts's randomLocationName. */
export function generateLocationName(nationality: Nationality, existingNames: Iterable<string> = []): string {
  return randomLocationName(mathRandomRng, NATIONALITY_POOLS[nationality].locations, existingNames);
}
